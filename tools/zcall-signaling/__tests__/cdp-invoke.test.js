const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'cdp-invoke.js');
const { buildInvokeExpr } = require(MOD);

// buildInvokeExpr: embeds the args, references requestCall + the webpack grab, is valid JS.
const expr = buildInvokeExpr({ calleeId: '6664457779001834719', callId: 24193035, type: 1 });
assert.ok(expr.includes('"6664457779001834719"'), 'calleeId embedded');
assert.ok(expr.includes('24193035'), 'callId embedded');
assert.ok(expr.includes('requestCall'), 'invokes requestCall');
assert.ok(expr.includes('webpackJsonp'), 'uses webpack grab');
// the expression must parse as valid JS (wrap so `await` is legal at parse time)
new Function('return ' + expr); // throws on syntax error

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK cdp-invoke');
