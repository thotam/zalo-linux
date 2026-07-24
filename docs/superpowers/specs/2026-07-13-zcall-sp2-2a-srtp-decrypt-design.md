# zcall SP2 step 2a — SRTP decrypt proof (design)

**Date:** 2026-07-13
**Status:** design approved; pre-implementation
**Parent:** [GO verdict](../decisions/2026-07-13-zcall-keying-GO-verdict.md) §6.4 ("verify end-to-end by decrypting captured SRTP media with sessId[0:30]")
· [SP2 step 1 (signaling+keying) DONE](2026-07-13-zcall-sp2-signaling-keying-prototype-design.md)
**Decomposition:** step 2 (media engine) splits into **2a** (this: SRTP decrypt proof), 2b (InitZRTP live), 2c (RTP/opus duplex). 2a is the cheapest decisive de-risk.

## Context

Step 1 proved Linux can obtain a real call config + the SRTP master key
(`srtpMasterKey = sessId[0:30]`, 16-byte AES-128 key + 14-byte salt). The GO verdict states the
media is standard SRTP: **AES-128-CM cipher + HMAC-SHA1 auth, RFC 3711 KDF**, master key =
`sessId[0:30]`, same key both directions, media over UDP to a relay on `:4200`. What is not yet
proven on our side is that this recipe actually **decrypts real Zalo call media** — and the exact
profile (auth tag length, MKI presence for `srtpMode:1`) is still tentative.

Media only flows when the native engine runs, which on Linux is stubbed — so the real SRTP
packets must be **captured on Windows** (the operator's own machine, where the real engine runs)
together with that call's `sessId`. This step builds a pure-Node SRTP module, validates it
against **RFC 3711's official test vectors** (no capture needed), and then decrypts one real
Windows capture to prove `sessId[0:30]` is the correct key end-to-end and to pin the profile.

## Objective & scope boundary

**Objective:** a pure-Node SRTP module that (1) passes RFC 3711 KDF + AES-CM test vectors, and
(2) decrypts a real captured Zalo SRTP media packet using `sessId[0:30]` — HMAC auth PASS +
plaintext RTP with a valid opus payload.

**In scope:** RFC 3711 KDF (AES-CM PRF); SRTP packet decrypt (RTP parse, AES-128-CM via
AES-128-CTR, HMAC-SHA1 auth verify, SRTP IV construction); a CLI to run it over a capture; a
Windows capture runbook.

**Out of scope (YAGNI — 2b/2c):** live send/receive; the InitZRTP UDP handshake; opus
decode-to-audio; mic/speaker; RTCP; SRTCP.

## ToS / safety boundary (binding)

Capture is the operator's **own** call (own account/machine/phone), on Windows. Captured media
and `sessId` stay **local**; anything committed is a **redacted or RFC-synthetic** vector — no
real `sessId`/keys/media in git.

## Architecture & components

New directory `tools/zcall-media/`. One responsibility per file; pure crypto is RFC-vector-tested.

- **`srtp-kdf.js`** — `deriveSessionKeys(masterKey, masterSalt): {cipherKey, cipherSalt, authKey}`.
  RFC 3711 §4.3.1 AES-CM key derivation: for label ∈ {0x00 cipher, 0x02 salt, 0x01 auth}, PRF =
  AES-128-CM(masterKey, IV = (masterSalt ⊕ (label<<8)) padded to 16, counter from 0), take
  cipherKey=16B, cipherSalt=14B, authKey=20B. `key_derivation_rate = 0` (single derivation).
- **`srtp-decrypt.js`** —
  - `parseRtpHeader(buf): {version, padding, ext, cc, marker, pt, seq, timestamp, ssrc, headerLen}`.
  - `srtpIv(cipherSalt, ssrc, packetIndex): Buffer(16)` — `(cipherSalt padded 16) ⊕ (ssrc<<64) ⊕ (packetIndex<<16)`; packetIndex = `roc*2^16 + seq`.
  - `decryptPacket(srtpPkt, keys, {tagLen=10, roc=0}): {header, payload, authOk}` — split off the
    trailing `tagLen`-byte auth tag, verify `HMAC-SHA1(authKey, authPortion || roc)` truncated to
    `tagLen`, then AES-128-CTR decrypt the payload with `srtpIv`.
- **`decrypt-capture.js`** — CLI `node decrypt-capture.js <sessId-or-hex> <packets.json>`: derive
  master key/salt from `sessId[0:16]`/`sessId[16:30]`, run the KDF + `decryptPacket` over each
  packet, report per packet `authOk` + whether the plaintext is a plausible RTP+opus payload
  (opus TOC byte). Try `tagLen=10` (HMAC-SHA1-80) first, fall back to `4` (SHA1-32).
- **`CAPTURE-MEDIA-WIN.md`** — runbook: on Windows, `tcpdump`/Wireshark capture UDP to `:4200`
  during a real call to your own phone; simultaneously capture that call's `sessId` with the
  step-1 tooling (CDP invoke works on Windows — same bundle); export a few SRTP packets (hex) +
  the sessId to feed `decrypt-capture.js`. Media/sessId stay local; commit only a redacted sample.

### Data flow

```
Windows call → tcpdump UDP :4200 (SRTP pkts) + CDP invoke → sessId    [same call, synchronized]
   → decrypt-capture.js: sessId[0:16] + sessId[16:30] → srtp-kdf → srtp-decrypt(pkt) → authOk + RTP/opus plaintext
```

## Testing

- **`srtp-kdf.js`:** RFC 3711 §B.3 (Appendix B) AES-CM key-derivation **known-answer test** —
  the published master key/salt → expected cipher key/salt/auth key. Pure, no capture.
- **`srtp-decrypt.js`:** RFC 3711 AES-CM keystream/test vector for the cipher + IV construction,
  plus a self-constructed packet (encrypt-then-decrypt round-trip with a known key) for the auth
  path. Pure, no capture.
- **End-to-end:** one real Windows capture run — `decrypt-capture.js` reports `authOk = true` and
  a valid opus payload on real Zalo media.

## Success criteria

`srtp-kdf` and `srtp-decrypt` pass the RFC 3711 test vectors; and `decrypt-capture.js`, on a real
Zalo media capture keyed by `sessId[0:30]`, reports **HMAC auth PASS** with a plausible RTP+opus
plaintext. That proves `sessId[0:30]` is the correct SRTP key for real media and pins the exact
profile — unblocking 2b (InitZRTP live) and 2c (duplex audio).

## Out of scope (YAGNI)

Live transport; InitZRTP; opus→audio; mic/speaker; RTCP/SRTCP; anything touching another
account or another user's media.
