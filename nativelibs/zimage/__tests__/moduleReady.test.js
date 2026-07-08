const path = require('path'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
assert.strictEqual(typeof addon.moduleReady, 'function', 'moduleReady exported');
assert.strictEqual(addon.moduleReady(), true, 'moduleReady() true');
console.log('OK moduleReady');
