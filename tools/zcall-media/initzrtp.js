'use strict';
// InitZRTP wire builder/parser (Linux engine, SP2 step 2.1). Format = §A of
// docs/superpowers/decisions/2026-07-13-zcall-initzrtp-and-srtp-profile.md.
// Little-endian ids (revises SP1 Appendix C's tentative big-endian read). No I/O, no crypto.
const SESSID_LEN = 154;

// PROBE — type 0x01, subtype 0x03, 25 bytes (§A.3).
function buildProbe({ fromId, callId, probeNonce }) {
  if (!Buffer.isBuffer(probeNonce) || probeNonce.length !== 4) {
    throw new Error('buildProbe: probeNonce must be a 4-byte Buffer');
  }
  const buf = Buffer.alloc(25);
  buf[0] = 0x01;                       // type
  buf[1] = 0x7e;                       // flag
  buf.writeUInt32LE(fromId >>> 0, 10); // fromId LE
  probeNonce.copy(buf, 14);            // probeNonce
  buf[18] = 0x03;                      // subtype = probe
  buf.writeUInt32LE(callId >>> 0, 21); // callId LE (bytes 19..20 stay zero)
  return buf;
}

// REQUEST — type 0x01, subtype 0x0b (§A.1). Total = 31-byte header + sessId. The sessId is a
// variable-length base64url token (observed 152 and 154 chars); the length field @29 = its real
// length, so the packet is 31 + sessId.length bytes (185 for a 154-char sessId).
function buildRequest({ fromId, toId, callId, sessId }) {
  if (typeof sessId !== 'string' || sessId.length < 30 || sessId.length > 0xffff) {
    throw new Error('buildRequest: sessId must be a string of 30..65535 chars, got ' +
      (typeof sessId === 'string' ? sessId.length : typeof sessId));
  }
  const n = sessId.length;
  const buf = Buffer.alloc(31 + n);
  buf[0] = 0x01;                       // type
  buf[1] = 0x7e;                       // flag
  buf.writeUInt32LE(fromId >>> 0, 10); // fromId LE
  buf[18] = 0x0b;                      // subtype = InitZRTP
  buf[19] = 0x00; buf[20] = 0x02;      // has-sessId flag/count
  buf.writeUInt32LE(callId >>> 0, 21); // callId LE
  buf.writeUInt32LE(toId >>> 0, 25);   // toId LE
  buf.writeUInt16LE(n, 29);            // sessId length LE u16 (0x9a 0x00 for 154)
  buf.write(sessId, 31, 'ascii');      // sessId
  return buf;
}

// RESPONSE — type 0x02, ~52-55 bytes (§A.2). Two fields fully identified from the 2026-07-14
// connected-call capture:
//   offset 25 (4 B) = per-CALL nonce (identical across all relays in one call).
//   offset 29 (4 B) = per-RELAY flowToken — the relay assigns it; the caller MUST echo it into
//                     every outbound media packet's bytes [1..4] (media[1..4] == resp[29..33],
//                     byte-for-byte). Sending 0x00000000 here is why Linux media never bridged.
// (Revises the earlier mislabels: offset 25 was "callId", offset 29 was "probeNonce".)
function parseResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 35) {
    throw new Error('parseResponse: buffer too short (need >=35, got ' +
      (Buffer.isBuffer(buf) ? buf.length : typeof buf) + ')');
  }
  const type = buf[0];
  if (type !== 0x02) throw new Error('parseResponse: not a RESPONSE (type=0x' + type.toString(16) + ')');
  const flag = buf[1];
  const fromId = buf.readUInt32LE(10);
  const nonce = Buffer.from(buf.subarray(25, 29));       // per-call nonce
  const flowToken = Buffer.from(buf.subarray(29, 33));   // per-relay flowToken (goes into media[1..4])
  const addrLen = buf.readUInt16LE(33);
  if (buf.length < 35 + addrLen) throw new Error('parseResponse: truncated address (need ' + (35 + addrLen) + ', got ' + buf.length + ')');
  const ascii = buf.subarray(35, 35 + addrLen).toString('ascii');
  const [ip, port] = ascii.split('|');
  return { type, flag, fromId, nonce, flowToken, relayAddr: { ip, port } };
}

module.exports = { buildProbe, buildRequest, parseResponse, SESSID_LEN };
