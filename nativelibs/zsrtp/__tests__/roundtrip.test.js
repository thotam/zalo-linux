const assert = require('assert');
const path = require('path');
const { ZSrtp } = require(path.join(__dirname, '..', 'build', 'Release', 'zsrtp.node'));

const key = Buffer.alloc(30);
for (let i = 0; i < 30; i++) key[i] = i + 1;
const z = new ZSrtp({ key });

// Minimal RTP packet: v2 (0x80), pt=112 (0x70), seq=1, ts=0, ssrc=0x11223344, + payload.
const header = Buffer.from('807000010000000011223344', 'hex');
const payload = Buffer.from('hello-opus');
const rtp = Buffer.concat([header, payload]);

const srtp = z.protect(Buffer.from(rtp));
assert.strictEqual(srtp.length, rtp.length + 10, 'srtp adds a 10-byte auth tag');
const back = z.unprotect(srtp);
assert.strictEqual(back.length, rtp.length, 'unprotect restores original length');
assert.strictEqual(back.toString('utf8', 12), 'hello-opus', 'payload recovered');

// bad key length -> throw
assert.throws(() => new ZSrtp({ key: Buffer.alloc(16) }), /30 bytes/, 'rejects non-30-byte key');
console.log('OK zsrtp roundtrip');
