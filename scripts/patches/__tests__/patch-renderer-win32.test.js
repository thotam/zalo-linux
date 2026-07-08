const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Point the patch at a temp "app/pc-dist" by faking the repo root two levels up.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zrw-'));
const repo = path.join(tmp, 'repo');
const pcDist = path.join(repo, 'app', 'pc-dist', 'lazy');
fs.ensureDirSync(pcDist);
// scripts/patches/patch-renderer-win32.js resolves PC_DIST as ../../app/pc-dist
const patchDir = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(patchDir);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-renderer-win32.js'), path.join(patchDir, 'patch-renderer-win32.js'));
// The copied patch file does require('fs-extra'); give it a node_modules to resolve against.
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

// A few occurrences of each prefixed literal (the patch replaces ALL of them);
// the cosmetic "DARWIN" uses must stay untouched.
const sample = 'a({platform:"DARWIN",v:1});b({platform:"DARWIN",v:2});' +
  'getClientType(){return 23}'.repeat(8) +
  '"DARWIN".toLowerCase();OS:{DARWIN:"DARWIN"}';
const file = path.join(pcDist, 'main-startup.abcdef.js');
fs.writeFileSync(file, sample, 'utf8');

const { main } = require(path.join(patchDir, 'patch-renderer-win32.js'));

(async () => {
  await main();
  let out = fs.readFileSync(file, 'utf8');
  assert(out.includes('platform:"WIN32"'), 'platform prop replaced');
  assert(!out.includes('platform:"DARWIN"'), 'no platform:"DARWIN" left');
  assert.strictEqual(out.split('getClientType(){return 24}').length - 1, 8, 'all getClientType replaced');
  assert(!out.includes('getClientType(){return 23}'), 'no return 23 left');
  // Cosmetic DARWIN untouched:
  assert(out.includes('"DARWIN".toLowerCase()'), 'cosmetic className untouched');
  assert(out.includes('OS:{DARWIN:"DARWIN"}'), 'const map untouched');
  // Idempotent second run must not throw and must not double-change:
  await main();
  const out2 = fs.readFileSync(file, 'utf8');
  assert.strictEqual(out, out2, 'idempotent');
  // Fail-loud when anchors absent:
  fs.writeFileSync(file, 'nothing to see here', 'utf8');
  let threw = false;
  try { await main(); } catch (_) { threw = true; }
  assert(threw, 'fail-loud when anchors gone');
  fs.removeSync(tmp);
  console.log('OK patch-renderer-win32');
})().catch((e) => { console.error(e); process.exit(1); });
