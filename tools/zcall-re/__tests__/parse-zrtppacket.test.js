'use strict';
const assert = require('assert');
const { parseZrtpPacket } = require('../parse-zrtppacket.js');

// REAL ZRTPPacket REQUEST captured on loopback (Task 5/6 CI capture, 11x
// identical retransmits of zcall's ZRTP init REQUEST). Config that produced
// it: fromId=111 (0x6f), toId=222 (0xde), callId=10 (0x0a), protocol=3,
// sessId="SP1CAPTURE". Also saved (gitignored) at
// scratch/zcall-analysis/zrtppacket-request-real.hex -- embedded literally
// here so the test does not depend on that file at runtime.
const HEX = '010100000000000000006f000000000000000b00010a000000de0000000a0053503143415054555245';
const buf = Buffer.from(HEX, 'hex');

const p = parseZrtpPacket(buf);

assert.strictEqual(p.rawLen, 41, 'rawLen is 41 bytes');
assert.strictEqual(p.type, 0x01, 'packet type is 0x01 (ZRTP_REQUEST)');
assert.strictEqual(p.fromId, 111, 'fromId decodes to 111 as u32 big-endian @ offset 7');
assert.strictEqual(p.toId, 222, 'toId decodes to 222 as u32 big-endian @ offset 22');
assert.strictEqual(p.callId, 10, 'callId decodes to 10 as u32 big-endian @ offset 26');
assert.strictEqual(p.sessId, 'SP1CAPTURE', 'sessId decodes to the ASCII trailer');

console.log('OK parse-zrtppacket', JSON.stringify(p, (k, v) =>
  Buffer.isBuffer(v) ? v.toString('hex') : v));
