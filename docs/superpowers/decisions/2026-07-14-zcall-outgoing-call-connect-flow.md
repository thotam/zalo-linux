# zcall outgoing-call connect flow — the missing Linux step (real Windows capture)

**Date:** 2026-07-14
**Parent:**
- [InitZRTP wire format + SRTP profile (2b/2c)](2026-07-13-zcall-initzrtp-and-srtp-profile.md)
- [GO verdict — key = requestcall sessId[0:30]](2026-07-13-zcall-keying-GO-verdict.md)
- Spec: [SP2 2.3 call-control signaling](../specs/2026-07-13-zcall-sp2-2.3-call-control-signaling-design.md)

**Method:** captured **2 real, fully-connected 1-1 audio calls** on Windows Zalo 26.6.20
(own account → own phone), `tshark -f "udp port 4200"`, 4823 UDP pkts / 43 s. Diffed the two
calls + all six relay handshakes; correlated every media packet's `flowToken` back to its origin.

> **Boundary:** own account / machine / phone only; own traffic only. All real values below are
> **redacted/placeholder** — `<CALLER_UID>`, `<CALLER_LAN_IP>`, `<CALLER_PUB_IP>`, `<RELAY_n>`,
> `<RELAY_MEDIA_IP>`, `<SPORT_n>`, `<FT_relayN>`, `<NONCE_callN>`, `<SESSID>`, `<CALLEE_SSRC>`.
> The `.pcap`, raw `sessId`, and raw tokens stayed local (git-ignored), never committed.

---

## TL;DR — the single missing step

**Linux sends media with `flowToken = 0x00000000`. The real client stamps each outbound media
packet with a 4-byte `flowToken` that the *relay assigns per call, per relay*, delivered at
offset 29 of the relay's `0x02` InitZRTP response.** With `flowToken = 0` the relay cannot
associate the caller's media with the call, so it (a) drops the caller's audio and (b) never
forwards the callee's audio back → `mediaPkts 0`, and the call never reaches "connected".

Fixing it is a 3-line data-flow change (extract offset 29 → carry it → stamp it). Details in §E + §F.

---

## A. Full caller signal + UDP sequence (one call, relative time)

Signaling (HTTPS `/api/voicecall/*`, from Linux-side knowledge — **not** re-captured here, see
"scope" note) interleaves with the UDP handshake on `:4200`:

```
  t≈0.000   [UDP]   connectivity sweep: 0x01/0x01 keepalive/STUN-ish pkts to candidate relays
  ~call-setup [SIG] requestcall (11300)  -> config { sessId, servers[], fromId, toId, rtpIP }
  t=0.022   [UDP]   InitZRTP REQUEST (0x01 0x7e 0x0b, 185 B) -> EACH of 3 candidate relays  (from <SPORT1>)
  t=0.025   [UDP]   InitZRTP RESPONSE (0x02 0x7e, ~62 B) <- each relay   ← carries per-relay flowToken (§E)
  ~ring     [SIG]   request / sendRequestCall (11301)  -> callee PHONE RINGS
  t=0.406   [UDP]   OUTBOUND media (0x03 + flowToken + SRTP) STARTS -> chosen relay:4200   (during RINGING)
  ~answer   [SIG]   callee ANSWER pushed to caller  (status 1 → 3)
  t=3.036   [UDP]   INBOUND media (0x04 + SRTP) STARTS <- relay:4200    ← relay bridges callee audio = CONNECTED
  ~answer   [SIG]   answerack (11304)
  …audio both ways…
  ~hangup   [SIG]   endcall (11306)
```

**The diff vs Linux is NOT a missing signal.** Linux already does requestcall → request →
answerack and already *reads* the pushed answer. The missing piece lives entirely on the **UDP
media plane**: the `flowToken` (§E) and the exact media destination (§D). See "scope" note for
why the exact signal bodies/timestamps are marked approximate.

## B. `answer` status progression (1 → 3) and the "connected" trigger

- **status 1** = callee side received / ringing (call offered, not yet media-confirmed).
- **status 3** = answered / **connected** — bidirectional media path is live.
- **What corresponds to "connected" on the wire:** the relay starting to forward the **callee's**
  media back to the caller (first `0x04` inbound audio, t=3.0 / t=27.5 in the two calls). Up to
  that instant the caller is *already* streaming outbound `0x03` media (since t=0.4) — i.e. the
  caller does **not** perform a new UDP action at answer; the relay flips from "hold" to "bridge".
