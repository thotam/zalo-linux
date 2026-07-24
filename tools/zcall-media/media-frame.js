'use strict';
// zrtc media wrapper — the framing is ASYMMETRIC (2026-07-14 connected-call capture §C):
//   OUTBOUND (caller->relay) type 0x03: [0]=0x03 + [1..4]=per-call flowToken + SRTP @ offset 5.
//   INBOUND  (relay->caller) type 0x04: [0]=0x04 + SRTP @ offset 1 (NO flowToken — relay strips it).
//   (Sub-stream 0x05 = RTCP/secondary, also 1-byte prefix; not the audio path.)
function wrapZrtc(type, flowToken, srtp) {
  if (!Buffer.isBuffer(flowToken) || flowToken.length !== 4) throw new Error('wrapZrtc: flowToken must be 4 bytes');
  if (!Buffer.isBuffer(srtp)) throw new Error('wrapZrtc: srtp must be a Buffer');
  return Buffer.concat([Buffer.from([type & 0xff]), flowToken, srtp]);
}

// Detect the prefix by media type: 0x03 => 5-byte (flowToken present); anything else => 1-byte.
function unwrapZrtc(wire) {
  if (!Buffer.isBuffer(wire) || wire.length < 2) throw new Error('unwrapZrtc: wire too short');
  const type = wire[0];
  if (type === 0x03) {
    if (wire.length < 6) throw new Error('unwrapZrtc: 0x03 wire too short (need >=6)');
    return { type, prefix: 5, flowToken: Buffer.from(wire.subarray(1, 5)), srtp: wire.subarray(5) };
  }
  return { type, prefix: 1, flowToken: null, srtp: wire.subarray(1) };
}

module.exports = { wrapZrtc, unwrapZrtc };
