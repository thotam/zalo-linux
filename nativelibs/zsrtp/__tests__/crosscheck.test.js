// Prove the native srtp_protect output matches the pure-Node srtp-decrypt path that is already
// validated authOk 10/10 on real Zalo wire — i.e. the native path is wire-correct.
const assert = require('assert');
const path = require('path');
const { ZSrtp } = require(path.join(__dirname, '..', 'build', 'Release', 'zsrtp.node'));
const media = path.join(__dirname, '..', '..', '..', 'tools', 'zcall-media');
const { deriveSessionKeys } = require(path.join(media, 'srtp-kdf.js'));
const { decryptPacket } = require(path.join(media, 'srtp-decrypt.js'));

const key = Buffer.alloc(30);
for (let i = 0; i < 30; i++) key[i] = (i * 7 + 1) & 0xff;
const z = new ZSrtp({ key });

// v2, pt=112, seq=5, ts=0, ssrc=0x11223344 (roc=0 -> packetIndex == seq).
const header = Buffer.from('807000050000000011223344', 'hex');
const payload = Buffer.from('cross-check-payload');
const srtp = z.protect(Buffer.concat([header, payload]));

const keys = deriveSessionKeys(key.subarray(0, 16), key.subarray(16, 30));
const res = decryptPacket(srtp, keys, { tagLen: 10, roc: 0 });
assert.strictEqual(res.authOk, true, 'pure-Node HMAC authenticates the native SRTP packet');
assert.strictEqual(res.payload.toString(), 'cross-check-payload', 'pure-Node decrypts native SRTP');
console.log('OK zsrtp crosscheck');
