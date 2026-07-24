# zcall InitZRTP wire format + SRTP profile (SP2 2b — real Windows capture)

**Date:** 2026-07-13
**Parent:** [GO verdict — key = requestcall sessId[0:30]](2026-07-13-zcall-keying-GO-verdict.md)
**Method:** captured **4 real 1-1 audio calls** on Windows Zalo (own account → own phone),
`tshark -f "udp port 4200"`; diffed the InitZRTP packets across calls (constant vs per-call
fields) and attempted SRTP media decrypt with `sessId[0:30]`.

> Boundary: own account/machine/phone only; own traffic only. All real values here are
> **redacted/placeholder** — `<CALLER_UID>`, `<CALLEE_UID>`, `<CALLID>`, `<SESSID>`, `<IP>`,
> `<PORT>`. Per-call `sessId`/keys are ephemeral and were never committed; raw pcap/media/sessid
> stayed local (git-ignored).

---

## A. InitZRTP wire format — now fully mapped (was partial in SP1 Appendix C)

The 4 calls give: `fromId`/`toId` **constant** (my account + my phone), `callId`/`sessId`
**varying per call** → this diff pins every field. **Endianness is little-endian** for the
id/callId fields (revises SP1 Appendix C's tentative big-endian read, which came from a 41-byte
loopback sample with tiny ids that were LE/BE-ambiguous).

### A.1 REQUEST — InitZRTP-with-server (type `0x01`, flag `0x7e`, subtype `0x0b`), 185 bytes

```
off  size  field                         endian   evidence (redacted)
0    1     type = 0x01  (ZRTP_REQUEST)             const
1    1     flag = 0x7e  (InitZRTP family)          const  (differs from SP1's 41B sample flag=0x01)
2    8     reserved (all zero)                     const
10   4     fromId  (caller uid)          LE        CONST across calls = <CALLER_UID>  (matches requestcall.fromId)
14   4     reserved (all zero)                     const
18   1     subtype = 0x0b (InitZRTP)               const (probe uses 0x03 — see A.3)
19   2     0x00 0x02  (has-sessId flag/count)      const for InitZRTP (probe = 0x00 0x00)
21   4     callId                        LE        VARIES per call, monotonically increasing = <CALLID>
25   4     toId    (callee uid)          LE        CONST across calls = <CALLEE_UID>  (matches requestcall.toId)
29   2     sessId length = 154           LE u16    const 0x009a = 154
31   154   sessId (ASCII base64url)                VARIES per call = <SESSID>;  sessId[0:30] = SRTP master key
                                                   (= requestcall.sessId — same token; confirmed in GO verdict)
```
Total = 31-byte header + 154-byte sessId = **185**. The client sends this to **each candidate
relay** on `:4200` (identical payload to all candidates in one call).

**Diff verification (4 calls):** `fromId` const ✓, `toId` const ✓, `callId` distinct &
increasing ✓, `sessId` distinct ✓, `sessId len` always 154 ✓.

### A.2 RESPONSE (type `0x02`, flag `0x7e`), ~52–55 bytes

```
off  size  field                         endian   evidence
0    1     type = 0x02  (ZRTP_RESPONSE)            const
1    1     flag = 0x7e                             const
2    8     reserved (zero)                         const
10   4     fromId (echo)                 LE        = <CALLER_UID>
14   4     reserved (zero)                         const
18   3     0x0b 0x00 0x02                          const
21   4     reserved (zero)                         const
25   4     callId (echo)                 LE        = <CALLID> of the request
29   4     probeNonce (echo)                       = the per-relay nonce from the matching probe (A.3)
33   2     addrLen                       LE u16    length of the ASCII below
35   N     ASCII "IP|port"                         the allocated **relay media address**, e.g. "<IP>|<PORT>"
```
So the server's reply = **echo(callId,nonce) + the media relay address as ASCII `IP|port`**.
This is the "onInitZrtpWithServer / onCallChangeZRTP{rtpAddr,rtcpAddr}" surfaced in the engine.

### A.3 Probe / connectivity-check (type `0x01`, flag `0x7e`, subtype `0x03`), 25 bytes

