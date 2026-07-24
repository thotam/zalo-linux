const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'cdp-invoke.js');
const { buildInvokeExpr, buildVoiceCallExpr } = require(MOD);

// buildInvokeExpr: embeds the args, references requestCall + the webpack grab, is valid JS.
const expr = buildInvokeExpr({ calleeId: '6664457779001834719', callId: 24193035, type: 1 });
assert.ok(expr.includes('"6664457779001834719"'), 'calleeId embedded');
assert.ok(expr.includes('24193035'), 'callId embedded');
assert.ok(expr.includes('requestCall'), 'invokes requestCall');
assert.ok(expr.includes('webpackJsonp'), 'uses webpack grab');
new Function('return ' + expr);

// buildVoiceCallExpr: generic method + JSON args, embeds method name, valid JS.
const e2 = buildVoiceCallExpr({ method: 'sendRequestCall', args: ['222', 'rtcp', 'rtp', '[]', '', 'sess', 5] });
assert.ok(e2.includes('"sendRequestCall"'), 'method embedded');
assert.ok(e2.includes('"222"'), 'first arg embedded');
assert.ok(e2.includes('"sess"'), 'session arg embedded');
assert.ok(e2.includes('webpackJsonp'), 'uses webpack grab');
assert.ok(e2.includes('.apply('), 'applies args array');
new Function('return ' + e2);

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK cdp-invoke');
