const fs = require('fs-extra'), path = require('path'), os = require('os'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zimg-'));
const idx = path.join(tmp, 'index.js');
// Minimal replica of the real getOS()/getLib() dispatch we splice into: getOS()
// assigns a module-scoped `os` var (no return), getLib() later does
// require(`${__dirname}/${os}/zimage.node`).
fs.writeFileSync(idx,
  "let os = null;\n" +
  "function getOS() {\n" +
  "  if (process.platform === 'win32') {\n" +
  "    os = 'ia32';\n" +
  "  } else if (process.platform === 'darwin') {\n" +
  "    if (process.arch === 'arm64') {\n" +
  "      os = 'darwin_arm64';\n" +
  "    } else {\n" +
  "      os = 'darwin_x64';\n" +
  "    }\n" +
  "  }\n" +
  "}\n" +
  "function getLib() {\n" +
  "  getOS();\n" +
  "  if (!os) { return { error: 'NOT_SUPPORT' }; }\n" +
  "  const zimage = require(`${__dirname}/${os}/zimage.node`);\n" +
  "  return zimage;\n" +
  "}\n" +
  "module.exports = getLib;\n");
const { spliceLinuxBranch } = require('../patch-zimage.js');
spliceLinuxBranch(idx);
let c = fs.readFileSync(idx, 'utf8');
assert(c.includes("process.platform === 'linux'"), 'linux branch inserted');
assert(c.includes("os = 'linux_x64'"), 'linux_x64 assignment inserted');
spliceLinuxBranch(idx);            // idempotent
assert.strictEqual(fs.readFileSync(idx, 'utf8'), c, 'second splice is a no-op');

// Fail-loud: anchor missing (bundle format changed) must throw.
const idx2 = path.join(tmp, 'index2.js');
fs.writeFileSync(idx2, "function getOS() {}\nmodule.exports = getOS;\n");
assert.throws(() => spliceLinuxBranch(idx2), /darwin.*anchor/i, 'throws when anchor missing');

fs.removeSync(tmp);
console.log('OK patch-zimage splice');