- **Hypothesis for Linux's "status 1, never 3":** the transition to 3 needs the caller's media to
  actually reach the callee through the relay. With `flowToken = 0` the relay never delivers the
  caller's audio, so the media path never confirms → the answer stalls at status 1. This ties the
  observed Linux symptom directly to the §E bug (single root cause, not two).

## C. UDP timeline to the relay `:4200`

| Event | Call 1 | Call 2 | Notes |
|---|---|---|---|
| InitZRTP REQUEST (185 B) sent | t=0.022 | t=24.065 | **once per candidate relay** (3×), not repeated/keepalive |
| InitZRTP RESPONSE (62 B) recv | t=0.025 | t=24.069 | one per relay; carries flowToken @29 + media addr @35 |
| First OUTBOUND audio (0x03) | t=0.406 | t=24.353 | **before answer** — caller streams during ringing |
| First INBOUND audio (0x04) | t=3.036 | t=27.495 | **= connected**; relay bridges callee media only after answer |

- **InitZRTP is sent once per relay at call setup**, not repeated. A **new call = new InitZRTP +
  new source port + new flowTokens** (call 2 used a fresh source port `<SPORT2>` and fresh relays).
- **Media starts ~0.4 s after setup, well before answer** (comfort/keepalive audio during ringing).
- **Same source port for InitZRTP and media** within a call (`<SPORT1>` for call 1, `<SPORT2>` for
  call 2). The InitZRTP handshake and all media share one UDP socket — the relay forwards inbound
  media back to that source port. (This is why `media-session.js` runs the handshake on the media
  socket — confirmed correct.)
- **Relay sends callee media back only after the callee answers** (t=3.0 / t=27.5), i.e. ~2.6–3.1 s
  of ringing during which only outbound flows.

### Wire framing — outbound vs inbound are ASYMMETRIC (new finding)

```
OUTBOUND (caller → relay), type 0x03:
  [0]=0x03  [1..4]=flowToken   [5..]=STANDARD SRTP packet (RTP v2 @ offset 5)   SSRC = <CALLER_UID>
            └── per-relay ──┘

INBOUND  (relay → caller), type 0x04:
  [0]=0x04  [1..]=STANDARD SRTP packet (RTP v2 @ offset 1)   ← NO flowToken       SSRC = <CALLEE_SSRC>
```

The relay strips the flowToken when forwarding callee→caller (the caller is identified by the UDP
5-tuple). So **outbound has a 5-byte zrtc prefix (RTP@5); inbound `0x04` has a 1-byte prefix
(RTP@1).** `decrypt-capture.js` must use zrtcPrefix=1 for inbound `0x04` (it currently sweeps
{0,5}; add 1 for `0x04`). (Sub-streams `0x05` also appear — RTCP/secondary; not the audio path.)

## D. `sendRequestCall` (request) addresses & the real media destination

