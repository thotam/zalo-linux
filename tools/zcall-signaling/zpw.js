'use strict';
// zpw cipher — Zalo API param/response crypto. Verbatim from the app bundle:
// AES-128-CBC, PKCS7, IV = 16 zero bytes, key = Base64.decode(secretKey). (GO verdict §4a.)
const crypto = require('crypto');

function keyBuf(secretKey) {
  const k = Buffer.from(secretKey, 'base64');
  if (k.length !== 16) throw new Error('zpw: secretKey must decode to 16 bytes, got ' + k.length);
  return k;
}

function encode(objOrStr, secretKey) {
  const pt = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
  const c = crypto.createCipheriv('aes-128-cbc', keyBuf(secretKey), Buffer.alloc(16, 0));
  return Buffer.concat([c.update(pt, 'utf8'), c.final()]).toString('base64');
}

function decodeToString(cipherB64, secretKey) {
  const input = Buffer.from(decodeURIComponent(cipherB64), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', keyBuf(secretKey), Buffer.alloc(16, 0));
  return Buffer.concat([d.update(input), d.final()]).toString('utf8');
}

module.exports = { encode, decodeToString };
