const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'capture-utils.js');
const { parsePayloadLines, redactSecrets } = require(MOD);

// parsePayloadLines: pulls tag + parsed JSON out of diag CONSOLE lines.
const log = [
  '2026-01-01T00:00:00.000Z [browser] CONSOLE {"type":"window","level":3,"message":"[CALLDIAG-PAYLOAD] sendToNative {\\"sessId\\":\\"abc\\",\\"servers\\":[1]}","line":1,"source":"x"}',
  '2026-01-01T00:00:01.000Z [browser] CONSOLE {"type":"window","level":3,"message":"[CALLDIAG-PAYLOAD] callMainInit not-json","line":1,"source":"x"}',
  'unrelated line',
].join('\n');
const parsed = parsePayloadLines(log);
assert.strictEqual(parsed.length, 2, 'two payload lines');
assert.strictEqual(parsed[0].tag, 'sendToNative');
assert.deepStrictEqual(parsed[0].obj, { sessId: 'abc', servers: [1] });
assert.strictEqual(parsed[1].tag, 'callMainInit');
assert.strictEqual(parsed[1].obj, null, 'unparseable payload -> null');

// redactSecrets: masks sensitive keys + long base64-ish strings, keeps structure.
const red = redactSecrets({ sessId: 'abc', callId: 10, nested: { token: 'xyz', keep: 'ok' }, blob: 'A'.repeat(40) });
assert.strictEqual(red.callId, 10, 'non-secret kept');
assert.strictEqual(red.nested.keep, 'ok', 'non-secret nested kept');
assert.ok(/^<redacted:/.test(red.sessId), 'sessId redacted');
assert.ok(/^<redacted:/.test(red.nested.token), 'token redacted');
assert.ok(/^<redacted:base64:/.test(red.blob), 'long base64-ish redacted');
// input not mutated
assert.strictEqual(typeof redactSecrets, 'function');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK capture-utils');