- The `rtpAddress`/`rtcpAddress` advertised in `request` are **candidate hints**, not the operative
  media path. The real rendezvous is **InitZRTP-driven**: media goes to the **relay that answered
  the InitZRTP `0x02`**, i.e. **`rinfo.address : 4200`** (the response's UDP source), *not* to the
  ASCII address embedded inside the response.
- **Important:** the `0x02` response carries an ASCII `"IP|port"` at offset 35 (e.g.
  `<RELAY_MEDIA_IP>|<APORT>`), but the Windows client sent media to the **responder's** IP on
  **:4200**, and received inbound from that same responder:4200 — **it did NOT use the ASCII
  address as the media destination.** The ASCII field is the relay's/peer's allocated endpoint
  (informational); do not send media there.
- `answerack`/`param` fields (receiverId, needACK, …): not re-captured here — see scope note.

## E. flowToken — SOLVED: it comes from the relay's `0x02` InitZRTP response, offset 29

Decoding the `0x02 0x7e` response (redacted; real 6/6 relays agreed on the layout):

```
off  size  field                                  evidence
0    1     type = 0x02                            const
1    1     flag = 0x7e                            const
2    8     reserved (zero)                        const
10   4     fromId (echo, LE) = <CALLER_UID>       = media SSRC (0x0f……)  ✓
14   4     reserved (zero)                        const
18   3     0x0b 0x00 0x02                         const
21   4     reserved (zero)                        const
25   4     nonce            = <NONCE_callN>       PER-CALL (identical across all relays in one call)
29   4     flowToken        = <FT_relayN>         PER-RELAY (distinct per relay) ← THE ANSWER
33   2     addrLen (LE u16)                       length of the ASCII below
35   N     ASCII "IP|port"  = <RELAY_MEDIA_IP>|<APORT>   relay/peer allocated endpoint (NOT media dest, §D)
```

**Proof (redacted):** for every call, the relay actually used returned a distinct non-zero 4-byte
value at offset 29, and **that exact value appeared as bytes [1..4] of every outbound `0x03` media
packet to that relay**, byte-for-byte, same order:

```
call 1, relay R1:  resp[29..32] = <FT_r1>  ==  outbound media [1..4] to R1   ✓
call 1, relay R2:  resp[29..32] = <FT_r2>  (unused relay — its own token)
call 2, relay R3:  resp[29..32] = <FT_r3>  ==  outbound media [1..4] to R3   ✓
call 2, relay R4:  resp[29..32] = <FT_r4>  ==  outbound media [1..4] to R4   ✓  (transition relay)
```

- **flowToken is NOT the probe nonce**, NOT `0x02`-reply-derived-by-us, NOT from the answer param.
  It is **assigned by the relay** and returned at **offset 29** of that relay's `0x02` response.
- This also **resolves the open question** in the 2.1 doc (§D there: "the `0x02` reply does not echo
  our probe nonce; offset 29 is not our nonce"). Correct — offset 29 is the **relay's flowToken**,
  and offset 25 is a **per-call nonce** (what the current parser mislabels `callId`).
- **Linux sends `0x00000000`** (`media-session.js:26` default) → wrong for every relay.

## F. The fix (concrete, Linux engine)

Three data-flow changes; no new crypto/protocol:

1. **`tools/zcall-media/initzrtp.js` `parseResponse`** — return the flowToken. Currently offset
   25→`callId` and offset 29→`probeNonce` are **mislabeled and discarded**. Rename/return:
   `nonce = buf.subarray(25,29)`, **`flowToken = buf.subarray(29,33)`**.
2. **`tools/zcall-media/media-session.js` `open()`** — when a relay's `0x02` reply is selected
   (the relay media will be sent to), capture **its** `flowToken` and set `this.flowToken`
   (instead of leaving the `Buffer.alloc(4)` zero default at line 26). Keep flowToken and media
   destination **from the same relay**.
3. **Media destination** — send to the **responder's** `rinfo.address:4200` (the relay that
   returned the chosen flowToken), not the ASCII `relayAddr` at offset 35, and not blindly
   `ans.rtpSerIp` unless it equals that responder. `send()` already stamps `this.flowToken`
   (`media-session.js:80`), so once (1)+(2) populate it, outbound media is correct.

Expected result: relay associates caller media → forwards to callee → callee media-confirms →
answer status 1→3 → relay bridges callee audio back → `inboundAuthOk ≥ 1`, connected call.

---

## G. Implementation status (2026-07-14)

**Done (TDD, unit-tested on Windows — pure JS, no native dep):**
- `initzrtp.js parseResponse` now returns `nonce` (@25) + **`flowToken` (@29)** — test asserts both
  with distinct values (`initzrtp.test.js`). ✓
- `handshake.js` exposes per-relay `flowToken` + `src` (media dest = `src:relayPort`), dropped the
  dead probe-nonce correlation (`handshake.test.js`). ✓
- `media-session.js open()` captures the chosen relay's flowToken → `this.flowToken`, sets media
  dest to the responder on `relayPort` (added `relayPort` param), resolves `{relayAddr,host,port,
  flowToken}`. New `media-session.test.js` case asserts flowToken capture + responder dest (NOT the
  ASCII @35) + stamped media — **runs on Ubuntu** (needs the `zsrtp` native addon, not built on the
  Windows capture box).
- `live-call.js` / `live-media.js` rewired to the responder:relayPort + per-relay flowToken; removed
  the stale `s.relay` override that would desync flowToken from destination.

**Inbound `0x04` decode — DONE on Ubuntu (TDD, 2026-07-14):** `media-frame.js unwrapZrtc` is now
framing-aware — `0x03` ⇒ 5-byte prefix (flowToken@1..4, SRTP@5); any other type (`0x04` inbound,
etc.) ⇒ 1-byte prefix (SRTP@1, no flowToken). `media-session._onMessage` decodes audio types
`0x03`/`0x04` (skips `0x05`+ sub-streams) and reports `type` in the `media` event.
`decrypt-capture.js framings()` sweeps `{0,1,5}` (adds offset-1 for `0x04`). New
`media-session.test.js` case `testInbound04` (fake relay strips flowToken + retypes `0x03`→`0x04`,
RTP@1) is green; a native protect→frame-as-0x04→`decrypt-capture` check reports `authOk zrtcPrefix=1`.
All 18 offline tests green with the `zsrtp` addon built. **Receive path is now correct for real
relay-forwarded inbound media.**

**Remaining (live, operator-run — needs answering the phone):** confirm end-to-end on a real call —
`node tools/zcall-media/live-call.js <ownCalleeId>` → answer status 3 (connected), `mediaPkts > 0`
(flowToken bridge), and now `inboundAuthOk ≥ 1` (the `0x04` decode). Record the redacted result here.

### G.1 Live result (2026-07-14, Ubuntu) — flowToken NOT sufficient to connect

With the flowToken fix live (`flowToken set` confirmed) + streaming media during ringing (Windows
timeline) + answerAck-on-first-answer: **the CALLEE connects** (phone shows a rising call-duration
timer after tapping answer) and streams, **but the CALLER side never reaches connected**: the diag
log only ever shows `answer` **status 1** (never 3) for our callId, and **`mediaPkts 0`** — the relay
forwards us only its `0x02` InitZRTP echoes, **zero `0x03`/`0x04` media**, even after the callee is
in-call. So the relay does **not** bridge the callee's media to our endpoint.

Conclusion: reaching "connected" (status→3) + the relay opening the caller-direction bridge needs a
**caller-side step the native engine does after receiving the answer** that we have NOT reproduced
(beyond requestcall→request→answerack + InitZRTP + media). The 2026-07-14 capture was **UDP-only**
(§H) and did not record the signaling that drives status→3, so the missing step is still unidentified.
**Decisive next step: capture the SIGNALING of a real connected OUTGOING call on Windows** (enable
CDP by patching the Windows build like Linux's `ZALO_REMOTE_DEBUG`, or mitmproxy) — the exact
`/api/voicecall/*` sequence + `answer`/`answerack` param bodies + any extra caller signal between
`request` and connected — to diff against the Linux flow. (Media-plane is fully solved: keying,
InitZRTP, flowToken, outbound 0x03, inbound 0x04 decode all correct + unit-tested.)

**Verify on Ubuntu:** `node tools/zcall-media/__tests__/media-session.test.js` (green), then
`node tools/zcall-media/live-call.js <ownCalleeId>` → expect the phone to reach **connected**
(answer status 3) and `mediaPkts > 0` (relay bridging — proves the flowToken fix).

## H. Scope / what still needs a signaling capture

This capture is **UDP-only** (`tshark`). It **decisively** answers **C, D (media dest), E** — the
actual connect bug. The Windows **signaling bodies** (exact `/api/voicecall/*` order, timestamps,
`answer`/`answerack` param fields for A/B/D) were **not** re-captured, because the Windows Zalo
26.6.20 is a **clean, unpatched install**: the `--remote-debugging-port` CLI flag is rejected by
the Electron CLI-args fuse (observed: launch exits code 9), and CDP is only enabled by the
`call-diag.js` patch (`ZALO_REMOTE_DEBUG`) which isn't present in this build. A/B/D above are
therefore given from the **Linux-side implementation + the UDP consequences**, and marked
approximate where they depend on unseen signaling. Getting the exact bodies would need re-applying
the CDP patch (or mitmproxy) — **optional**, since the missing step (§E) is already found and
does not depend on it.

> **Correction (2026-07-14, §I capture):** the `--remote-debugging-port` CLI flag is **NOT**
> fuse-blocked on 26.6.20 — it works when the app is launched **interactively by the user**. The
> earlier "exit code 9" was an artifact of launching from the agent's non-interactive shell (no
> desktop/window station), not a fuse rejection. CDP is available on this clean build with no patch.

## I. Connect signaling sequence (caller side) — SOLVED via mitmproxy + CDP zpw-decrypt

**Method:** system-proxy → mitmproxy captured the full HTTPS + WebSocket of one real **connected**
outgoing 1-1 audio call (own account → own phone). The zpw `params`/`data` (AES-128-CBC, IV=0,
key=`Base64(getSecretKey())`) were decrypted offline with the session `secretKey` read via CDP.
All real values below are **redacted**; the decrypted capture stayed local (git-ignored).

### I.1 Caller signal sequence (relative time)

```
t=0.00   voicecall/requestcall   HTTP GET  caller→   (allocate call; response = full call config)
  … ~1.4s: InitZRTP probe sweep of all servers[] on :4200 (UDP, §A/§C) — measures per-relay reachability …
t=1.41   voicecall/request       HTTP GET  caller→   RINGS callee  (carries the probe results — see I.3)
t=4.70   ANSWER push             WS  →caller  (ws5-msg.chat.zalo.me, binary; status transition)
t=4.79   voicecall/answerack     HTTP GET  caller→   (ack; {calleeId,callId,status:0,imei})
t=4.85   ack push                WS  →caller
t=26.6   voicecall/logendcall    HTTP GET  caller→   (end-of-call stats log)
```

**Endpoint set = `requestcall → request → answerack` (+ `logendcall`).** This is the **same set
Linux already sends**. There are **ZERO client→server WebSocket messages** in the entire call (all
7 WS frames are inbound pushes). **So the missing step is NOT a signal/endpoint Linux omits.**

### I.2 answerack (caller→) — NOT the differentiator

```
params: { calleeId:<CALLEE_ID_STR>, callId:<CALLID>, status:0, imei:<IMEI> }
```
Linux `sendAnswerACKCall(calleeId, callId)` produces the same (± `status:0`). Not the cause.

### I.3 request / sendRequestCall (caller→) — THE DIFFERENCE (decrypted, redacted)

```
params: {
  calleeId:    <CALLEE_ID_STR>,
  rtpAddress:  "<RELAY_SEL>:4200",          ← the PROBE-SELECTED best relay, NOT config.rtpIP default
  rtcpAddress: "<RELAY_SEL>:4200",
  codec:       "[{\"name\":\"opus/16000/1\",\"payload\":112,\"frmPtime\":20,\"dynamicFptime\":0}]",
  session:     <SESSID>,                     ← = requestcall sessId
  callId:      <CALLID>,
  imei:        <IMEI>,
  subCommand:  3,                            ← set BECAUSE extendData is present
  extendData:  "{…JSON below…}"
}

extendData (decrypted): {
  callType:0, newZrtc:1, packetMode:2, platform:2, srtpMode:1, spTcp:1, srtcp:0,
  supportCallBusy:1, supportHevcDecode:1, tpType:0, maxFT:60, gccMode:1, gccAudio:1,
  p2p: [ {ip:"<LAN_IP>",port:<P2P_PORT>,type:0}, …, {ip:"<CALLER_PUB_IP>",port:<P2P_PORT>,type:1} ],  ← ICE-like local candidates
  serverAddr:  [ {rtp:"<RELAY_SEL>:4200", rtcp:"<RELAY_SEL>:4200", rtpIPv6:"…", tpType:0} ],           ← the SELECTED relay
  serverResult:[ {rtp:"<RELAY_SEL>:4200", recv:14, rtt:203, spTcp:1, tpType:0},                        ← per-relay InitZRTP
                 {rtp:"<RELAY_2>:4200",  recv:11, rtt:157, …},                                          probe results
                 {rtp:"<RELAY_3>:4200",  recv:2,  rtt:15,  …},
                 {rtp:"<RELAY_4>:4200",  recv:1,  rtt:6,   …} ],
  video:{ codec:[{name:"h264",payload:97}] }
}
```

**What Linux sends instead** (`tools/zcall-signaling/call-control.js` `buildRingArgs`, `addrSource:'config'`):
`rtpAddress/rtcpAddress = config.rtpIP` (server-suggested DEFAULT, not the selected relay),
`codec = '[]'`, `extendData = ''` (so `subCommand` is not 3). **All three are empty/wrong.**

### I.4 Conclusion — the missing Linux step

The server builds the **relay media-bridge** from the caller's `request.extendData.serverResult`
+ `serverAddr` + `rtpAddress` — i.e. the caller reports *which relays it probed via InitZRTP, their
reachability (`recv`/`rtt`), and the relay it selected*. The server then instructs that relay to
bridge the callee's media back to the caller and pushes **status → 3 (connected)**.

Linux rings with `extendData=''`, `codec='[]'`, and the DEFAULT `rtpAddress`, so the server never
learns the caller's real media path → it cannot set up the bridge → **callee media never returns
(`mediaPkts 0`) and the caller stays at status 1** — exactly the observed symptom. The flowToken /
InitZRTP / SRTP media plane (§C–§G) is correct; this signaling-content gap is the remaining blocker.

**Fix (Linux `sendRequestCall`):** after the InitZRTP probe sweep (already run in `MediaSession.open()`),
build a real `extendData` — `serverResult` (each replying relay with a `recv`/`rtt`, from the probe),
`serverAddr` (the selected best relay), `p2p` (local candidate IPs incl. the public-reflexive one),
`srtpMode:1`, `newZrtc:1` — pass the **selected** relay as `rtpAddress`/`rtcpAddress` (not
`config.rtpIP`), the real opus `codec`, and `subCommand:3`. Selection = the relay with the best
InitZRTP echo (`recv`/rating). This makes the server bridge media and push connected. Media-plane
code is unchanged.

### I.5 Implemented on Ubuntu (2026-07-14, TDD)

- `MediaSession.open()` now sends the InitZRTP request + several probes per relay, counts `0x02`
  replies (`recv`) and measures `rtt`, and resolves `{ selected, results, flowToken, host, port }`
  (per-relay `{host,recv,rtt,flowToken}`). Selects `preferHost` if it replied, else highest
  `recv`/lowest `rtt`; sets `this.relay` + `this.flowToken` from the selected reply.
- `call-control.js`: `buildExtendData({results, selectedHost, p2p})` → the §I.3 object
  (`serverResult`/`serverAddr`/`p2p` + `srtpMode:1,newZrtc:1,…` + h264 video); `OPUS_CODEC` const;
  `buildRingArgs`/`ring` take `rtpAddress` (selected relay), `codec`, `extendData` (object→JSON, so
  the app sets `subCommand:3`). Unit-tested (`call-control.test.js`).
- `live-call.js` builds `extendData` from `open()`'s probe results + local LAN candidates (on the
  media source port) and rings with the selected relay + `OPUS_CODEC` + `extendData`.
