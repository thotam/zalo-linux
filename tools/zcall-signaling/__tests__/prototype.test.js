const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'prototype.js');
const { summarize, latestCalleeId } = require(MOD);

// latestCalleeId: extract the most recent makeCall callee id from a diag log
const log = [
  '2026x [browser] CONSOLE {"message":"[CALLDIAG-PAYLOAD] sendToNative {\\"command\\":\\"makeCall\\",\\"data\\":{\\"partner\\":[{\\"id\\":\\"111\\"}]}}"}',
  '2026x [browser] CONSOLE {"message":"[CALLDIAG-PAYLOAD] sendToNative {\\"command\\":\\"makeCall\\",\\"data\\":{\\"partner\\":[{\\"id\\":\\"6664457779001834719\\"}]}}"}',
].join('\n');
assert.strictEqual(latestCalleeId(log), '6664457779001834719', 'latest callee id');
assert.strictEqual(latestCalleeId('nothing here'), null, 'no callee -> null');

const cfg = { sessId: 'S'.repeat(154), servers: [{ rtpaddr: '1.2.3.4:4200' }], changeZRTP: { enable: 0 }, fromId: 1, toId: 2 };
const out = summarize(cfg, Buffer.alloc(30, 9));
assert.strictEqual(out.sessIdLen, 154, 'sessId length only');
assert.strictEqual(out.keyLen, 30, 'key length only');
assert.deepStrictEqual(out.servers, ['1.2.3.4:4200'], 'server addrs');
assert.strictEqual(out.changeZRTP.enable, 0, 'changeZRTP passed');
// never leaks raw secrets
assert.ok(!JSON.stringify(out).includes('S'.repeat(154)), 'no raw sessId');
assert.ok(!JSON.stringify(out).includes('09090909'), 'no raw key bytes');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK prototype');
