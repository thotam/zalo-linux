const fs = require('fs-extra'), path = require('path'), os = require('os'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zjxl-'));
const idx = path.join(tmp, 'index.js');
// Minimal replica of the real getLib() branch we splice into.
fs.writeFileSync(idx,
  "function getLib(){let nodeAddon=null;\n" +
  "  if(process.platform==='win32'){nodeAddon=require('./build/win32_ia32/jxl.node');}\n" +
  "  else if(process.platform==='darwin'){nodeAddon=require('./build/darwin_x64/jxl.node');}\n" +
  "  else {\n    return { error: 'not support' };\n  }\n return {};}\nmodule.exports=getLib();");
const { spliceLinuxBranch } = require('../patch-zjxl.js');
spliceLinuxBranch(idx);
let c = fs.readFileSync(idx, 'utf8');
assert(c.includes("process.platform === 'linux'"), 'linux branch inserted');
assert(c.includes("require('./build/linux_x64/jxl.node')"), 'linux require inserted');
spliceLinuxBranch(idx);            // idempotent
assert.strictEqual(fs.readFileSync(idx, 'utf8'), c, 'second splice is a no-op');

// Fail-loud: anchor missing (bundle format changed) must throw.
const idx2 = path.join(tmp, 'index2.js');
fs.writeFileSync(idx2, "function getLib(){ return {}; }\nmodule.exports=getLib();");
assert.throws(() => spliceLinuxBranch(idx2), /not support.*anchor/i, 'throws when anchor missing');

fs.removeSync(tmp);
console.log('OK patch-zjxl splice');
