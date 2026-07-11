'use strict';
// Functional test for the reconstructed zwalker addon. Exercises the full GC lifecycle
// (scan -> mark -> stat -> delete-homeless -> delete-empty) on a throwaway fixture and
// asserts the JS-facing contract the renderer relies on. Runs REAL deletion (the mac
// default), so it only ever touches its own temp fixture.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ADDON = process.env.ZWALKER_NODE || path.join(__dirname, '..', 'target', 'release', 'libzwalker.so');
const z = require(ADDON);

function mkfixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zwalker-'));
  fs.mkdirSync(path.join(root, 'Cache'), { recursive: true });
  fs.mkdirSync(path.join(root, 'zcloud'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty', 'nested'), { recursive: true });
  const w = (rel, bytes) => fs.writeFileSync(path.join(root, rel), Buffer.alloc(bytes, 1));
  w(path.join('Cache', 'a.jpg'), 100);
  w(path.join('Cache', 'b.jpg'), 200);
  w(path.join('zcloud', 'c.mp4'), 400);
  w('loose.dat', 50);
  return root;
}

function run() {
  const root = mkfixture();
  const trackingGlobs = [
    path.join(root, 'Cache', '**'),
    path.join(root, 'zcloud', '**'),
    '**',
  ];
  const ignoreGlobs = [];

  // 1. scanDirectory: 4 files, 750 bytes total.
  const scan = z.scanDirectory(root, trackingGlobs);
  assert.strictEqual(scan.fileNumber, 4, 'scan fileNumber');
  assert.strictEqual(Number(scan.size), 750, 'scan total size');
  const st = JSON.parse(scan.trackingPath);
  assert.strictEqual(st[trackingGlobs[0]].file_number, 2, 'Cache tracked file_number');
  assert.strictEqual(st[trackingGlobs[0]].size, 300, 'Cache tracked size');
  assert.strictEqual(st[trackingGlobs[1]].size, 400, 'zcloud tracked size');
  assert.strictEqual(st[trackingGlobs[2]].file_number, 4, '** tracks all');

  // 2. updateReferenceMessageId: mark the two Cache files as referenced.
  const upd = z.updateReferenceMessageId(root, [
    { filePath: path.join(root, 'Cache', 'a.jpg'), id: 'msg1' },
    { filePath: path.join(root, 'Cache', 'b.jpg'), id: 'msg2' },
    { filePath: path.join(root, 'does', 'not', 'exist'), id: 'msgX' }, // ignored
  ]);
  assert.strictEqual(upd.fileNumber, 2, 'updateCount = matched files only');

  // 3. statUnmarkedFiles: 2 homeless remain (zcloud/c.mp4 + loose.dat = 450 bytes).
  const stat = z.statUnmarkedFiles(root, ignoreGlobs, trackingGlobs, [259200, 604800, 1209600]);
  assert.strictEqual(stat.fileNumber, 2, 'unmarked count');
  assert.strictEqual(Number(stat.size), 450, 'unmarked size');
  const at = JSON.parse(stat.trackingATime);
  assert.ok(Array.isArray(at[trackingGlobs[2]]), 'trackingATime is per-glob bucket array');
  assert.strictEqual(at[trackingGlobs[2]].length, 4, '3 thresholds -> 4 buckets');
  // Fresh files -> youngest bucket (index 0).
  assert.strictEqual(at[trackingGlobs[2]][0].file_number, 2, 'both unmarked in youngest bucket');

  // ignore glob protects a homeless file from being counted.
  const statIgnored = z.statUnmarkedFiles(root, [path.join(root, 'zcloud', '**')], trackingGlobs, [259200]);
  assert.strictEqual(statIgnored.fileNumber, 1, 'ignore glob excludes zcloud homeless');
  assert.strictEqual(Number(statIgnored.size), 50, 'only loose.dat remains unmarked');

  // 4. deleteHomelessFiles ALWAYS deletes homeless when called (the 4th arg is
  //    deleteStatCache, not a delete switch) — pass false to prove it still deletes.
  const del = z.deleteHomelessFiles(root, ignoreGlobs, trackingGlobs, false);
  assert.strictEqual(del.fileNumber, 2, 'deleted 2 homeless even with deleteStatCache=false');
  assert.strictEqual(Number(del.size), 450, 'deleted size');
  assert.strictEqual(del.failedFileNumber, 0, 'no failures');
  assert.strictEqual(fs.existsSync(path.join(root, 'zcloud', 'c.mp4')), false, 'homeless mp4 gone');
  assert.strictEqual(fs.existsSync(path.join(root, 'loose.dat')), false, 'loose homeless gone');
  assert.strictEqual(fs.existsSync(path.join(root, 'Cache', 'a.jpg')), true, 'marked file survives');
  assert.strictEqual(fs.existsSync(path.join(root, 'Cache', 'b.jpg')), true, 'marked file survives');

  // 5. deleteEmptyFolders: empty/ (+ empty/nested) and now-empty zcloud/ removed.
  const emp = z.deleteEmptyFolders(root);
  assert.ok(emp.deletedCount >= 2, `removed empty dirs (got ${emp.deletedCount}: ${emp.deletedDirs})`);
  assert.strictEqual(fs.existsSync(path.join(root, 'empty', 'nested')), false, 'nested empty removed');
  assert.strictEqual(fs.existsSync(path.join(root, 'empty')), false, 'empty removed');
  assert.strictEqual(fs.existsSync(path.join(root, 'zcloud')), false, 'emptied zcloud removed');
  assert.strictEqual(fs.existsSync(path.join(root, 'Cache')), true, 'non-empty Cache kept');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('OK  zwalker full-lifecycle test passed');
}

run();
