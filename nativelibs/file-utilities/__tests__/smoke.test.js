const assert = require('assert');
const addon = require('./load-addon');
assert.strictEqual(typeof addon.ping, 'function', 'ping export missing');
assert.strictEqual(addon.ping(), 'pong');
console.log('OK smoke: addon loads and ping() works');
