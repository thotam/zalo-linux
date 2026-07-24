'use strict';
// SRTP (RFC 3711) packet decrypt: RTP parse, AES-128-CM (counter mode), HMAC-SHA1 auth.
const crypto = require('crypto');

function parseRtpHeader(buf) {
  const b0 = buf.readUInt8(0), b1 = buf.readUInt8(1);
  const cc = b0 & 0x0f;
  let headerLen = 12 + cc * 4;
  const ext = (b0 >> 4) & 1;
  if (ext) {
    const extLenWords = buf.readUInt16BE(headerLen + 2);
    headerLen += 4 + extLenWords * 4;
  }
  return {
    version: b0 >> 6, padding: (b0 >> 5) & 1, ext, cc,
    marker: b1 >> 7, pt: b1 & 0x7f,
    seq: buf.readUInt16BE(2), timestamp: buf.readUInt32BE(4), ssrc: buf.readUInt32BE(8),
    headerLen,
  };
}

// IV = (cipherSalt << 16) XOR (ssrc << 64) XOR (packetIndex << 16), as a 16-byte counter block.
function srtpIv(cipherSalt, ssrc, packetIndex) {
  const iv = Buffer.alloc(16);
  cipherSalt.copy(iv, 0);                 // bytes 0..13, 14..15 = 0
  const ssrcBuf = Buffer.alloc(4); ssrcBuf.writeUInt32BE(ssrc >>> 0);
  for (let i = 0; i < 4; i++) iv[4 + i] ^= ssrcBuf[i];   // ssrc at bytes 4..7
  // packetIndex is 48-bit (ROC<<16 | SEQ) -> bytes 8..13, big-endian
  const idx = Buffer.alloc(8); idx.writeBigUInt64BE(BigInt(packetIndex));
  for (let i = 0; i < 6; i++) iv[8 + i] ^= idx[2 + i];   // low 6 bytes at 8..13
  return iv;
}

function decryptPacket(srtpPkt, keys, opts) {
  const tagLen = (opts && opts.tagLen) != null ? opts.tagLen : 10;
  const roc = (opts && opts.roc) || 0;
  const body = srtpPkt.subarray(0, srtpPkt.length - tagLen);
  const tag = srtpPkt.subarray(srtpPkt.length - tagLen);
  const rocBuf = Buffer.alloc(4); rocBuf.writeUInt32BE(roc >>> 0);
  const expect = crypto.createHmac('sha1', keys.authKey).update(Buffer.concat([body, rocBuf])).digest().subarray(0, tagLen);
  const authOk = tag.length === expect.length && crypto.timingSafeEqual(tag, expect);
  const header = parseRtpHeader(body);
  const encPayload = body.subarray(header.headerLen);
  const iv = srtpIv(keys.cipherSalt, header.ssrc, (roc * 65536) + header.seq);
  const payload = crypto.createDecipheriv('aes-128-ctr', keys.cipherKey, iv).update(encPayload);
  return { header, payload, authOk };
}

module.exports = { parseRtpHeader, srtpIv, decryptPacket };
