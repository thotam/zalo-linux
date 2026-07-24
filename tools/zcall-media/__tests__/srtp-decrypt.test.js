const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'srtp-decrypt.js');
const { parseRtpHeader, srtpIv, decryptPacket } = require(MOD);

// srtpIv known-answer: zero salt, ssrc=0x11223344, index = roc0<<16 | seq5.
const iv = srtpIv(Buffer.alloc(14, 0), 0x11223344, 5);
assert.strictEqual(iv.toString('hex'), '00000000112233440000000000050000', 'srtp IV layout');

// parseRtpHeader: a minimal 12-byte header, PT=111 (opus), seq=5, ssrc=0x11223344.
const hdr = Buffer.from('80' + '6F' + '0005' + '00000000' + '11223344', 'hex');
const p = parseRtpHeader(hdr);
assert.strictEqual(p.pt, 111, 'pt');
assert.strictEqual(p.seq, 5, 'seq');
assert.strictEqual(p.ssrc, 0x11223344, 'ssrc');
assert.strictEqual(p.headerLen, 12, 'header len');

// Full path: build an SRTP packet with our own SRTP encrypt, then decryptPacket recovers it.
const keys = { cipherKey: Buffer.alloc(16, 3), cipherSalt: Buffer.alloc(14, 0), authKey: Buffer.alloc(20, 7) };
const plain = Buffer.from('opus-audio-payload-xyz');
const roc = 0, seq = 5, ssrc = 0x11223344;
const ivEnc = srtpIv(keys.cipherSalt, ssrc, (roc * 65536) + seq);
const enc = crypto.createCipheriv('aes-128-ctr', keys.cipherKey, ivEnc).update(plain);
const body = Buffer.concat([hdr, enc]);                    // RTP header + encrypted payload
const rocBuf = Buffer.alloc(4); rocBuf.writeUInt32BE(roc);
const tag = crypto.createHmac('sha1', keys.authKey).update(Buffer.concat([body, rocBuf])).digest().subarray(0, 10);
const pkt = Buffer.concat([body, tag]);

const dec = decryptPacket(pkt, keys, { tagLen: 10, roc: 0 });
assert.strictEqual(dec.authOk, true, 'auth verifies');
assert.strictEqual(dec.payload.toString(), 'opus-audio-payload-xyz', 'payload recovered');
// tampered tag -> authOk false
const bad = Buffer.from(pkt); bad[bad.length - 1] ^= 0xff;
assert.strictEqual(decryptPacket(bad, keys, { tagLen: 10 }).authOk, false, 'bad tag rejected');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK srtp-decrypt');
