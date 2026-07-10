const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spliceLinuxBranch } = require('../patch-file-utilities.js');

// Minimal stub mirroring the real getPlatformPath() default branch.
const stub = `
function getPlatformPath() {
  switch (platform) {
    case 'darwin':
      return join(__dirname, 'darwin', 'file-utilities.node');
    default:
      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`);
  }
}
`;
const tmp = path.join(os.tmpdir(), 'fu-index-' + process.pid + '.js');
fs.writeFileSync(tmp, stub);
spliceLinuxBranch(tmp);
const out = fs.readFileSync(tmp, 'utf8');
assert.ok(out.includes("case 'linux'"), 'linux case spliced');
assert.ok(out.includes("linux_x64', 'file-utilities.node'"), 'linux_x64 path present');
// idempotent
spliceLinuxBranch(tmp);
const out2 = fs.readFileSync(tmp, 'utf8');
assert.strictEqual((out2.match(/case 'linux'/g) || []).length, 1, 'splice is idempotent');
fs.unlinkSync(tmp);
console.log('OK patch-file-utilities: splice adds linux case, idempotent');
