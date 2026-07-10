const assert = require('assert');
const addon = require('./load-addon');
assert.strictEqual(typeof addon.cancelJob, 'function', 'cancelJob export missing');
// cancelJob on an unknown id must be a no-op (no throw).
addon.cancelJob(999999);
console.log('OK cancel: cancelJob export present and safe on unknown id');
