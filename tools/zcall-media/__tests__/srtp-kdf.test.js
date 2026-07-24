const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'srtp-kdf.js');
const { deriveSessionKeys } = require(MOD);

// RFC 3711 Appendix B.3 test vector.
const masterKey = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex');
const masterSalt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex');
const out = deriveSessionKeys(masterKey, masterSalt);
assert.strictEqual(out.cipherKey.toString('hex').toUpperCase(), 'C61E7A93744F39EE10734AFE3FF7A087', 'cipher key');
assert.strictEqual(out.cipherSalt.toString('hex').toUpperCase(), '30CBBC08863D8C85D49DB34A9AE1', 'cipher salt');
assert.strictEqual(out.authKey.toString('hex').toUpperCase(), 'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4', 'auth key');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK srtp-kdf');
