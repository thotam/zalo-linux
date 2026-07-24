const assert = require('assert');
const CF = require('../call-format.js');

assert.strictEqual(CF.formatDuration(0), '00:00');
assert.strictEqual(CF.formatDuration(9), '00:09');
assert.strictEqual(CF.formatDuration(75), '01:15');
assert.strictEqual(CF.formatDuration(3600), '60:00');
assert.strictEqual(CF.formatDuration(-5), '00:00');
assert.strictEqual(CF.formatDuration(9.8), '00:09');

assert.strictEqual(CF.statusText('calling', 'Tâm Tho'), 'Đang nối máy đến Tâm Tho');
assert.strictEqual(CF.statusText('connected', 'Tâm Tho'), '');
assert.ok(CF.statusText('ended', 'Tâm Tho').includes('đã kết thúc cuộc gọi'));
assert.strictEqual(CF.statusText('free', 'Tâm Tho'), '');

console.log('OK call-format');
