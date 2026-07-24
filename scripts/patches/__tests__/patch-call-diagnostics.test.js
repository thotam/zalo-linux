const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcd-'));
const repo = path.join(tmp, 'repo');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.ensureDirSync(path.join(repo, 'scripts', 'patches', 'data'));

// Minimal main.js mirroring the two anchors the patch targets.
const MAIN =
  '__ZaBUNDLENAME__="main",__SCRIPT_TYPE__="main",function(e){' +
  'var w1={webPreferences:{devTools:!1,webSecurity:!0,partition:"persist:zalo"}};' +
  'var w2={webPreferences:{devTools:!1,webSecurity:!0,partition:"persist:zalo"}};' +
  '}();';
fs.writeFileSync(path.join(appMD, 'main.js'), MAIN, 'utf8');

// Copy the real data module + patch + logger so the patch runs against a real tree.
fs.copyFileSync(path.join(__dirname, '..', 'data', 'call-diag.js'), path.join(repo, 'scripts', 'patches', 'data', 'call-diag.js'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-call-diagnostics.js'), path.join(repo, 'scripts', 'patches', 'patch-call-diagnostics.js'));
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

const { main } = require(path.join(repo, 'scripts', 'patches', 'patch-call-diagnostics.js'));

(async () => {
  await main();
  const m = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');

  // webviewTag enabled on BOTH persist:zalo webPreferences.
  assert.strictEqual((m.match(/webviewTag:!0,partition:"persist:zalo"/g) || []).length, 2, 'webviewTag on both app windows');
  // require injected once, at the very front.
  assert(m.startsWith('require("./__call_diag.js");'), 'require prepended to main.js');
  // module copied.
  assert(fs.existsSync(path.join(appMD, '__call_diag.js')), '__call_diag.js copied');

  // Idempotent: a second run must not double-inject.
  await main();
  const m2 = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');
  assert.strictEqual(m, m2, 'idempotent');
  assert.strictEqual((m2.match(/require\("\.\/__call_diag\.js"\)/g) || []).length, 1, 'single require');

  // Fail-loud on anchor drift.
  fs.writeFileSync(path.join(appMD, 'main.js'), 'no anchors here', 'utf8');
  let threw = false;
  try { await main(); } catch (_) { threw = true; }
  assert(threw, 'throws when anchors missing');

  fs.removeSync(tmp);
  console.log('OK patch-call-diagnostics');
})().catch((e) => { console.error(e); process.exit(1); });
