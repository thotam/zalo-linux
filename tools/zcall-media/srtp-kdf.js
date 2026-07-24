'use strict';
// RFC 3711 §4.3.1 SRTP key derivation (AES-CM PRF, key_derivation_rate = 0).
const crypto = require('crypto');

// PRF: 16-byte counter = master salt with `label` XOR'd at byte 7, then 2 zero bytes.
// AES-128 counter mode over `n` zero bytes yields the derived key material.
function prf(masterKey, masterSalt, label, n) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0);        // bytes 0..13 = salt, 14..15 = 0
  iv[7] ^= label;
  const c = crypto.createCipheriv('aes-128-ctr', masterKey, iv);
  return Buffer.concat([c.update(Buffer.alloc(n)), c.final()]).subarray(0, n);
}

function deriveSessionKeys(masterKey, masterSalt) {
  return {
    cipherKey: prf(masterKey, masterSalt, 0x00, 16),
    cipherSalt: prf(masterKey, masterSalt, 0x02, 14),
    authKey: prf(masterKey, masterSalt, 0x01, 20),
  };
}

module.exports = { deriveSessionKeys };
