const assert = require('assert');
const { applyMainPatch } = require('../patch-zcall-main-engine.js');

const SRC = 'var x=1;(function(){e&&e.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:W(),S(t)})).on("call-init",((e,t)=>{t&&t._optional&&delete t._optional,D=t}))})();';
const out = applyMainPatch(SRC);
assert.ok(out.startsWith('globalThis.__zengRequire=require;'), 'require captured at top');
assert.ok(out.includes('__zeng.handleSendToNative(t)'), 'handler routes to engine');
assert.ok(out.includes('call-send-signal'), 'emit path present');
assert.ok(!out.includes(':W(),S(t)})).on("call-init"'), 'dead child handler replaced');
assert.ok(out.includes('call-init'), 'call-init handler preserved');
assert.strictEqual(applyMainPatch(out), out, 'idempotent');
assert.throws(() => applyMainPatch('no anchor here'), /anchor/, 'fail-loud');
assert.ok(out.includes('createCallUI'), 'engine created with a call UI controller');
assert.ok(out.includes('zcall-ui'), 'references zcall-ui dir');
assert.ok(out.includes('call.html'), 'passes the call.html path');
assert.ok(out.includes('devices.html'), 'passes the device-window path');
console.log('OK patch-zcall-main-engine');
