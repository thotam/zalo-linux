const assert = require('assert');
const cp = require('child_process');
const path = require('path');

const MOD = path.join(__dirname, '..', 'data', 'call-diag.js');

// The module require()s 'electron', which is absent under plain node; it must fail open
// and still export its pure helpers when CALL_DIAG_TEST is set.
process.env.CALL_DIAG_TEST = '1';
const { formatLine, safeJson } = require(MOD);

// safeJson
assert.strictEqual(safeJson('hi'), 'hi', 'string passthrough');
assert.strictEqual(safeJson({ a: 1 }), '{"a":1}', 'object -> json');
const circular = {}; circular.self = circular;
assert.strictEqual(typeof safeJson(circular), 'string', 'circular -> String() fallback, no throw');

// formatLine
assert.strictEqual(
  formatLine('2026-01-01T00:00:00.000Z', 'main', 'DIAG-INIT', { log: '/x' }),
  '2026-01-01T00:00:00.000Z [main] DIAG-INIT {"log":"/x"}\n',
  'formatLine with payload');
assert.strictEqual(
  formatLine('2026-01-01T00:00:00.000Z', 'main', 'PING'),
  '2026-01-01T00:00:00.000Z [main] PING\n',
  'formatLine without payload');

// isCallHost matcher
const { isCallHost } = require(MOD);
assert.strictEqual(isCallHost('https://voicecall-wpa.zalo.me/voicecall/requestcall'), true, 'voicecall host');
assert.strictEqual(isCallHost('https://wpa.chat.zalo.me/api/x'), true, 'wpa.chat host');
assert.strictEqual(isCallHost('https://api.conf.talk.zing.vn/zls?action=call_config'), true, 'call_config path');
assert.strictEqual(isCallHost('https://zalo.me/index.html'), false, 'unrelated host');
assert.strictEqual(isCallHost(''), false, 'empty');

// The whole file must be valid JS.
cp.execFileSync(process.execPath, ['--check', MOD]);

console.log('OK call-diag');
