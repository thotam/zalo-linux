'use strict';
// PoC decoder for the ZRTPPacket REQUEST wire format (type 0x01), reconciled
// against a REAL packet captured on loopback during Task 5/6 (see
// scratch/zcall-analysis/zrtppacket-request-real.hex and Appendix C of
// docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md).
//
// Task 3's static disassembly of `_buildPacketInternal` claimed the whole
// ZRTPPacket wire format is native/little-endian (no bswap instructions found).
// That claim does NOT hold for reading this REQUEST packet's ints at the
// offsets below: fromId/toId/callId are only recoverable by reading
// big-endian -- e.g. fromId=111 (0x6f) is on the wire as `00 00 00 6f`, not
// `6f 00 00 00`. Re-disassembly for this task found _buildPacketInternal's
// type-1 branch and initZRTPPacketRequestInitCall both really do plain
// native (no-bswap) `mov` -- the "different builder function" theory does
// NOT hold up. If the byte order really is swapped end-to-end, the swap must
// already be baked into CallController's upstream fields before this
// object is ever populated (untraced, open question). See the Appendix C
// Endianness section for the full trace and a caveat: fromId/toId/callId are
// all small enough that a big-endian read at these offsets is numerically
// indistinguishable from a little-endian read 3 bytes later, so this is
// CONFIRMED for decoding this one sample, not proven as "genuinely
// big-endian" wire format. Only the REQUEST family (type 0x01) has been
// validated against a real capture; the LE claim for the media/P2P families
// is unchanged and still unvalidated by any real capture.
//
// Field offsets below are CONFIRMED against the one real captured packet
// (41 bytes, an InitCall-shaped REQUEST). Only `type`, `byte1`, `fromId`,
// `toId`, `callId`, `sessId`, and `rawLen` have a semantic name backed by the
// harness config that produced the capture (fromId=111, toId=222, callId=10,
// sessId="SP1CAPTURE"). Every other byte range is unmapped from a single
// sample and is exposed as raw bytes under a TENTATIVE name -- do NOT treat
// those names as confirmed field semantics.

function parseZrtpPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 41) {
    throw new Error('short packet: need at least 41 bytes for a REQUEST-family ZRTPPacket, got ' +
      (Buffer.isBuffer(buf) ? buf.length : typeof buf));
  }

  const type = buf.readUInt8(0); // CONFIRMED: 0x01 == ZRTP_REQUEST (Appendix C)

  // byte[1]: CONFIRMED present (matches Appendix C's "mode/flag" == 1 for
  // every init*Request* constructor traced statically); TENTATIVE semantic name.
  const byte1 = buf.readUInt8(1);

  // offset 2, 5 bytes: TENTATIVE, unmapped. All-zero in the one captured
  // packet -- consistent with (but not proof of) Appendix C's "field_A"
  // staying at its ctor zero-default.
  const reservedA = buf.subarray(2, 7);

  // offset 7, 4 bytes, big-endian: CONFIRMED via the harness config
  // (fromId=111 == 0x6f, wire bytes `00 00 00 6f`).
  const fromId = buf.readUInt32BE(7);

  // offset 11, 11 bytes: TENTATIVE, unmapped middle segment. Not all zero in
  // the one captured packet (bytes at relative offset 7/9/10 within this
  // span are 0x0b/0x01/0x0a) -- semantics unknown from a single sample.
  const reservedB = buf.subarray(11, 22);

  // offset 22, 4 bytes, big-endian: CONFIRMED via the harness config
  // (toId=222 == 0xde, wire bytes `00 00 00 de`).
  const toId = buf.readUInt32BE(22);

  // offset 26, 4 bytes, big-endian: CONFIRMED via the harness config
  // (callId=10 == 0x0a, wire bytes `00 00 00 0a`).
  const callId = buf.readUInt32BE(26);

  // offset 30, 1 byte: TENTATIVE. Observed 0x00 immediately before the ASCII
  // sessId in the one captured packet -- could be a length/type marker or
  // just more reserved padding; not enough evidence to name it.
  const sessIdMarker = buf.readUInt8(30);

  // offset 31 to end: CONFIRMED ASCII sessId via the harness config
  // (sessId="SP1CAPTURE").
  const sessId = buf.subarray(31).toString('ascii');

  return {
    type,
    byte1,
    reservedA,
    fromId,
    reservedB,
    toId,
    callId,
    sessIdMarker,
    sessId,
    rawLen: buf.length,
  };
}

module.exports = { parseZrtpPacket };
