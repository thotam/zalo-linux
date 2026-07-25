// tools/zcall-ui/__tests__/call-format.test.js
const assert = require('assert');
const { statusText, formatDuration, timerClass } = require('../call-format.js');
assert.strictEqual(formatDuration(75), '01:15', 'duration mm:ss');
assert.ok(statusText('ringing','An').includes('đổ chuông'), 'ringing label');
assert.ok(statusText('connecting','An').includes('kết nối'), 'connecting label');
assert.ok(statusText('calling','An').includes('An'), 'calling shows name');
assert.strictEqual(statusText('connected','An'), '', 'connected empty (timer shown)');
assert.strictEqual(timerClass('connected',{secure:true}), 'timer-secure', 'secure timer');
assert.strictEqual(timerClass('connected',{quality:'poor'}), 'timer-warn', 'poor timer');
assert.strictEqual(timerClass('connected',{}), 'timer-normal', 'normal timer');
console.log('OK call-format');
