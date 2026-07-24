const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'classify-keying.js');
const { collectKeyingSignals, classifyKeying } = require(MOD);

assert.deepStrictEqual(
  collectKeyingSignals({ srtpKey: 'x'.repeat(20), callId: 1 }).sort(),
  ['srtp-key-material'], 'key material signal');
assert.ok(collectKeyingSignals({ zrtc_config: { a: 1 } }).indexOf('zrtc-config') >= 0, 'zrtc-config signal');
assert.ok(collectKeyingSignals({ nonce: 'abc' }).indexOf('kdf-nonce') >= 0, 'nonce signal');
assert.deepStrictEqual(collectKeyingSignals({ sessId: 'abc' }), ['session-token-only'], 'session only');

assert.strictEqual(classifyKeying([{ obj: { srtpKey: 'x'.repeat(20) } }]).klass, 'a', 'key material -> a');
assert.strictEqual(classifyKeying([{ obj: { zrtc_config: { k: 1 } } }]).klass, 'd', 'zrtc_config alone -> d (codec tuning, NOT key material; SP2.1)');
assert.strictEqual(classifyKeying([{ obj: { nonce: 'abc' } }]).klass, 'b', 'nonce -> b');
assert.strictEqual(classifyKeying([{ obj: { sessId: 'abc' } }]).klass, 'd', 'session-only -> d');
assert.strictEqual(classifyKeying([]).klass, 'd', 'empty -> d');

const { classifyFromJson } = require(MOD);
assert.strictEqual(classifyFromJson([{ srtpKey: 'x'.repeat(20) }]).klass, 'a', 'json key material -> a');
assert.strictEqual(classifyFromJson([{ nonce: 'abc' }]).klass, 'b', 'json nonce -> b');
assert.strictEqual(classifyFromJson([{ sessId: 'abc' }]).klass, 'd', 'json session-only -> d');
assert.strictEqual(classifyFromJson([]).klass, 'd', 'json empty -> d');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK classify-keying');
