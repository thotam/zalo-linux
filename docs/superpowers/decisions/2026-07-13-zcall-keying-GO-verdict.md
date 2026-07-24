# zcall keying — **VERDICT: GO** (SP2.1 Windows real-engine RE)

**Date:** 2026-07-13
**Supersedes:** [2026-07-12 SP2.0 verdict (NO-GO-leaning)](2026-07-12-zcall-zrtp-keying-verdict.md)
**Method:** real 1-1 calls on **Windows** Zalo (own account → own phone), decrypting the
signaling + reverse-engineering the real native call engine.
**Verdict:** **GO — Zalo calls are reimplementable on Linux.** The SP1 §E.5 CONDITIONAL and
the SP2.0 NO-GO-lean are **resolved to GO**: the SRTP keying is fully client-reproducible
from data the client already obtains through normal signaling. No DH, no server-held secret,
no attestation/anti-tamper.

> Boundary (binding): every capture was the operator's own machine / own account / own traffic
> (own phone). TLS/zpw decryption applied only to the operator's own sessions. Real per-call
> tokens/keys are **ephemeral** and are shown **redacted/illustrative** here — never commit real
> `sessId`/key values.

---

## 1. The headline — SRTP keying recipe (confirmed by real capture)

```
SRTP master key (30 bytes) = the FIRST 30 ASCII characters of `sessId`
                             ├─ bytes  0..15  = AES-128 master key (16 B)
                             └─ bytes 16..29  = master salt        (14 B)
      → standard libsrtp / RFC 3711 SRTP-KDF (AES-CM PRF) → cipher key + cipher salt + auth key
```

