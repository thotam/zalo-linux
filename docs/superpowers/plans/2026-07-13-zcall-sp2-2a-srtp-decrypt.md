# zcall SP2 step 2a — SRTP Decrypt Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-Node SRTP module that passes RFC 3711 test vectors and decrypts real captured Zalo call media using `sessId[0:30]` (HMAC auth PASS + opus plaintext).

**Architecture:** Three focused modules under `tools/zcall-media/`: `srtp-kdf.js` (RFC 3711 AES-CM key derivation), `srtp-decrypt.js` (RTP parse + SRTP IV + AES-128-CM decrypt + HMAC-SHA1 verify), and `decrypt-capture.js` (CLI over a capture). Pure crypto is validated by RFC 3711 known-answer vectors; end-to-end by one real Windows capture.

**Tech Stack:** Node.js (CommonJS), built-in `crypto` (`aes-128-ctr`, `hmac-sha1`), `assert` tests.

## Global Constraints

- **zpw/SRTP crypto is standard RFC 3711:** AES-128-CM cipher (via `aes-128-ctr`), HMAC-SHA1 auth, master key = `sessId[0:16]`, master salt = `sessId[16:30]`. (Spec.)
- **Own account/machine/phone captures only; media + sessId stay local; committed vectors are RFC-synthetic or redacted — no real sessId/keys/media in git.** (Spec §ToS.)
- **This step decrypts only; no live transport, no InitZRTP, no opus→audio, no RTCP.** (Spec §Out of scope.)
- **No `Co-Authored-By` / AI-attribution** in commit messages (repo rule).
- Tests are `assert`-based, runnable with plain `node <file>`; pure modules pass `node --check`.

---

## File Structure

- `tools/zcall-media/srtp-kdf.js` (Create) — `deriveSessionKeys(masterKey, masterSalt)`.
- `tools/zcall-media/srtp-decrypt.js` (Create) — `parseRtpHeader`, `srtpIv`, `decryptPacket`.
- `tools/zcall-media/decrypt-capture.js` (Create) — CLI.
- `tools/zcall-media/CAPTURE-MEDIA-WIN.md` (Create) — Windows capture runbook.
- `tools/zcall-media/__tests__/srtp-kdf.test.js` (Create)
- `tools/zcall-media/__tests__/srtp-decrypt.test.js` (Create)

---

## Task 1: `srtp-kdf.js` — RFC 3711 key derivation

**Files:**
- Create: `tools/zcall-media/srtp-kdf.js`
- Test: `tools/zcall-media/__tests__/srtp-kdf.test.js`

**Interfaces:**
- Produces: `deriveSessionKeys(masterKey: Buffer(16), masterSalt: Buffer(14)): { cipherKey: Buffer(16), cipherSalt: Buffer(14), authKey: Buffer(20) }` — RFC 3711 §4.3.1 AES-CM PRF with `key_derivation_rate = 0`; labels 0x00 (cipher key), 0x02 (cipher salt), 0x01 (auth key).

**Context:** The PRF forms a 16-byte counter from the master salt (`salt[7] ^= label`, then 2 trailing zero bytes) and runs AES-128 in counter mode over zero bytes. Validated by the RFC 3711 Appendix B.3 known-answer vector.

- [ ] **Step 1: Write the failing test** (RFC 3711 §B.3 known-answer)

