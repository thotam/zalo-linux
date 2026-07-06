const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const cp = require('child_process');

const REF = '/tmp/claude-1000/-mnt-data-Work-zalo-linux/4b920b94-ed2d-4cc3-95bc-d6ce8bb9f3bd/scratchpad/asar-src';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zlg-'));
const repo = path.join(tmp, 'repo');
const appNL = path.join(repo, 'app', 'native', 'nativelibs');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(path.join(appNL, 'zwalker'));
fs.ensureDirSync(path.join(appNL, 'mp4thumb'));
fs.ensureDirSync(path.join(appNL, 'v8-profiles'));
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
const scriptsPatches = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(scriptsPatches);

// Copy real loader sources + a minimal main.js containing the checkAppSigned anchor.
fs.copyFileSync(path.join(REF, 'native/nativelibs/zwalker/index.js'), path.join(appNL, 'zwalker', 'index.js'));
fs.copyFileSync(path.join(REF, 'native/nativelibs/mp4thumb/index.js'), path.join(appNL, 'mp4thumb', 'index.js'));
fs.copyFileSync(path.join(REF, 'native/nativelibs/v8-profiles/index.js'), path.join(appNL, 'v8-profiles', 'index.js'));
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
  for (const mod of ['zwalker', 'mp4thumb', 'v8-profiles']) {
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
