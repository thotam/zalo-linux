const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'initzrtp.js');
const { buildProbe, buildRequest, parseResponse, SESSID_LEN } = require(MOD);

// --- buildProbe: 25-byte layout (§A.3) ---
const nonce = Buffer.from('deadbeef', 'hex');
const probe = buildProbe({ fromId: 0x11223344, callId: 0x0a, probeNonce: nonce });
assert.strictEqual(probe.length, 25, 'probe length');
assert.strictEqual(probe[0], 0x01, 'probe type');
assert.strictEqual(probe[1], 0x7e, 'probe flag');
assert.strictEqual(probe.subarray(2, 10).toString('hex'), '0000000000000000', 'probe reserved');
assert.strictEqual(probe.readUInt32LE(10), 0x11223344, 'probe fromId LE');
assert.strictEqual(probe.subarray(14, 18).toString('hex'), 'deadbeef', 'probe nonce');
assert.strictEqual(probe[18], 0x03, 'probe subtype');
assert.strictEqual(probe[19], 0x00, 'probe pad19');
assert.strictEqual(probe[20], 0x00, 'probe pad20');
assert.strictEqual(probe.readUInt32LE(21), 0x0a, 'probe callId LE');

// --- buildRequest: 185-byte layout (§A.1) ---
const sessId = 'A'.repeat(SESSID_LEN);
const req = buildRequest({ fromId: 0x11223344, toId: 0x55667788, callId: 0x0a, sessId });
assert.strictEqual(req.length, 185, 'request length');
assert.strictEqual(req[0], 0x01, 'req type');
assert.strictEqual(req[1], 0x7e, 'req flag');
assert.strictEqual(req.readUInt32LE(10), 0x11223344, 'req fromId LE');
assert.strictEqual(req[18], 0x0b, 'req subtype = 0x0b (caller, default)');
// Role-encoded subtype (RE'd from ZaloCall.exe): caller 0x0b, callee 0x0c. Relay rejects a callee
// that sends 0x0b (25-byte -106 error, no flowToken).
const reqCallee = buildRequest({ fromId: 0x11223344, toId: 0x55667788, callId: 0x0a, sessId, isCallee: true });
assert.strictEqual(reqCallee[18], 0x0c, 'callee req subtype = 0x0c');
assert.strictEqual(req[19], 0x00, 'req has-sessId hi');
assert.strictEqual(req[20], 0x02, 'req has-sessId lo');
assert.strictEqual(req.readUInt32LE(21), 0x0a, 'req callId LE');
assert.strictEqual(req.readUInt32LE(25), 0x55667788, 'req toId LE');
assert.strictEqual(req.readUInt16LE(29), 154, 'req sessId len LE');
assert.strictEqual(req.subarray(29, 31).toString('hex'), '9a00', 'req sessId len bytes');
assert.strictEqual(req.subarray(31).toString('ascii'), sessId, 'req sessId ascii');

// variable-length sessId (observed 152 as well as 154): length field + total track the real length.
const sess152 = 'B'.repeat(152);
const req152 = buildRequest({ fromId: 0x11223344, toId: 0x55667788, callId: 0x0a, sessId: sess152 });
assert.strictEqual(req152.length, 183, '31 + 152 = 183');
assert.strictEqual(req152.readUInt16LE(29), 152, 'sessId len field = 152');
assert.strictEqual(req152.subarray(31).toString('ascii'), sess152, 'req152 sessId ascii');

// bad sessId length -> throw
assert.throws(() => buildRequest({ fromId: 1, toId: 2, callId: 3, sessId: 'short' }), /30/, 'req rejects short sessId');

// --- parseResponse: synthetic §A.2 buffer (real layout: nonce@25, flowToken@29 — 2026-07-14) ---
// Real relays put a PER-CALL nonce at offset 25 and a relay-assigned PER-RELAY flowToken at
// offset 29 (confirmed by capture: media[1..4] == resp[29..33] byte-for-byte). Distinct values
// here so a swapped/mislabelled read is caught.
const addr = '1.2.3.4|5678';
const respNonce = Buffer.from('11111111', 'hex');     // per-call nonce @25
const flowToken = Buffer.from('ac95915d', 'hex');     // per-relay flowToken @29 (goes into media[1..4])
const resp = Buffer.alloc(35 + addr.length);
resp[0] = 0x02; resp[1] = 0x7e;
resp.writeUInt32LE(0x11223344, 10);      // fromId echo (= media SSRC)
resp[18] = 0x0b; resp[19] = 0x00; resp[20] = 0x02;
respNonce.copy(resp, 25);                 // per-call nonce
flowToken.copy(resp, 29);                 // per-relay flowToken
resp.writeUInt16LE(addr.length, 33);
resp.write(addr, 35, 'ascii');
const parsed = parseResponse(resp);
assert.strictEqual(parsed.type, 0x02, 'resp type');
assert.strictEqual(parsed.fromId, 0x11223344, 'resp fromId');
assert.strictEqual(parsed.nonce.toString('hex'), '11111111', 'resp per-call nonce @25');
assert.strictEqual(parsed.flowToken.toString('hex'), 'ac95915d', 'resp per-relay flowToken @29');
assert.deepStrictEqual(parsed.relayAddr, { ip: '1.2.3.4', port: '5678' }, 'resp relayAddr');

// wrong type -> throw
const notResp = Buffer.alloc(40); notResp[0] = 0x01;
assert.throws(() => parseResponse(notResp), /RESPONSE/, 'parseResponse rejects non-0x02');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK initzrtp');
