const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'zpw.js');
const { encode, decodeToString } = require(MOD);

const secretKey = Buffer.alloc(16, 7).toString('base64'); // 16-byte AES-128 key, base64
const key = Buffer.from(secretKey, 'base64');
const iv = Buffer.alloc(16, 0);
const plain = JSON.stringify({ hello: 'world', n: 42 });

// reference ciphertext produced by Node crypto directly
const ref = crypto.createCipheriv('aes-128-cbc', key, iv);
const refCipher = Buffer.concat([ref.update(plain, 'utf8'), ref.final()]).toString('base64');

// encode matches the reference
assert.strictEqual(encode(plain, secretKey), refCipher, 'encode == node reference');
// decodeToString inverts the reference ciphertext
assert.strictEqual(decodeToString(refCipher, secretKey), plain, 'decode inverts reference');
// round-trip on an object
assert.strictEqual(decodeToString(encode({ a: 1 }, secretKey), secretKey), JSON.stringify({ a: 1 }), 'round-trip');
// tolerates url-encoding on input
assert.strictEqual(decodeToString(encodeURIComponent(refCipher), secretKey), plain, 'url-encoded input');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK zpw');
