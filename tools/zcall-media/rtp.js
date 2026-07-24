'use strict';
// RTP packet build/parse for the zcall media path (§B). PT=112 opus, one-word 0xBEDE extension,
// SSRC = fromId. Parsing reuses the validated srtp-decrypt header parser.
const { parseRtpHeader } = require('./srtp-decrypt.js');

function buildRtpPacket({ pt = 112, seq, timestamp, ssrc, payload, ext = true, extData = Buffer.alloc(4) }) {
  const base = Buffer.alloc(12);
  base[0] = 0x80 | (ext ? 0x10 : 0x00);      // version 2, extension bit
  base[1] = pt & 0x7f;                         // marker 0, payload type
  base.writeUInt16BE(seq & 0xffff, 2);
  base.writeUInt32BE(timestamp >>> 0, 4);
  base.writeUInt32BE(ssrc >>> 0, 8);
  const parts = [base];
  if (ext) {
    if (extData.length % 4 !== 0) throw new Error('buildRtpPacket: extData must be a whole number of 32-bit words');
    const eh = Buffer.alloc(4);
    eh.writeUInt16BE(0xbede, 0);               // one-byte-header extension profile
    eh.writeUInt16BE(extData.length / 4, 2);   // length in 32-bit words
    parts.push(eh, extData);
  }
  parts.push(payload);
  return Buffer.concat(parts);
}

function parseRtpPacket(buf) {
  return parseRtpHeader(buf);
}

module.exports = { buildRtpPacket, parseRtpPacket };