```
0:01  1:7e  2..9:zero  10..13:fromId(LE)  14..17:probeNonce (distinct per candidate relay)
18:03 (probe subtype)  19..20:00 00  21..24:callId(LE)
```
No sessId. Sent to every candidate relay to measure/lock a path; the winning relay's nonce is
echoed in the A.2 response. (This is the ICE-like candidate sweep observed in earlier captures.)

---

## B. SRTP media profile — validation of SP2 2a

### B.1 zrtc AUDIO media frame (type `0x03` = AUDIO_RTP) — wire layout
```
0     1    type = 0x03  (AUDIO_RTP; also seen 0x04/0x05/0x0d/0x0e/0x0f for other sub-streams)
1..4  4    flowToken (per-call; == the probeNonce / a stream id)
5     1    0x90   → looks like an RTP byte0: version=2, extension=1
6     1    0xf1   → marker=1, payloadType=113 (dynamic; opus)
7..8  2    sequence number   BE   (increments +1 per packet)
9..12 4    timestamp         BE   (increments +960 per packet ≈ opus frame)
13..16 4   SSRC = fromId     BE   (= <CALLER_UID>)
17..18 2   0xbe 0xde  (RTP ext profile id "0xBEDE" — one-byte header extensions!)
19..    RTP header extension + encrypted payload + trailer
```
Byte `0xBEDE` at 17..18 is the standard RTP one-byte-header-extension profile marker, confirming
an RTP packet is embedded starting at **offset 5** (wrapped by a 5-byte zrtc prefix `03 + flowToken`).

### B.2 SOLVED (SP2 2c) — the wire↔SRTP mapping, validated `authOk == true`

**Method:** located libsrtp `srtp_protect` in `ZaloCall.exe` via the debug-string xref
(`"%s: function srtp_protect"` @ a `.rdata` VA → the single `push <str>` code site → the
function prologue; RVA `0x56a342` for build 26.6.20). A live cdbX86 self-detaching breakpoint
at entry dumped the **RTP packet passed to `srtp_protect`** (plaintext), then `gu` to the return
dumped the same buffer **after** encryption (the SRTP output). In parallel `tshark` captured the
wire packet + the InitZRTP `sessId` for the same call.

**The mapping (all CONFIRMED):**
```
wire packet  =  [0]=zrtc media type (0x03 AUDIO_RTP)  +  [1..4]=flowToken  +  <standard SRTP packet>
                └──────────────── 5-byte zrtc prefix ────────────────┘        starts at wire offset 5

standard SRTP packet (= srtp_protect output):
  RTP header (unencrypted):  base 12 B  +  0xBEDE ext (1 word) = 20 B total
      v=2, pt=112 (opus), seq (BE @2), timestamp (BE @4), SSRC = fromId (BE @8), ext 0xBEDE 0001 <word>
  encrypted payload:  AES-128-CTR from offset 20
  auth tag:  last 10 bytes  (HMAC-SHA1-80)
  IV      :  RFC-3711 srtpIv(cipherSalt, ssrc=fromId, packetIndex = ROC*2^16 + seq), ROC=0 at start
```

**Validation (matched plaintext ↔ wire, same call):**
- `HMAC-SHA1(authKey, srtp[:-10] || ROC0)[:10]` == the wire tag → **`authOk = true`**.
- keystream `= enc_payload XOR plaintext_payload` == `AES-128-CTR(cipherKey, srtpIv(salt, fromId, seq))`
  **byte-for-byte** → decryption is exactly correct (`ssrc=fromId, roc=0`).
- `node tools/zcall-media/decrypt-capture.js <sessId> media.json` on **raw wire** packets now
  reports **`authOk:true` for 10/10** (`zrtcPrefix:5, tagLen:10, pt:112, opus:true`).

### B.3 Profile (confirmed) + the mid-call re-key

- **Profile = `SRTP_AES128_CM_HMAC_SHA1_80`**, master key = `sessId[0:30]` (16 key + 14 salt),
  standard RFC-3711 KDF. Not GCM. (libsrtp `hmac sha-1` / `cipher key/salt` / `auth key` strings
  are in `ZaloCall.exe`; the earlier "no match" was framing-only — the 5-byte zrtc prefix + a
  stale key, see below — not a crypto unknown.)
