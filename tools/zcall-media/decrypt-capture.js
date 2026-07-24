'use strict';
// SP2 2a end-to-end: decrypt captured Zalo SRTP media with sessId[0:30]. Own capture only.
const fs = require('fs');
const { deriveSessionKeys } = require('./srtp-kdf.js');
const { decryptPacket } = require('./srtp-decrypt.js');

function keysFromSessId(sessId) {
  const raw = Buffer.from(String(sessId).slice(0, 30), 'ascii');
  if (raw.length < 30) throw new Error('sessId too short: need >=30 chars, got ' + raw.length);
  return deriveSessionKeys(raw.subarray(0, 16), raw.subarray(16, 30));
}

// A plausible RTP+opus plaintext: RTP v2 header and a non-empty payload.
function looksLikeRtpOpus(res) {
  return res.header.version === 2 && res.payload.length > 0;
}

// Zalo wraps each SRTP media packet in a 5-byte zrtc AUDIO frame on the wire:
//   [0]=media type (0x03 AUDIO_RTP, 0x04, 0x05, 0x0d, 0x0e, 0x0f) + [1..4]=per-call flowToken,
// then the STANDARD SRTP packet starts at offset 5 (RTP byte0 has version 2). Confirmed by
// breakpointing srtp_protect in ZaloCall.exe (SP2 2c): the wire = 5-byte prefix + srtp_protect
// output. So to decrypt a captured wire packet, strip the 5-byte prefix first.
const ZRTC_MEDIA_TYPES = new Set([0x03, 0x04, 0x05, 0x0d, 0x0e, 0x0f]);
function isZrtcWrapped(pkt) {
  return pkt.length > 5 && ZRTC_MEDIA_TYPES.has(pkt[0]) && (pkt[5] >> 6) === 2;
}

// Candidate framings to try per packet (2026-07-14 capture §C): standard SRTP as-is; the 5-byte
// zrtc prefix stripped (OUTBOUND 0x03: flowToken@1..4, RTP@5); and the 1-byte prefix stripped
// (INBOUND 0x04 relay-forwarded: no flowToken, RTP@1).
function framings(pkt) {
  const out = [{ off: 0, pkt }];
  if (pkt.length > 5 && ZRTC_MEDIA_TYPES.has(pkt[0])) {
    if ((pkt[5] >> 6) === 2) out.push({ off: 5, pkt: pkt.subarray(5) }); // 0x03 outbound
    if ((pkt[1] >> 6) === 2) out.push({ off: 1, pkt: pkt.subarray(1) }); // 0x04 inbound
  }
  return out;
}

function run(sessId, packetsHex) {
  const keys = keysFromSessId(sessId);
  return packetsHex.map((hex, i) => {
    const raw = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
    for (const f of framings(raw)) {
      for (const tagLen of [10, 4]) {
        try {
          const res = decryptPacket(f.pkt, keys, { tagLen, roc: 0 });
          if (res.authOk) return { i, zrtcPrefix: f.off, tagLen, authOk: true, pt: res.header.pt, ssrc: res.header.ssrc, seq: res.header.seq, opus: looksLikeRtpOpus(res), plainLen: res.payload.length };
        } catch (_) { /* try next framing/tagLen */ }
      }
    }
    return { i, authOk: false };
  });
}

if (require.main === module) {
  const [sessId, file] = process.argv.slice(2);
  if (!sessId || !file) { console.error('usage: node decrypt-capture.js <sessId> <packets.json>'); process.exit(2); }
  const packets = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = run(sessId, packets);
  console.log(JSON.stringify(out, null, 2));
  const ok = out.filter((r) => r.authOk).length;
  console.error('[decrypt-capture] ' + ok + '/' + out.length + ' packets authenticated with sessId[0:30]');
}

module.exports = { keysFromSessId, run, isZrtcWrapped };