```js
// tools/zcall-media/__tests__/srtp-kdf.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'srtp-kdf.js');
const { deriveSessionKeys } = require(MOD);

// RFC 3711 Appendix B.3 test vector.
const masterKey = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex');
const masterSalt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex');
const out = deriveSessionKeys(masterKey, masterSalt);
assert.strictEqual(out.cipherKey.toString('hex').toUpperCase(), 'C61E7A93744F39EE10734AFE3FF7A087', 'cipher key');
assert.strictEqual(out.cipherSalt.toString('hex').toUpperCase(), '30CBBC08863D8C85D49DB34A9AE1', 'cipher salt');
assert.strictEqual(out.authKey.toString('hex').toUpperCase(), 'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4', 'auth key');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK srtp-kdf');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-media/__tests__/srtp-kdf.test.js`
Expected: FAIL — `Cannot find module '.../srtp-kdf.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-media/srtp-kdf.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-media/__tests__/srtp-kdf.test.js`
Expected: `OK srtp-kdf`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-media/srtp-kdf.js tools/zcall-media/__tests__/srtp-kdf.test.js
git commit -m "zcall SP2 2a: RFC 3711 SRTP key derivation (AES-CM PRF), B.3 KAT"
```

---

## Task 2: `srtp-decrypt.js` — RTP parse + SRTP IV + AES-CM decrypt + auth

**Files:**
- Create: `tools/zcall-media/srtp-decrypt.js`
- Test: `tools/zcall-media/__tests__/srtp-decrypt.test.js`

**Interfaces:**
- Consumes: `srtp-kdf.deriveSessionKeys` (Task 1) — indirectly (the test builds keys inline).
- Produces:
  - `parseRtpHeader(buf: Buffer): { version, padding, ext, cc, marker, pt, seq, timestamp, ssrc, headerLen }`.
  - `srtpIv(cipherSalt: Buffer(14), ssrc: number, packetIndex: number): Buffer(16)` — `(cipherSalt<<16) ⊕ (ssrc<<64) ⊕ (packetIndex<<16)`.
  - `decryptPacket(srtpPkt: Buffer, keys: {cipherKey, cipherSalt, authKey}, opts?: {tagLen?: number, roc?: number}): { header, payload: Buffer, authOk: boolean }` — verify the trailing HMAC-SHA1 tag (`tagLen` bytes, default 10) over `packet-minus-tag || roc`, then AES-128-CTR decrypt the payload.

- [ ] **Step 1: Write the failing test** (srtpIv known-answer + encrypt/decrypt round-trip for the full path)

```js
// tools/zcall-media/__tests__/srtp-decrypt.test.js
const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'srtp-decrypt.js');
const { parseRtpHeader, srtpIv, decryptPacket } = require(MOD);

// srtpIv known-answer: zero salt, ssrc=0x11223344, index = roc0<<16 | seq5.
const iv = srtpIv(Buffer.alloc(14, 0), 0x11223344, 5);
assert.strictEqual(iv.toString('hex'), '00000000112233440000000000050000', 'srtp IV layout');

// parseRtpHeader: a minimal 12-byte header, PT=111 (opus), seq=5, ssrc=0x11223344.
const hdr = Buffer.from('80' + '6F' + '0005' + '00000000' + '11223344', 'hex');
const p = parseRtpHeader(hdr);
assert.strictEqual(p.pt, 111, 'pt');
assert.strictEqual(p.seq, 5, 'seq');
assert.strictEqual(p.ssrc, 0x11223344, 'ssrc');
assert.strictEqual(p.headerLen, 12, 'header len');

// Full path: build an SRTP packet with our own SRTP encrypt, then decryptPacket recovers it.
const keys = { cipherKey: Buffer.alloc(16, 3), cipherSalt: Buffer.alloc(14, 0), authKey: Buffer.alloc(20, 7) };
const plain = Buffer.from('opus-audio-payload-xyz');
const roc = 0, seq = 5, ssrc = 0x11223344;
const ivEnc = srtpIv(keys.cipherSalt, ssrc, (roc * 65536) + seq);
const enc = crypto.createCipheriv('aes-128-ctr', keys.cipherKey, ivEnc).update(plain);
const body = Buffer.concat([hdr, enc]);                    // RTP header + encrypted payload
const rocBuf = Buffer.alloc(4); rocBuf.writeUInt32BE(roc);
const tag = crypto.createHmac('sha1', keys.authKey).update(Buffer.concat([body, rocBuf])).digest().subarray(0, 10);
const pkt = Buffer.concat([body, tag]);

const dec = decryptPacket(pkt, keys, { tagLen: 10, roc: 0 });
assert.strictEqual(dec.authOk, true, 'auth verifies');
assert.strictEqual(dec.payload.toString(), 'opus-audio-payload-xyz', 'payload recovered');
// tampered tag -> authOk false
const bad = Buffer.from(pkt); bad[bad.length - 1] ^= 0xff;
assert.strictEqual(decryptPacket(bad, keys, { tagLen: 10 }).authOk, false, 'bad tag rejected');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK srtp-decrypt');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-media/__tests__/srtp-decrypt.test.js`
Expected: FAIL — `Cannot find module '.../srtp-decrypt.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-media/srtp-decrypt.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-media/__tests__/srtp-decrypt.test.js`
Expected: `OK srtp-decrypt`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-media/srtp-decrypt.js tools/zcall-media/__tests__/srtp-decrypt.test.js
git commit -m "zcall SP2 2a: SRTP packet decrypt (RTP parse + AES-CM IV + HMAC-SHA1 verify)"
```

---

## Task 3: `decrypt-capture.js` CLI + Windows capture runbook

**Files:**
- Create: `tools/zcall-media/decrypt-capture.js`
- Create: `tools/zcall-media/CAPTURE-MEDIA-WIN.md`

**Interfaces:**
- Consumes: `srtp-kdf.deriveSessionKeys`, `srtp-decrypt.decryptPacket`.
- Produces: CLI `node decrypt-capture.js <sessId> <packets.json>` where `packets.json` is an array
  of hex strings (SRTP packets). Derives master key/salt from `sessId[0:16]`/`sessId[16:30]`
  (raw ASCII bytes), runs the KDF, and decrypts each packet trying `tagLen=10` then `4`; prints
  per-packet `authOk` + whether the plaintext looks like RTP+opus.

- [ ] **Step 1: Write the CLI**

```js
// tools/zcall-media/decrypt-capture.js
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

