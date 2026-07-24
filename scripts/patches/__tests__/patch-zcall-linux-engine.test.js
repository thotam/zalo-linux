const assert = require('assert');
const { applyBindingPatch } = require('../patch-zcall-linux-engine.js');

// applyBindingPatch(src) is the pure string transform on binding.js — test it in isolation.
const STUB = "function getLib(){ if(process.platform==='win32'){return require('./zcall_x64.node');} else { return {MainApp:function(){return {}}}; } }\nmodule.exports = getLib();";
const out = applyBindingPatch(STUB);
assert.ok(out.includes("require('./engine.js')"), 'Linux branch requires engine.js');
assert.ok(out.includes('zcall_x64.node'), 'win branch preserved');
assert.ok(!out.includes('MainApp:function(){return {}}'), 'stub body removed');
assert.strictEqual(applyBindingPatch(out), out, 'idempotent');
assert.throws(() => applyBindingPatch('no getLib here'), /anchor/, 'fail-loud on missing anchor');

// The PRISTINE binding.js from the DMG has no 'MainApp' — the Linux else returns {error:'not support'}.
const ORIG = "function getLib(){\n    if(process.platform === 'win32'){\n        return require('./zcall_x64.node');\n    }else if(process.platform === 'darwin'){\n    	return require('./zcall_mac.node');\n    }else{\n        return {error: 'not support'};\n    }\n}\nmodule.exports = getLib();";
const o2 = applyBindingPatch(ORIG);
assert.ok(o2.includes("require('./engine.js')"), 'pristine: Linux branch -> engine.js');
assert.ok(!o2.includes("error: 'not support'"), 'pristine: stub error removed');
assert.ok(o2.includes('zcall_mac.node'), 'pristine: darwin kept');
assert.strictEqual(applyBindingPatch(o2), o2, 'pristine: idempotent');
console.log('OK patch-zcall-linux-engine');
