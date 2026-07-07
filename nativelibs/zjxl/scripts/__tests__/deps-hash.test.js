const cp = require('child_process');
const path = require('path');
const assert = require('assert');
const out = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert(/\.deps-prefix[/\\][0-9a-f]{12}$/.test(out), 'prefix path shape: ' + out);
// Deterministic: two runs yield the same hash.
const out2 = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert.strictEqual(out, out2, 'hash is deterministic');
console.log('OK deps-hash');
