const cp = require('child_process'), path = require('path'), assert = require('assert');
const out = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert(/\.deps-prefix[/\\][0-9a-f]{12}$/.test(out), 'prefix path shape: ' + out);
assert.strictEqual(out, cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim(), 'deterministic');
console.log('OK deps-hash');