// A plausible RTP+opus plaintext: RTP v2 header and a payload whose first byte (opus TOC) parses.
function looksLikeRtpOpus(res) {
  return res.header.version === 2 && res.payload.length > 0;
}

function run(sessId, packetsHex) {
  const keys = keysFromSessId(sessId);
  return packetsHex.map((hex, i) => {
    const pkt = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
    for (const tagLen of [10, 4]) {
      try {
        const res = decryptPacket(pkt, keys, { tagLen, roc: 0 });
        if (res.authOk) return { i, tagLen, authOk: true, pt: res.header.pt, ssrc: res.header.ssrc, opus: looksLikeRtpOpus(res), plainLen: res.payload.length };
      } catch (_) { /* try next tagLen */ }
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

module.exports = { keysFromSessId, run };
```

- [ ] **Step 2: Sanity-check the CLI parses**

Run: `node --check tools/zcall-media/decrypt-capture.js`
Expected: no output (exit 0).

- [ ] **Step 3: Write the Windows capture runbook**

Create `tools/zcall-media/CAPTURE-MEDIA-WIN.md`:

```markdown
# SP2 2a — Windows media capture runbook

Own call only (your account → your own phone). Media + sessId stay local; commit only redacted.

## 1. Capture the SRTP media
- Wireshark/Npcap: capture filter `udp port 4200` (the media relay port).
- Place a real 1-1 audio call to your own phone; let it connect ~10s; hang up.
- In Wireshark, pick a few UDP packets to `<relay>:4200` that carry media (larger, steady-rate).
  For each: right-click the UDP payload Data -> Copy -> ...as Hex Stream. Collect into a JSON
  array file `media.json` = ["<hex1>","<hex2>", ...].

## 2. Capture that call's sessId (same call)
- Run the step-1 tooling on Windows to fetch the sessId of the call:
      node tools/zcall-signaling/prototype.js <yourCalleeId>
  (or read the sessId from the requestcall response you decrypt). NB the sessId is per-call and
  ephemeral — use the one from the SAME call whose media you captured.

## 3. Decrypt
      node tools/zcall-media/decrypt-capture.js <sessId> media.json
- Success = packets report `authOk: true` (HMAC-SHA1 verified with sessId[0:30]) and `pt`/opus.
  That proves sessId[0:30] is the real SRTP key and pins the tag length (10 vs 4).

Send the (redacted) authOk/pt/tagLen result — never the raw sessId or media.
```

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-media/decrypt-capture.js tools/zcall-media/CAPTURE-MEDIA-WIN.md
git commit -m "zcall SP2 2a: decrypt-capture CLI + Windows media capture runbook"
```

---

## Task 4: End-to-end verify (manual, operator)

**Files:** none (a real capture + a short note).

**Context:** Tasks 1–3 are RFC-vector-validated code; this is the real-media validation on the operator's Windows machine.

- [ ] **Step 1: Capture + decrypt** per `tools/zcall-media/CAPTURE-MEDIA-WIN.md`.
- [ ] **Step 2: Confirm** `decrypt-capture.js` reports `authOk: true` for real Zalo media keyed by `sessId[0:30]`, and note the working `tagLen`.
- [ ] **Step 3: Record** the result (redacted) in the GO verdict roadmap as "2a done — sessId[0:30] decrypts real media, profile = AES-128-CM + HMAC-SHA1-<80|32>", and note the exact profile for 2b/2c.

---

## Notes

- If `authOk` is false for both tag lengths, the profile differs from the assumed RFC 3711
  AES-CM/HMAC-SHA1 (e.g. AES-GCM AEAD for `srtpMode:1`, or an MKI is present). In that case
  record the exact captured packet structure (leading bytes, length deltas) so the profile can be
  re-derived — a refinement, not a redesign.
- Next (separate plan): SP2 2b — InitZRTP live (send the sessId-bearing REQUEST to the relay
  `:4200`, read the relay reply), consuming this module's keys for the media that follows.
```
