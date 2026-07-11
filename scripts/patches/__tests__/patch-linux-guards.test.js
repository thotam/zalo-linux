const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

// patch-linux-guards is now codesign-only: it inserts the Linux short-circuit into
// main.js's checkAppSigned(). (zwalker/mp4thumb loaders own their own Linux load via
// patch-zwalker / patch-mp4thumb and are no longer touched here.)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zlg-'));
const repo = path.join(tmp, 'repo');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
const scriptsPatches = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(scriptsPatches);

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

  // Idempotent second run must not throw or double-insert.
  await main();
  const m2 = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');
  assert.strictEqual(m, m2, 'idempotent second run');
  assert.strictEqual((m2.match(/process\.platform==='linux'/g) || []).length, 1, 'single insertion');

  fs.removeSync(tmp);
  console.log('OK patch-linux-guards');
})().catch((e) => { console.error(e); process.exit(1); });