- **Mid-call re-key (important for capture):** in one 552-packet audio stream, only the **456
  packets with `seq ≥` the current `sessId`'s first packet authenticated**; the earlier 96 used a
  **different key**. Zalo re-runs InitZRTP and re-keys SRTP during the call, so **each `sessId`
  keys the media from its own InitZRTP onward**. To decrypt a captured segment, use the `sessId`
  from the InitZRTP that immediately precedes it (or track successive InitZRTP `sessId`s and switch
  keys at each boundary). This also explains the SP2-2a "authOk:false" on the first exported
  packets — they predated the captured `sessId`.

### B.4 Adapter shipped

`tools/zcall-media/decrypt-capture.js` gained `isZrtcWrapped()` + a per-packet framing sweep: it
strips the 5-byte zrtc prefix when `pkt[0] ∈ {03,04,05,0d,0e,0f}` and `pkt[5]` is an RTP v2 byte,
then runs the existing `srtp-decrypt`. Output now includes `zrtcPrefix` (0 or 5). Verified on real
wire media: **10/10 authenticated** with `sessId[0:30]`.

---

## C. Deliverables for the Linux engine

- **InitZRTP REQUEST is fully specified (§A.1)** — a Linux engine can build byte-exact InitZRTP
  packets: 31-byte LE header (`01 7e`, zeros, fromId, subtype `0b 00 02`, callId, toId, `9a 00`)
  + the 154-char `sessId`, sent to each `servers[]` candidate on `:4200`; read the relay address
  from the `02 7e` reply (§A.2).
- **Media send/receive is fully specified (§B):** SRTP `AES_CM_128_HMAC_SHA1_80`, master key
  `sessId[0:30]`, wrapped on the wire as `zrtc-type + flowToken[4] + <SRTP packet>`; SSRC = fromId,
  RTP has a `0xBEDE` extension, 10-byte tag, RFC-3711 IV. A Linux engine builds an RTP/opus packet,
  `srtp_protect`s it with libsrtp (that key/profile), prepends the 5-byte zrtc prefix, and sends to
  the relay `:4200`; the receive path reverses it. `decrypt-capture.js` validates the whole chain
  end-to-end on real media (**10/10 authOk**). Track successive InitZRTP `sessId`s for the mid-call
  re-key (§B.3).
- **Nothing remains as a crypto/protocol unknown** for a 1-1 audio call: signaling (GO verdict),
  InitZRTP handshake (§A), and SRTP media (§B) are all specified and validated against the real
  Windows engine. SP2/SP3 is now an engineering build, not RE.

---

## D. SP2 step 2.1 — InitZRTP handshake VALIDATED LIVE ON LINUX (2026-07-13)

The Linux engine (`tools/zcall-media/initzrtp.js` + `handshake.js` + `live-handshake.js`, spec
`../specs/2026-07-13-zcall-sp2-initzrtp-handshake-design.md`) builds the §A.1 REQUEST byte-exact
(LE header + 154-char `sessId`) and sends probe+request to each `servers[]` candidate on `:4200`,
using a **live** config obtained on Linux via `tools/zcall-signaling` (CDP invoke).

**Result (own account → own phone, redacted):** `relaysReplied 6/6` — **all six real VNG relays
accepted the Linux-built InitZRTP and returned a `0x02` reply carrying a media relay address**.
The §A wire format is therefore confirmed against the live relays, not just the Windows capture.

**Refinement:** the `0x02` reply does **not** echo our probe nonce (§A.2 offset 29 is not our
nonce in the request→response path), so reply↔relay correlation + RTT is done by **UDP source
address** (`rinfo.address == target host`) instead of nonce match. The media relay address (the
input to step 2.2) is present and parsed in every reply.

Next: SP2 step 2.2 — SRTP media send/receive (RTP/opus + `srtp_protect` + 5-byte zrtc prefix to
the relay `:4200`; receive path already validated by `tools/zcall-media/decrypt-capture.js`,
authOk 10/10).
