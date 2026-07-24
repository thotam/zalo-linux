const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const RTP = path.join(__dirname, '..', 'rtp.js');
const FRAME = path.join(__dirname, '..', 'media-frame.js');
const { buildRtpPacket, parseRtpPacket } = require(RTP);
const { wrapZrtc, unwrapZrtc } = require(FRAME);

// buildRtpPacket with 0xBEDE extension -> 20-byte header (§B), payload appended.
const payload = Buffer.from('opus-frame');
const pkt = buildRtpPacket({ pt: 112, seq: 7, timestamp: 960, ssrc: 0x11223344, payload });
assert.strictEqual(pkt[0], 0x90, 'v2 + extension bit');
assert.strictEqual(pkt[1], 112, 'pt=112');
assert.strictEqual(pkt.readUInt16BE(2), 7, 'seq');
assert.strictEqual(pkt.readUInt32BE(4), 960, 'timestamp');
assert.strictEqual(pkt.readUInt32BE(8), 0x11223344, 'ssrc');
assert.strictEqual(pkt.readUInt16BE(12), 0xbede, '0xBEDE ext profile');
const parsed = parseRtpPacket(pkt);
assert.strictEqual(parsed.headerLen, 20, '12 base + 4 ext-hdr + 4 ext-word = 20');
assert.strictEqual(parsed.pt, 112, 'parsed pt');
assert.strictEqual(pkt.subarray(parsed.headerLen).toString(), 'opus-frame', 'payload after header');

// wrap/unwrap round-trip
const ft = Buffer.from('01020304', 'hex');
const wire = wrapZrtc(0x03, ft, pkt);
assert.strictEqual(wire[0], 0x03, 'zrtc media type');
assert.strictEqual(wire.subarray(1, 5).toString('hex'), '01020304', 'flowToken');
const u = unwrapZrtc(wire);
assert.strictEqual(u.type, 0x03, 'unwrap type');
assert.strictEqual(u.flowToken.toString('hex'), '01020304', 'unwrap flowToken');
assert.ok(u.srtp.equals(pkt), 'unwrap srtp == original');
assert.throws(() => wrapZrtc(0x03, Buffer.alloc(3), pkt), /4 bytes/, 'flowToken must be 4 bytes');

cp.execFileSync(process.execPath, ['--check', RTP]);
cp.execFileSync(process.execPath, ['--check', FRAME]);
console.log('OK rtp-frame');