- `sessId` is a **154-char base64url token** the **server returns in the `requestcall`
  response** (also surfaced in the engine's `onCallChangeZRTP{... "sessionId": "<sessId>"}`).
- The **same 30-char string** is used for **RTP and RTCP, both send and receive** (symmetric;
  buffer A == buffer B at the libsrtp init call).
- The relay/peer knows the same key because the **server issues the same `sessId`** to both
  ends; keying is server-**distributed** (shared token), not server-**attested** (opaque).

**Confirmation (one real answered call):**
```
requestcall sessId (decrypted from signaling): uvbO9oZ5u3Jfh4WK4itYCU-gFo5ool HZowye2MwJ_Lh5Y2OQD… (154 chars)   [REDACT in commits]
SRTP master key   (dumped from ZaloCall RAM ): uvbO9oZ5u3Jfh4WK4itYCU-gFo5ool                                   [REDACT in commits]
                                                └──────────── sessId[0:30] ────────────┘
assert key == sessId[0:30]  →  TRUE
```

---

## 2. Call architecture (Windows real engine — same protocol Linux must speak)

```
┌─ Electron (Chromium/JS, same webpack bundles as the Linux build) ─┐
│  requestCall(): GET https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall
│     ?zpw_ver&zpw_type&params=<zpw(AES) encrypt of {calleeId,callId,codec,typeRequest,imei}>
│  response .data = zpw(AES) ciphertext  →  decrypt →  the CALL CONFIG (see §3)
│  hands config to the native engine via a Windows named pipe:
│     \\.\pipe\PipeZCallSend  /  \\.\pipe\PipeZCallRecv     (setConfig-style message)
└───────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─ ZaloCall.exe  (plugins\capture\ZaloCall.exe — separate 32-bit process) ─┐
│  Zalo's WebRTC fork "zrtc" (libjingle + libsrtp), source tree:            │
│     voip_platform\callpc\zalocallplugin\zalo_call_process                 │
│     voip_platform\core\zrtc_core\zrtc                                     │
│  _initCallConfig(sessionId,…) → _initZrtcConfig → createAndInitSRTP(key)  │
│  key = sessId[0:30]  →  libsrtp  →  SRTP media over UDP to relay :4200    │
│  "InitZRTP" = UDP token exchange to a relay (client presents sessId,      │
│               server replies with the media relay rtp/rtcp address).      │
│               NB: NOT peer-to-peer ZRTP/DH; changeZRTP.enable = 0.        │
└──────────────────────────────────────────────────────────────────────────┘
```

On **Linux** today the `$zcall` JS/IPC path carries only high-level intent (SP2.0), and there
is no native engine — but the **signaling is fetched at the JS layer** (confirmed on Windows:
`requestcall` went through the WinINET proxy). The Linux build runs the **same webpack bundles**,
so it can fetch + decrypt the same config. The missing piece is a **Linux call engine** that
consumes that config; §6 is the roadmap.

---

## 3. The decrypted `requestcall` config (what the engine consumes)

Fields (values elided; structure is what matters):
```
data = {
  fromId, toId,                       // participant ids (uint32)
  sessId,                             // 154-char base64url token  ← key source (first 30 chars)
  servers: [ { rtpaddr, rtcpaddr, rtpIPv6, rtcpIPv6, bonus, spTcp }, … ],  // ~7 relays, all :4200
  rtpIP, rtcpIP,                      // selected relay
  protocol: 3,
  changeZRTP: { enable: 0, threshold: 5 },     // ZRTP-change OFF → no DH
  fec: { enable: 3 },
  video: { enable: 1 },
  zrtc_config: { srtpMode: 1, … ~120 codec/quality params … },  // NO key material here
  settings: { ping, checkTimeOut, echo*, p2p, … },
  id, ts, status, msg, showDebugInfo
}
```
`zrtc_config` is **pure codec/quality tuning** (bitrates, bwProfiles, opus/x264, echo/agc, nack,
`srtpMode:1`) — it contains **no key/salt/nonce**. (Note: `tools/zcall-re/classify-keying.js`
reports `klass:"a"` for this because it flags `zrtc_config` presence — that is a **false
positive**; there is no key inside it. Fix the heuristic to require actual key material.)

---

## 4. Crypto details (both layers)

### 4a. zpw — the Zalo API param/response cipher (to read `requestcall`)
```
algorithm : AES-128-CBC, PKCS7
IV        : 16 zero bytes
key       : Base64.decode(secretKey)   // secretKey = 24-char base64 → 16 bytes (AES-128)
input     : base64(ciphertext) in the JSON `data` / `params` field
```
`secretKey` = the **zpw session key**, a runtime login artifact. In the JS it is
`getSecretKey()` (module var `le`); the request/response codec is
`encodeAES(s)=AES.encrypt(s, Base64(getSecretKey()), {iv:0, CBC, Pkcs7})` /
`decodeAES(e)` (bundle `compact-app-pc` / `default-login-main-startup-shared-worker-znotification`).
The key is derived at login from `zcid`/`zcid_ext` (ParamCipher.createEncryptKey — see the JS);
for RE it was read at runtime via CDP (see §5).

### 4b. SRTP — the media cipher (the actual call keying)
```
master key : sessId[0:30]  (30 raw ASCII bytes: 16 key + 14 salt)  — AES-128-ICM
KDF        : standard libsrtp / RFC 3711 (AES-CM PRF) → session cipher key, cipher salt, auth key (HMAC-SHA1)
same key for RTP + RTCP, both directions.
```

---

## 5. How each fact was established (evidence chain, reproducible)

1. **UDP (Wireshark/tshark):** call media/handshake is UDP to VNG relays on **:4200**; wire
   format matches SP1 Appendix C ZRTPPacket REQUEST(0x01)/RESPONSE(0x02). The InitZRTP handshake
   = client sends a 185-B packet carrying the `sessId` as ASCII + a 53-B reply with the relay
   address. No DH / no key on the wire.
2. **mitmproxy:** login + call worked **through the proxy** (⇒ **no cert pinning** at the
   Chromium layer) and `voicecall/requestcall` appeared ⇒ signaling is fetched at the **JS
   layer**. Response `data` is zpw-encrypted.
3. **CDP (Chrome DevTools Protocol, non-invasive):** launched Zalo with
   `--remote-debugging-port=9222 --remote-allow-origins=*` (Electron fuse
   `EnableNodeCliInspectArguments=ON`; `EnableEmbeddedAsarIntegrityValidation=OFF`); a pure-Node
   client (Node 24 global `WebSocket`) set a `Debugger` breakpoint on `getSecretKey` → read the
   zpw `secretKey`; `Network.getResponseBody` captured the `requestcall` ciphertext → **decrypted
   offline** with §4a → the plaintext config (§3). (Do NOT patch app.asar via folder-override —
   Zalo runs an integrity check and shows "installation corrupted"; CDP is clean.)
4. **Native RE of `ZaloCall.exe` (WinDbg cdbX86, 32-bit):** the real engine is a **separate
   process** (found via: no Electron process nor `zcall_ia32.node` owned the media socket →
   `ZaloCall.exe` in `plugins\capture\`). A full `.dump /ma` (mid-call) revealed libjingle/libsrtp
   + `createAndInitSRTP` (`peercallzrtpimpl.cpp`). A live self-detaching breakpoint at
   `ZaloCall+0x9ffc` (the srtp-init call inside `createAndInitSRTP`) dumped the two std::string
   buffer args = the **30-char master key**.
5. **Correlation:** a combined capture (cdb key + CDP sessId, same call) proved
   **key == sessId[0:30]** (§1), and the engine's RAM showed
   `…,"sessionId":"<sessId>"` immediately adjacent to the key.

RE reference (ZaloCall.exe 26.6.20, dump image base `0x006f0000`; use RVA + runtime base for
ASLR): `createAndInitSRTP` entry RVA `0x47140f`; srtp-init call thunk RVA **`0x9ffc`** → real fn
`0x00be35e6`; success/fail log strings `"createAndInitSRTP success/fail"`. cdb one-shot capture:
scratchpad `zcall-re/bp1.cdb` (`bp ZaloCall+0x9ffc` dumping `poi(esp+8)`/`poi(esp+c)` std::strings,
then `.detach; q`). **Lesson:** never force-kill an attached cdb — it leaves ZaloCall's debug
port stuck (NTSTATUS 0xC0000048) and freezes the engine; always self-`.detach`.

---

## 6. Linux implementation roadmap (SP2/SP3 — now justified)

The keying barrier is gone; what remains is engineering a Linux media engine that speaks the
same protocol. Concrete path:

1. **Signaling (reuse the JS layer).** The Linux build already runs the same bundles. Fetch
   `voicecall/requestcall` (+ `request`/`answer`/`answerack`/`ringring`/`endcall`) and decrypt
   with zpw (§4a). Prototype in Node using the CDP-extracted `secretKey`, then implement the
   `zcid/zcid_ext` key derivation to get `secretKey` without CDP. Result: `sessId`, `servers`,
   `zrtc_config`.
2. **Keying.** `srtp_master_key = sessId[0:30]` (16-B key + 14-B salt), AES-128-ICM.
3. **Media engine.** Options, cheapest first:
   - (a) **Reuse `libsrtp` + a minimal RTP/UDP loop** to the relay `:4200`, opus audio (the
     config gives codec params). The "InitZRTP" pre-step = send the ZRTPPacket REQUEST (SP1
     Appendix C framing) carrying `sessId` to the relay, read the relay address reply, then
     stream SRTP. Validate framing against SP1 Appendix C + the `tools/zcall-re/parse-zrtppacket.js`.
   - (b) If (a)'s hand-rolled RTP is too much, port/build the `zrtc` engine for Linux (it's a
     WebRTC fork; `zcall` ships a Linux/mac variant — `zcall_ia32.node` is the same engine as a
     Node addon). Heavier; only if (a) stalls.
4. **Verify end-to-end** by decrypting captured SRTP media with `sessId[0:30]` + libsrtp KDF
   (a synchronized tshark-UDP + CDP-sessId capture makes a golden test vector).

**Open items / risks (none block GO):**
- Exact **InitZRTP UDP request** bytes for a real relay (SP1 Appendix C is one captured sample;
  re-capture a live one to pin every field).
- `secretKey` derivation from `zcid/zcid_ext` (documented in the JS; re-derive to drop the CDP
  dependency).
- AEAD vs AES-CM confirmation for `srtpMode:1` (libsrtp debug strings show AES-CM + HMAC-SHA1;
  confirm the exact policy/profile in `createAndInitSRTP`'s callee).

---

## 6b. SP2 step 1 — DONE (Linux, live) 2026-07-13

Roadmap §6.1 (signaling + keying) is **implemented and validated live on Linux**
(`tools/zcall-signaling/`, spec `../specs/2026-07-13-zcall-sp2-signaling-keying-prototype-design.md`).
`node tools/zcall-signaling/prototype.js` obtains a real config and derives the SRTP master key:
`sessIdLen 154`, `keyLen 30`, servers on `:4200`, `changeZRTP.enable 0`.

Key implementation note vs the original plan: on Linux the JS `requestCall` is **native-gated**
(only fired by the native-engine signal 401, via `handleSendSignal`/`$zcall.onCallSignal`,
which the stubbed engine never sends) — so it cannot be captured by clicking call, and a
from-scratch rebuild would have to reproduce the per-request common-params signing. The working
approach **invokes the app's own `requestCall` via CDP**: webpack-4 `webpackJsonp` require grab
→ find the module exporting `requestCall` → `requestCall(calleeId, callId, "[]", 1)`, reusing
the app's auth/zpw/signing; the return value is the already-decoded config. Remote debugging is
enabled from inside the main process (`ZALO_REMOTE_DEBUG=1`, CLI `--remote-debugging-port` is
fuse-rejected). Next: SP2 step 2 (media — libsrtp + RTP/UDP `:4200` + InitZRTP).

## 7. Bottom line

**Zalo's call SRTP key = the first 30 chars of the server-issued `requestcall` `sessId`.** The
client obtains that token over normal (decryptable) signaling and uses it directly with standard
libsrtp. A Linux client with the account can therefore establish call media. **SP1 §E.5 → GO;
proceed to SP2/SP3 (Linux engine).**
