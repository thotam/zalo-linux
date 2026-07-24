'use strict';
// The 5-byte zrtc media wrapper (§B.1): [0]=media type (0x03 AUDIO_RTP) + [1..4]=per-call
// flowToken, then the standard SRTP packet at offset 5.
function wrapZrtc(type, flowToken, srtp) {
  if (!Buffer.isBuffer(flowToken) || flowToken.length !== 4) throw new Error('wrapZrtc: flowToken must be 4 bytes');
  if (!Buffer.isBuffer(srtp)) throw new Error('wrapZrtc: srtp must be a Buffer');
  return Buffer.concat([Buffer.from([type & 0xff]), flowToken, srtp]);
}

function unwrapZrtc(wire) {
  if (!Buffer.isBuffer(wire) || wire.length < 6) throw new Error('unwrapZrtc: wire too short (need >=6)');
  return { type: wire[0], flowToken: Buffer.from(wire.subarray(1, 5)), srtp: wire.subarray(5) };
}

module.exports = { wrapZrtc, unwrapZrtc };
