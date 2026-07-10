const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const cp = require('child_process');

// Self-contained loader stubs reproducing the exact anchors patch-linux-guards
// targets (no dependency on a checked-out extraction). zwalker throws at load via
// the final `if (!nativeBinding)` block; mp4thumb's `let thumbModule = null; try {`
// is where the Linux short-circuit is spliced.
const ZWALKER_STUB = [
  'let nativeBinding = null',
  'let loadError = null',
  'if (!nativeBinding) {',
  '  if (loadError) {',
  '    throw loadError',
  '  }',
  '  throw new Error(`Failed to load native binding`)',
  '}',
  'module.exports = nativeBinding',
  '',
].join('\n');
const MP4THUMB_STUB = [
  'function load() {',
  '    let thumbModule = null;',
  '    try {',
  "        thumbModule = require('./mp4thumb.node');",
  '    } catch (e) {',
  '        thumbModule = { getThumbnail: function () { return null; } };',
  '    }',
  '    return thumbModule;',
  '}',
  'module.exports = load();',
  '',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zlg-'));
const repo = path.join(tmp, 'repo');
const appNL = path.join(repo, 'app', 'native', 'nativelibs');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(path.join(appNL, 'zwalker'));
fs.ensureDirSync(path.join(appNL, 'mp4thumb'));
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
const scriptsPatches = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(scriptsPatches);

// Write loader stubs + a minimal main.js containing the checkAppSigned anchor.
fs.writeFileSync(path.join(appNL, 'zwalker', 'index.js'), ZWALKER_STUB, 'utf8');
fs.writeFileSync(path.join(appNL, 'mp4thumb', 'index.js'), MP4THUMB_STUB, 'utf8');
fs.writeFileSync(path.join(appMD, 'main.js'),
  'class C{async checkAppSigned(){return null!=this.isAppSigned?this.isAppSigned:!1}}\nmodule.exports=C;', 'utf8');

fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-linux-guards.js'), path.join(scriptsPatches, 'patch-linux-guards.js'));
// The copied patch file does require('fs-extra'); give it a node_modules to resolve against.
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

const { main } = require(path.join(scriptsPatches, 'patch-linux-guards.js'));

(async () => {
  await main();

  // main.js: Linux short-circuit inserted.
  const m = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');
  assert(m.includes("async checkAppSigned(){if(process.platform==='linux')return this.isAppSigned=!1,!1;"), 'checkAppSigned guarded');

  // Each guarded loader must require() without throwing on Linux (run in a child so
  // a stray throw fails the child, not this process).
  for (const mod of ['zwalker', 'mp4thumb']) {
    const p = path.join(appNL, mod, 'index.js');
    const r = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(p)});console.log('ok')`], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${mod} require threw: ${r.stderr}`);
    assert(r.stdout.includes('ok'), `${mod} require did not complete`);
  }

  // zwalker stub exports the 5 functions.
  const zw = require(path.join(appNL, 'zwalker', 'index.js'));
  for (const fn of ['scanDirectory', 'updateReferenceMessageId', 'deleteHomelessFiles', 'statUnmarkedFiles', 'deleteEmptyFolders']) {
    assert.strictEqual(typeof zw[fn], 'function', `zwalker.${fn} present`);
  }

  // Idempotent second run must not throw.
  await main();

  fs.removeSync(tmp);
  console.log('OK patch-linux-guards');
})().catch((e) => { console.error(e); process.exit(1); });
