const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { patchMainJs } = require('../patch-relaunch-reveal.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlr-'));

// Stub of the second-instance handler's win32 hidden branch tail `}),100)}`
// followed by the non-win32 `else r.show();` reveal anchor.
function stub(mgr) {
  return (
    'bn.on("second-instance",((e,t,n)=>{if(!' + mgr + ')return;let r=' + mgr +
    '.getMainWindow();if(r){if("win32"===process.platform)if(r.isVisible())r.focus();' +
    'else{r.setOpacity(0),r.show();setTimeout((()=>{r.setOpacity(1)}),100)}else r.show();' +
    mgr + '.receiveArguments(t)}else ' + mgr + '.receiveArguments(t)}));'
  );
}

for (const mgr of ['An', 'W']) {
  const f = path.join(tmp, `main-${mgr}.js`);
  fs.writeFileSync(f, stub(mgr));

  assert.strictEqual(patchMainJs(f), 'patched', `${mgr}: should patch`);
  const c = fs.readFileSync(f, 'utf8');
  assert(c.includes('}),100)}else{r.show();r.focus();"linux"===process.platform&&setTimeout'),
    `${mgr}: reveal maximize-toggle spliced`);
  assert(c.includes('r.isMaximized()){r.unmaximize();r.maximize();r.focus()}'), `${mgr}: toggle body present`);
  assert(!c.includes('}),100)}else r.show();'), `${mgr}: original reveal replaced`);
  assert(c.includes(mgr + '.receiveArguments(t)'), `${mgr}: receiveArguments preserved`);
  // no single-instance lock is added (app has its own socket mechanism)
  assert(!c.includes('requestSingleInstanceLock'), `${mgr}: no lock injected`);

  // idempotent
  assert.strictEqual(patchMainJs(f), 'already', `${mgr}: second run is a no-op`);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), c, `${mgr}: no double injection`);
}

// fail-loud when the reveal branch is gone
const drift = path.join(tmp, 'drift.js');
fs.writeFileSync(drift, 'bn.on("second-instance",((e,t,n)=>{}));');
assert.throws(() => patchMainJs(drift), /reveal branch not found/, 'drift should throw');

fs.removeSync(tmp);
console.log('OK patch-relaunch-reveal');