- All offline tests green.

### I.6 LIVE VALIDATED — connected call, real peer audio decrypted on Linux (2026-07-14) ✅

Two real 1-1 audio calls (own account → own phone), operator answered + held ~15 s:
```
[live-call][diag] mediaRelay <RELAY>:4200  flowToken set  relaysProbed 6/7
[live-call] rang ok — ANSWER on your phone…
[live-call] answer seen (status 0) -> answerAck sent
[live-call][seq] ring_ring -> ring_ring -> answer(sess) -> mute_audio
[live-call] inboundAuthOk 754 / 772   authfail 0     ← real peer SRTP audio decrypted, ZERO failures
[live-call] OK — decrypted peer real media on Linux 🎉
```
The `request.extendData` (serverResult/serverAddr/p2p + opus codec + selected relay) was the missing
step: the call now **connects** (callee answers, relay bridges) and the caller receives + decrypts the
callee's real audio — **754 / 772 SRTP `0x04` packets, 0 authfail**, keyed with `sessId[0:30]`. The
entire 1-1 audio media plane (signaling → keying → InitZRTP → connect → flowToken → SRTP send/recv)
is **proven end-to-end on Linux against a live connected call.** Remaining to *hear* audio: opus
decode of the decrypted RTP payloads (step 3) + mic capture/encode for the send direction; then wire
into `$zcall` (step 4).

