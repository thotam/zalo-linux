# zcall SP1 — ZRTC protocol RE + feasibility spike

Date: 2026-07-11
Status: SP1 COMPLETE — see Appendix E (Go/No-Go: CONDITIONAL). Verdict, blockers, and SP2–SP6 gate documented.
Parent goal: real voice/video Zalo calls on Linux (see "Decomposition")

## Context

`app/native/nativelibs/zcall/zcall_mac.node` is a 7.3 MB Mach-O node addon: a full
real-time voice/video calling engine. String/symbol mining shows it is **Google WebRTC**
(`webrtc` ×9071) wrapped by Zalo's proprietary **ZRTC** C++ layer (`zrtc` ×2636:
`ZRtcConfig`, `ZRtcStats`, `ZRtcNetworkWorkerData`, `ZRtcDesktopCapturer`, `ZRtcCallback`,
`ZRTC_VIDEO_ONLY`), with its own wire transport (`ZRTPPacket`, `ZRTPServerInfo`,
`ZRTPPing`, `ZRTPTimeout` = "Zalo RTP", not necessarily RFC-6189). Codecs: Opus, SILK,
iSAC (audio); x264/OpenH264, VP8, VP9 (video). Audio processing: AEC, AGC, jitter buffer.
It links macOS media frameworks (AVFoundation, CoreAudio/AudioUnit/AudioToolbox,
CoreVideo/CoreMedia, IOSurface, OpenGL). The JS API is `MainApp()` → an ObjectWrap
instance driven by `vcmac.js`/`index.js`.

Porting this to run **real calls** on Linux is the largest, riskiest component of the
whole port: WebRTC-for-Linux + the reversed ZRTC transport + Linux media I/O
(PipeWire/PulseAudio + V4L2) + the codec set. It is multi-month and interop with Zalo's
servers/peers is unproven until the protocol is understood.

## Decomposition (parent goal → sub-projects)

| # | Sub-project | Role |
|---|---|---|
| **SP1** | **ZRTC protocol RE + feasibility spike** (this spec) | Reverse the proprietary transport/signaling + API/JSON contracts; identify the WebRTC fork; produce a **go/no-go**. |
| SP2 | WebRTC engine for Linux | Obtain/build a compatible WebRTC (Opus/SILK/iSAC/H264/VP8/VP9) for linux-x64. |
| SP3 | ZRTC transport re-implementation | Rebuild the reversed protocol (SP1), wired to WebRTC. |
| SP4 | Linux media I/O | Audio (PipeWire/PulseAudio), camera (V4L2), video-frame→canvas, desktop capture. |
| SP5 | Node API binding + call state machine | The ~30-method surface wiring JS ↔ engine. |
| SP6 | Integration + real-call verification | Place/receive a real Zalo call. |

SP1 is the foundation and gate. SP2–SP6 are **not** committed until SP1's go/no-go.

## SP1 objective & scope boundary

Produce a protocol + API-contract spec detailed enough to (a) decide **go/no-go** on real
Linux-call interop, and (b) feed SP3's transport re-implementation, plus pin the exact
WebRTC fork/version for SP2.

**Out of scope for SP1:** building WebRTC, any Linux media I/O, any Linux implementation
of the engine, decrypting/renderer of live media. SP1 is analysis + a spec + a PoC packet
parser only.

## In scope — what to reverse

1. **Native API contract** — exact signatures + argument/return JSON shapes of all
   `MainApp()` instance methods used by `vcmac.js`:
   `test`, `setConfig(configJson,userId,partnerId,protocol,callId,genSession,config,enableChangeZRTP,isVideoCall,logPath,osInfo,clientVersion)`,
   `setMediaConfig(audioConfig,extendData)`, `setListServers(json)`,
   `setConfigServer(rtcpIP,rtpIP)`, `setState(session,genPeerId,config)`,
   `setCallback(cb)`, `makeCall()`, `incomingCall()`, `updateCallerInfo(audioConfig,extendData)`,
   `mute(b)`, `holdAudio(hold,local)`, `stopCapture(b)`, `getCallInfo()`,
   `getJsonStats406(startNet,endNet)`, `getExtendData()`, `getActiveAudioCodecs()`,
   `getListDevices()`, `changeAudioDevice(in,out)`, `setAudioVolume(in,out)`,
   `changeVideoDevice(id)`, `setAgc(b)`, `startDesktopCapture()`, `stopDesktopCapture()`,
   `changeMinMaxMobileBitrate()`, `getVideoFrame(buf)`, `getVideoFrameLocal(buf)`,
   `getEventMessage()`, `stop()`.
2. **`ZRTPPacket` wire format** — header layout, packet types, framing, sequence/SSRC,
   how RTP/RTCP and control (ping/keepalive/handshake) are multiplexed.
3. **Signaling / handshake** — `makeCall`/`incomingCall` → server selection
   (`ZRTPServerInfo` compare, the `servers[]` rtpaddr/rtcpaddr list), `ZRTPPing`/`ZRTPTimeout`
   keepalive, RTP/RTCP start; the ZRTP key-exchange (Zalo variant vs RFC-6189).
4. **Config contract** — the `setConfig` JSON (`settings`, `servers`, `fec.tableLookup`,
   `changeZRTP`, `zrtc_config`) and the `/zls?action=call_config` server response
   (`getConfigState`).
5. **Event protocol** — `getEventMessage()` polled JSON events (the call state machine
   the renderer consumes via `callbackEventMessage`).
6. **Stats** — `getJsonStats406()` JSON shape.
7. **WebRTC identity** — exact version/fork + codec inventory (needed for SP2).

## Method — hybrid (dynamic ground-truth + static fill-in)

### Dynamic (GitHub Actions `runs-on: macos-latest`)
A CI workflow builds a Node harness that loads `zcall_mac.node` on a real macOS runner and
drives a controlled call:
- `MainApp().test(123)` sanity (expect `123`).
- `setConfig(...)` using the sample config embedded in `index.js` (`testConnect`), but with
  the RTP/RTCP server addresses **pointed at a controlled capture endpoint on the runner**
  (we own the config, so no Zalo infra is touched).
- `setCallback(cb)` + poll `getEventMessage()`; call `makeCall()`.
- **Capture**: `tcpdump` on the relevant interface/UDP ports → `pcap` of the emitted
  `ZRTPPacket`s; JSON logs of `getEventMessage`, `getCallInfo`, `getJsonStats406`,
  `getActiveAudioCodecs`, `getListDevices`; the addon's own `call.log`.
- Optional minimal **UDP responder** on the runner to advance the handshake past the first
  packet (so we observe more of the sequence).
- Native symbol/link dumps from the runner: `otool -L`, `otool -tvV` (targeted),
  `nm -pa`, to feed the static pass.
- Upload all artifacts (pcap + JSON + symbol dumps).

### Static (Linux, radare2 / rizin — reads Mach-O)
- Disassemble `ZRTPPacket` serialize/parse, `ZRtcConfig`, the server-compare/selection,
  `ZRtcNetworkWorkerData`, the packet-type enum, and the ZRTP state machine.
- Cross-validate the recovered layout against the captured bytes.
- Recover the WebRTC version/fork and codec list from symbols/strings.

Cross-validation between the two passes is what makes a proprietary-protocol RE trustworthy.

## Deliverables

- **This spec** (committed).
- A follow-on **protocol spec** section/appendix filled from the RE: `ZRTPPacket` layout,
  handshake sequence diagram, config/event/stats JSON schemas, API contract table.
- `.github/workflows/zcall-capture.yml` (macos-latest harness) + a `scratch/zcall-analysis/`
  (or docs) area holding captured **artifacts** (pcap, JSON logs, symbol dumps) — the
  original `zcall_mac.node` binary is NOT re-committed.
- A **PoC `ZRTPPacket` parser** (and encoder if feasible) validating the wire format against
  a real captured packet.
- **WebRTC version/fork identification** + codec inventory.
- A **Go/No-Go report**: is real-call interop on Linux feasible, at what effort, with what
  blockers, and a recommended SP2–SP6 order.

## Success criteria

- All ~30 API method contracts documented (arguments + return JSON shapes).
- `ZRTPPacket` wire format documented **and** the PoC parser decodes a real captured packet.
- The `makeCall` outbound handshake sequence mapped (server selection → first packets →
  keepalive), with the ZRTP key-exchange characterised (standard vs Zalo variant).
- WebRTC version/fork + codec set identified.
- A clear go/no-go with an effort estimate for SP2–SP6.

## Risks / unknowns

- **Capture stalls without a peer** — a driven `makeCall` may not progress far without an
  answering endpoint. Mitigation: the minimal UDP responder; otherwise accept outbound-only
  handshake capture, which still reveals packet format + server selection + keepalive.
- **ZRTP crypto** may block decoding media payloads. SP1 targets transport/signaling
  *structure*, not media decryption, so this is acceptable for the go/no-go.
- **Runner lacks camera/mic** — media capture calls may error; the signaling/handshake path
  is still observable (packets are emitted before media is fully up). `getListDevices` may
  return empty on CI.
- **Server-side anti-abuse / login** — we avoid Zalo infra by pointing RTP at our own
  endpoint and avoid real-account login where possible; if a login/token is unavoidable for
  a code path, note it as a blocker rather than automating account abuse.
- **Legal / ToS** — SP1 only captures packets emitted by a binary **we drive**, pointed at
  **endpoints we control**. It does not attack or probe Zalo infrastructure. This is
  standard interoperability reverse-engineering of a client we possess.
- **Stripped binary** — symbols are partly stripped; the C++ mangled fragments
  (`ZRtc*`, `ZRTP*`) give class/method structure but function bodies need disassembly. radare2
  on Mach-O + runner `nm`/`otool` mitigate this.

## Definition of done (SP1)

The spec's protocol appendix is filled, the PoC parser decodes a real packet, the WebRTC
fork is identified, and the go/no-go report gives a clear recommendation (and, if "go", the
SP2 starting point). No Linux engine code is written in SP1.

## Appendix A — WebRTC identity + codec inventory

Produced by `tools/zcall-re/static/harvest.sh` (rabin2 static harvest of
`app/native/nativelibs/zcall/zcall_mac.node`) on 2026-07-11. Raw output lives in the
gitignored `scratch/zcall-analysis/` (`symbols.txt`, `strings.txt`, `webrtc-version.txt`,
`codecs.txt`) and is not re-committed; the numbers below are copied verbatim from those
files.

**Harvest size:** `symbols.txt` = 35209 lines (all symbols, matches the binary's known
symbol count — the binary is not stripped). `strings.txt` = 90768 lines.

### WebRTC version/branch/commit — no explicit stamp found

`webrtc-version.txt` is **empty**: none of `WebRTC/M[0-9]+`, `branch-heads/[0-9]+`,
`Cr-Commit-Position`, `src/out/...`, `webrtcM[0-9]+`, or a `version ... webrtc` string
appear anywhere in `strings.txt`. There is no official Chromium/WebRTC build stamp baked
into this binary. This is expected: the binary is Zalo's own build of a vendored,
Zalo-patched tree (see below), not an unmodified upstream checkout, so upstream's usual
stamping never ran (or was stripped).

In the absence of a literal stamp, version/vintage is **inferred** from source-path
fragments and symbol names embedded in the strings (compiler `__FILE__`/assert-path
literals), specifically 127 occurrences of paths of the form
`../../../zrtc/webrtc/<module>/<file>.cc`. Findings:

- **Vendor layout**: top-level dirs under `zrtc/` are `bw_estimate`, `codec`, `common`,
  `conference`, `device`, `network`, `talk`, `webrtc`, `zcommon`. So Zalo's ZRTC wraps a
  vendored copy of WebRTC at `zrtc/webrtc/*` **plus** a separately vendored `zrtc/talk/*`
  (libjingle). Symbol names confirm the libjingle `cricket::` namespace is still in use
  (`cricket::kVp8CodecName`, `cricket::kVp9CodecName`, `cricket::kDefaultVp8PlType`,
  `cricket::kDefaultRtxVp8PlType`, `cricket::WebRtcVideoCapturer`) — i.e. `talk/` had not
  yet been folded into `webrtc/pc` + `webrtc/media` at the point this tree was forked.
- **`webrtc/base/` file naming is pre-rename**: paths present include
  `asyncinvoker.cc`, `bitbuffer.cc`, `event.cc`, `event_tracer.cc`,
  `filerotatingstream.cc`, `fileutils.cc`, `logging.cc`, `macutils.cc`,
  `macwindowpicker.cc`, `messagequeue.cc`, `physicalsocketserver.cc`,
  `platform_thread.cc`, `stream.cc`, `systeminfo.cc`, `thread.cc`, `unixfilesystem.cc` —
  all **without** underscores between words. Upstream WebRTC renamed these `webrtc/base/`
  files to underscore_case (e.g. `physical_socket_server.cc`) in a 2016 cleanup. Their
  absence here places this vendor snapshot **before that rename**.
- **Modules present that were later removed upstream**: `modules/audio_processing/beamformer/*`
  (`nonlinear_beamformer.cc`, `array_util.cc`, `covariance_matrix_generator.cc`,
  `matrix.h`) and `modules/audio_processing/intelligibility/intelligibility_enhancer.cc`
  — both subsystems were removed from upstream WebRTC in later years, consistent with an
  older (roughly 2015–2016-era) snapshot of the audio_processing module.
- **Caveat — mixed freshness, not a single clean snapshot**: the string `libopus 1.2.1` is
  present verbatim (see codec section below); upstream libopus 1.2.1 shipped in 2017,
  which postdates the `webrtc/base` naming evidence above. This means Zalo's fork does
  **not** track one single upstream WebRTC release — it appears to be a long-lived,
  selectively-patched vendor branch where individual third-party libs (at least Opus)
  were bumped independently of the core `webrtc/base`/`talk` layer. No single WebRTC
  milestone number can be honestly assigned from static evidence alone; the dynamic pass
  (macOS CI harness, not run in Task 1) would need to hit a runtime version-query API
  (e.g. any embedded field-trial/version accessor) to get a firmer answer.
- One stray `Chromium` string (singular, `0x446066`) exists with no adjacent version —
  not a build stamp, likely an unrelated literal (comment/UA-like string fragment).

### Codec inventory

From `codecs.txt` (case-folded occurrence counts of each codec token across all strings,
sorted descending):

| token | occurrences |
|---|---|
| x264 | 1778 |
| silk | 545 |
| opus | 254 |
| h264 | 135 |
| libopus | 132 |
| vp8 | 82 |
| vp9 | 67 |
| isac | 44 |
| openh264 | 7 |
| ilbc | 5 |

Cross-checked against symbol names (not just strings):
- **Opus**: `libopus 1.2.1` found verbatim in strings — exact upstream version pinned.
- **VP8/VP9**: confirmed via symbols, not just string hits — e.g.
  `webrtc::RtpPacketizerVp8::WriteHeaderAndPayload`, `cricket::kVp8CodecName`,
  `cricket::kVp9CodecName`, `zrtc::ConstParams::VP8_QP_MAX`. 61 symbol lines match `vp8`,
  42 match `vp9` (case-insensitive, includes both VP8 and H.264/related noise from `vp8`
  substring, so treat as an upper bound).
- **iSAC**: full `WebRtcIsac_*` internal function set present (`Isac_AllpassFilterForDec`,
  `Isac_AllPoleFilter`, `Isac_AllZeroFilter`, `Isac_AutoCorr`, `Isac_BwExpand`,
  `Isac_DecimateAllpass`, ...) plus `IsacCodecNameE`/`IsacBandwidthInfoE` — this is the
  real ACM iSAC codec, not just a string mention.
- **SILK**: 545 string hits (Opus's SILK sub-mode is included/counted separately here per
  the harvest script's grep, since `opus` and `silk` are independent tokens).
- **iLBC**: only 5 hits — present but minor/possibly a stub or rarely-referenced path;
  worth confirming with symbol-level disassembly in a later task, not assumed fully wired.
- **x264**: full internal symbol set present (`_x264_predict_8x8_ddr_c`,
  `_x264_pixel_var2_8x8_sse2`, `_x264_cpu_detect`, `X264EncoderImplE`, SSE2/SSSE3/AVX/AVX2
  variants, etc.) — a real, complete x264 encoder is linked in, not just OpenH264. No
  `X264_VERSION`/`x264 - core NNN` banner string was found, so the exact x264 release is
  **not** statically determinable from strings; would need disassembly of
  `x264_encoder_open`'s default param table or the compiled-in `X264_POINTVER` constant.
- **OpenH264**: present (`OpenH264] this = 0x%p, ...` log-prefix strings,
  `openh264 codec version = %s` format string) but its version is resolved **at runtime**
  via an API call (`%s` placeholder) — not a compile-time literal, so it cannot be pinned
  statically either.
- No `libvpx`/`vpx` version banner string was found (grep for `vpx`/`libvpx` in
  `strings.txt` returned nothing), despite VP8/VP9 symbols being present — same
  limitation as x264/OpenH264: codec presence is certain, exact upstream lib version is
  not statically recoverable from strings and needs disassembly or the dynamic pass.

### Summary for SP2

Confirmed codec set to target for a Linux WebRTC build: **Opus (libopus 1.2.1 pinned),
SILK, iSAC, iLBC (audio)**; **x264, OpenH264, VP8, VP9 (video)**. No single upstream
WebRTC milestone can be assigned; SP2 should treat this as a bespoke, long-lived
Zalo-patched fork (pre-2016 `webrtc/base` layout, but with at least Opus bumped to a
2017-era release) rather than assume drop-in compatibility with any specific upstream
WebRTC release branch. The dynamic (macOS CI) pass remains the way to get a firmer
version signal, e.g. via any runtime version/field-trial accessor exposed through
`MainApp()`.

## Appendix B — Native API method table

Produced by `tools/zcall-re/static/methods.sh` against `scratch/zcall-analysis/symbols.txt`
(Task 1's harvest) on 2026-07-11/12. Raw mapping lives in the gitignored
`scratch/zcall-analysis/methods.txt`; the table below is copied verbatim from that file.

**Class layout discovered:** the JS `ZMacCall.MainApp()` (in `binding.js`) is a Nan
`ObjectWrap` named `zvcm::MainAppWrapper` (symbols `__ZN4zvcm14MainAppWrapper4InitE...`
at `0x000069c8` = V8 prototype registration, `__ZN4zvcm14MainAppWrapper3NewE...` at
`0x00006e62` = constructor). Every JS method on `vcmac.js`'s `this.instance` has a
matching `zvcm::MainAppWrapper::<method>(Nan::FunctionCallbackInfo<v8::Value> const&)`
glue method, which in turn calls straight through to a same-named method on the plain
C++ engine facade `MainApp::<method>(...)` (no `zvcm::` namespace, no Nan args) — and for
most methods `MainApp::<method>` itself just forwards to `AppModel::<method>`, and for a
handful of call-control methods (`makeCall`, `incomingCall`, `updateCallerInfo`) further
down to `zrtc::Peer::<method>` / `zrtc::CallController::<method>`. So the JS→native call
chain is consistently **`zvcm::MainAppWrapper` (Nan glue) → `MainApp` (facade) →
`AppModel`/`zrtc::Peer`/`zrtc::CallController` (engine)**.

**Script bugs found and fixed while running this task** (kept the brief's overall
structure/`METHODS` list/`r2` tail dump, fixed the matching logic):
1. The brief's `grep -aiE "\b${m}\b"` can never match inside an Itanium-mangled C++ symbol
   (e.g. `__ZN4zvcm14MainAppWrapper4testERKN3Nan...`) because Itanium mangling encodes
   identifiers as `<length><name>` with **no separator** — every character immediately
   around the name is itself a "word" character, so `\b` never finds a boundary there.
   Verbatim, this made every one of the 29 methods report `<none>`. Fixed by matching the
   exact mangled form `<len(name)><name>E` (how a name terminates right before the
   nested-name-specifier's `E`), with the original `\b`-based grep kept only as a fallback
   for non-mangled/C-style exports.
2. Under `set -euo pipefail`, `hits=$(grep ... | head -3 | tr ...)` aborted the whole
   script on the *first* miss: `grep` finding zero matches makes the pipeline's exit
   status non-zero even though `head`/`tr` both succeed downstream, and `pipefail`
   propagates that into the assignment, tripping `set -e`. Fixed with `|| true` on both
   `hits=$(...)` assignments so a miss falls through to `<none>` instead of killing the
   loop before it produces any output.
3. The de-dup filter `grep -viE 'setState[a-z]|getState'` (meant to strip an old
   substring search's false positives) was, with `-i`, also treating the mangling
   terminator letter `E` right after `8setState` as matching `[A-Za-z]`, so it silently
   deleted the one genuine `setState` hit. Removed for the primary (exact) pattern; it's
   no longer needed since the length-prefixed match has no such false-positive problem.

**Result: 29/29 methods resolved to a concrete native symbol; `<none>` count = 0.**
(`~30` in the task framing; `vcmac.js` calls exactly 29 distinct live `this.instance.*`
methods — `testBuffer` also exists on the wrapper but is only referenced in a commented-out
line inside `check()`, so it is intentionally excluded from the 29.)

| JS method | JS signature (from `vcmac.js`) | Native symbol (address) | Notes |
|---|---|---|---|
| `test` | `test(123)` (sanity ping in `check()`, expects echo `123`) | `zvcm::MainAppWrapper::test` (`0x000074f4`) | Debug-only smoke test; not part of the call flow. |
| `setConfig` | `setConfig(configJson, userId, partnerId, protocol, callId, genSession, config, enableChangeZRTP, isVideoCall, logPath, osInfo, clientVersion)` (12 args) | `zvcm::MainAppWrapper::setConfig` (`0x00008140`) | Delegates to `MainApp::setConfig` (`0x000025ca`). Central call-setup entry point. |
| `setMediaConfig` | `setMediaConfig(audioConfig, extendData)` | `zvcm::MainAppWrapper::setMediaConfig` (`0x00007b6a`) | Delegates to `MainApp::setMediaConfig` (`0x00002328`). Only called for the callee (`!caller`) path in `setConfigData`. |
| `setListServers` | `setListServers(JSON.stringify(servers))` | `zvcm::MainAppWrapper::setListServers` (`0x00007ff2`) | Delegates to `MainApp::setListServers` (`0x000025b8`). Caller-side ICE/relay server list. |
| `setConfigServer` | `setConfigServer(rtcpIP, rtpIP)` | `zvcm::MainAppWrapper::setConfigServer` (`0x00007dae`) | Delegates to `MainApp::setConfigServer` (`0x00002084`). Used when no server list is present. |
| `setState` | `setState(session, genPeerId, config)` | `zvcm::MainAppWrapper::setState` (`0x00007280`) | Delegates to `MainApp::setState` (`0x00001b5c`) → `AppModel::setState` (`0x00004162`). Only fired after auth session + config are both populated. |
| `setCallback` | `setCallback(callback)` | `zvcm::MainAppWrapper::setCallback` (`0x000075f0`) | Delegates to `MainApp::setCallback` (`0x000030d6`) → `AppModel::setCallback` (`0x0000436a`). Registers the JS `onEventFire` poll callback. |
| `makeCall` | `makeCall()` | `zvcm::MainAppWrapper::makeCall` (`0x00007210`) | Delegates to `MainApp::makeCall` (`0x00002f9a`) → `zrtc::Peer::makeCall` (`0x00211ce0`). Caller-side call initiation. |
| `incomingCall` | `incomingCall()` (note: JS `incomingCall(data)` ignores `data` and calls the native method with no args) | `zvcm::MainAppWrapper::incomingCall` (`0x00007248`) | Delegates to `MainApp::incomingCall` (`0x000019d6`) → `zrtc::Peer::incomingCall` (`0x00213370`). |
| `updateCallerInfo` | `updateCallerInfo(audioConfig, extendData)` | `zvcm::MainAppWrapper::updateCallerInfo` (`0x00008a8a`) | Delegates to `MainApp::updateCallerInfo` (`0x00001de8`) → `AppModel::updateCallerInfo` (`0x000045b8`, takes `zrtc::MediaCodecInfo*`). |
| `mute` | `mute(isMute)` | `zvcm::MainAppWrapper::mute` (`0x00008d3e`) | Delegates to `MainApp::mute` (`0x00003286`) → `AppModel::mute` (`0x00005a32`). |
| `holdAudio` | `holdAudio(hold, local = false)` | `zvcm::MainAppWrapper::holdAudio` (`0x00008da4`) | Delegates to `MainApp::holdAudio` (`0x00003294`) → `AppModel::holdAudio` (`0x00005b9c`). |
| `stopCapture` | `stopCapture(isStop)` | `zvcm::MainAppWrapper::stopCapture` (`0x0000947e`) | Delegates to `MainApp::stopCapture` (`0x00003338`) → `AppModel::stopCapture` (`0x00005c14`). |
| `getCallInfo` | `getCallInfo()` | `zvcm::MainAppWrapper::getCallInfo` (`0x00009096`) | Delegates to `MainApp::getCallInfo` (`0x00003302`) → `AppModel::getCallInfo` (`0x00005bce`) → `zrtc::Peer::getCallInfo`. |
| `getJsonStats406` | `getJsonStats406(startNetworkType = 0, endNetworkType = 0)` | `zvcm::MainAppWrapper::getJsonStats406` (`0x00008e3a`) | Delegates to `MainApp::getJsonStats406` (`0x000032a6`) → `AppModel::getJsonStats406` (`0x00005bb2`) → `zrtc::Peer::getJsonStats406` → `zrtc::CallController::getJsonStats`. Deepest delegation chain found. |
| `getExtendData` | `getExtendData()` | `zvcm::MainAppWrapper::getExtendData` (`0x00008986`) | Delegates to `MainApp::getExtendData` (`0x000031a0`) → `AppModel::getExtendData` (`0x000058e6`) → `zrtc::Peer::getExtendData` → `zrtc::CallController::getExtendData`. |
| `getActiveAudioCodecs` | `getActiveAudioCodecs()` | `zvcm::MainAppWrapper::getActiveAudioCodecs` (`0x00007a66`) | Delegates to `MainApp::getActiveAudioCodecs` (`0x000031b8`) → `AppModel::getActiveAudioCodecs` (`0x000058ca`). |
| `getListDevices` | `getListDevices()` | `zvcm::MainAppWrapper::getListDevices` (`0x00008f92`) | Delegates to `MainApp::getListDevices` (`0x000032ea`) → `AppModel::getListDevices` (`0x00003c40`). |
| `changeAudioDevice` | `changeAudioDevice(inputId, outputId)` | `zvcm::MainAppWrapper::changeAudioDevice` (`0x0000919a`) | Delegates to `MainApp::changeAudioDevice` (`0x000032be`) → `AppModel::changeAudioDevice` (`0x00003e0a`). |
| `setAudioVolume` | `setAudioVolume(input, output)` | `zvcm::MainAppWrapper::setAudioVolume` (`0x000093e6`) | Delegates to `MainApp::setAudioVolume` (`0x000032c8`) → `AppModel::setAudioVolume` (`0x00004154`). |
| `changeVideoDevice` | `changeVideoDevice(id)` | `zvcm::MainAppWrapper::changeVideoDevice` (`0x00009232`) | Delegates to `MainApp::changeVideoDevice` (`0x000032d2`) → `AppModel::changeVideoDevice` (`0x00003f92`). |
| `setAgc` | `setAgc(auto)` | `zvcm::MainAppWrapper::setAgc` (`0x00009380`) | Delegates to `MainApp::setAgc` (`0x000032dc`) → `AppModel::setAgc` (`0x00004142`). |
| `startDesktopCapture` | `startDesktopCapture()` | `zvcm::MainAppWrapper::startDesktopCapture` (`0x00008cce`) | Delegates to `MainApp::startDesktopCapture` (`0x00003350`) → `AppModel::startDesktopCapture` (`0x00005c34`). |
| `stopDesktopCapture` | `stopDesktopCapture()` | `zvcm::MainAppWrapper::stopDesktopCapture` (`0x00008d06`) | Delegates to `MainApp::stopDesktopCapture` (`0x0000335a`) → `AppModel::stopDesktopCapture` (`0x00005c42`). |
| `changeMinMaxMobileBitrate` | `changeMinMaxMobileBitrate()` | `zvcm::MainAppWrapper::changeMinMaxMobileBitrate` (`0x000094e4`) | Delegates to `MainApp::changeMinMaxMobileBitrate` (`0x00003364`) → `AppModel::changeMinMaxMobileBitrate` (`0x00005c50`). |
| `getVideoFrame` | `getVideoFrame(buff)` | `zvcm::MainAppWrapper::getVideoFrame` (`0x000076ce`) | Delegates to `MainApp::getVideoFrame` (`0x000030b8`, `unsigned char*, int&, int&`) → `AppModel::getVideoFrame` (`0x00005902`). Remote decoded frame. |
| `getVideoFrameLocal` | `getVideoFrameLocal(buff)` | `zvcm::MainAppWrapper::getVideoFrameLocal` (`0x0000789a`) | Delegates to `MainApp::getVideoFrameLocal` (`0x000030c2`) → `AppModel::getVideoFrameLocal` (`0x0000599a`). Local capture preview frame. |
| `getEventMessage` | `getEventMessage()` | `zvcm::MainAppWrapper::getEventMessage` (`0x00008868`) | Delegates to `MainApp::getEventMessage` (`0x000030cc`, returns `std::string&`). Polled by the JS `onEventFire` callback loop. |
| `stop` | `stop()` | `zvcm::MainAppWrapper::stop` (`0x00007696`) | Delegates to `MainApp::stop` (`0x000031d0`) → `AppModel::stop` (`0x00004290`). Teardown. |

All addresses above are the first hex field of the matching line in `symbols.txt`
(`rabin2 -qs` output), i.e. same convention as Appendix A. None of the 29 methods are
unresolved, so there is nothing to hand to a dynamic pass for symbol discovery; a dynamic
(macOS CI) pass is still the right way to observe **argument/return JSON shapes at
runtime** (this task is static-symbol-location only, not calling-convention/ABI
recovery).

## Appendix C — ZRTPPacket tentative wire format

Produced by `tools/zcall-re/static/zrtppacket.sh` against `scratch/zcall-analysis/symbols.txt`
on 2026-07-11/12. Raw disassembly of all 51 `ZRTPPacket`-related symbols lives in the
gitignored `scratch/zcall-analysis/zrtppacket.asm` (and `zrtppacket-syms.txt` for the
address+name pairs). The wire-format ground truth below comes from two functions that
mirror each other byte-for-byte — `zrtc::ZRTPPacket::_buildPacketInternal(unsigned char*,
unsigned int&)` (serialize, `0x001dbbb0`) and `zrtc::ZRTPPacket::_parsePacketInternal
(unsigned char*, unsigned int)` (deserialize, `0x001dc3c0`) — plus `getPacketLength()`
(`0x001db8f0`, computes wire size from object state) and every `initZRTPPacket*`/
`initP2P*` constructor (each hard-codes a literal packet-type/sub-command value, which is
how the enum below was recovered without any string/symbol name for it).

**All of this appendix is TENTATIVE except where explicitly marked CONFIRMED — this is a
static-only pass; Task 7 validates it against a real captured packet.** "CONFIRMED" here
means "directly read off a concrete instruction/immediate in the disassembly," not
"validated against a live capture."

**Script bugs found and fixed while running this task** (first run of the brief's script,
as written, silently produced 51 *identical*, *wrong* disassembly dumps despite a
non-empty output file — worth calling out since Step 2's "non-empty file" check does not
catch this class of bug):
1. The brief's `s sym.$sym` seek fails silently for every symbol. r2's `aa` analysis pass
   demangles every Itanium C++ symbol and *renames* the flag from the mangled form
   (`sym.__ZN4zrtc10ZRTPPacket20_buildPacketInternalEPhRj`, what's in `symbols.txt`) to a
   demangled form (`sym.zrtc::ZRTPPacket::_buildPacketInternal_unsigned_char__unsigned_int_`).
   So by the time `s sym.$sym` runs (after `aa;` in the same `-qc` chain), the mangled flag
   name it's built from no longer exists; `s` on an unresolvable expression is a silent
   no-op, and `pdf` dumps whatever function the seek happened to already be sitting at —
   empirically the Mach-O entry point / first function `aa` lands on
   (`MainApp::MainApp()` at `0x1560`), identically, for all 51 symbols. Verified directly:
   `r2 -qc 'aa; s sym.__ZN4zrtc10ZRTPPacket20_buildPacketInternalEPhRj; pd 5' ...` reproduces
   the bogus `MainApp::MainApp` dump. Fixed by seeking by raw hex **address** (`s 0x...`)
   instead — addresses survive the demangling rename — captured up front as
   `awk '{print $1, $NF}'` (address + name) rather than just names.
2. The brief's structure (one `r2 -qc "aa; ..."` process per symbol) re-analyzes the whole
   7.5 MB binary from scratch on every symbol; measured 51 symbols → ~19 minutes wall clock.
   Switched to a single r2 session (`aa` once, then loop `s <addr>; pdf` for all 51 symbols
   via an r2 batch script fed with `-i`); same output, ~23 seconds.
3. `ZRTPPacket` survives unmangled *inside* the Itanium-mangled symbol text (mangling
   length-prefixes identifiers but doesn't otherwise obscure them), so the brief's plain
   case-insensitive substring `grep` on `symbols.txt` matches correctly as written — unlike
   Task 2's short generic method names, no `<len><name>E`-style mangled rewrite was needed
   here.
4. Added `|| true` after the `grep|awk|sort` pipeline defensively (`set -o pipefail` +
   zero matches would otherwise abort the script), though it did not actually fire in this
   run (51 matches were found).

### No length/magic preamble (CONFIRMED)

`ZRTPPacket::parsePacket(unsigned char*, unsigned int, sockaddr_in, unsigned int)` is a
two-instruction-body wrapper: it stashes the sender's `sockaddr_in` into the object
(`this+0x60`/`this+0x68`) and jumps straight into `_parsePacketInternal`. The very first
byte handed to `_parsePacketInternal` is read as the packet type (see below) — there is no
magic number, no version byte, and no outer length prefix on the wire; `getPacketLength()`
computes the size purely from in-memory object state, not from a serialized length field.

### Byte 0 — packet type (CONFIRMED values, TENTATIVE names)

Recovered by cross-referencing every `initZRTPPacket*`/`initP2P*` constructor's literal
write to `this+0x08` against `_buildPacketInternal`'s dispatch (`bt`-based bit tests
against the bitmask `0xa028`, plus explicit `cmp` against `1` and `0x7f`):

| value | TENTATIVE name | evidence |
|---|---|---|
| `0x01` | `ZRTP_REQUEST` (client→server control) | `initZRTPPacketRequestInitCall`/`RequestEndCall`/`RequestPing`/`RequestForward`/`VideoControl`/`RequestChangeAddress`/`RequestEchoAnonymous` all write `byte[this+8] = 1` |
| `0x03` | `AUDIO_RTP` (server-relayed media) | `initZRTPPacketAudio`, `!p2pIsRunning()`, `isRtcp=0`: computed as `(isRtcp<<1) + 3` |
| `0x05` | `AUDIO_RTCP` | `initZRTPPacketAudio`, `!p2pIsRunning()`, `isRtcp=1`: `(1<<1) + 3` |
| `0x0D` (13) | `VIDEO_RTP` | `initZRTPPacketVideo`, `!p2pIsRunning()`, `isRtcp=0`: `(isRtcp<<1) \| 0xd` |
| `0x0F` (15) | `VIDEO_RTCP` | `initZRTPPacketVideo`, `!p2pIsRunning()`, `isRtcp=1`: `(1<<1) \| 0xd` |
| `0x7F` (127) | `ZRTP_P2P` (direct P2P control, and P2P-tunneled media) | `_initP2PPkt`, `initP2PRequestBinding`, `initP2PResponseBinding`, `initP2PAckBinding`, `initP2PSignalPkt`, `initP2PEchoPkt`, and `initZRTPPacketAudio`/`Video` **when** `CallController::p2pIsRunning()` is true, all write `byte[this+8] = 0x7f` |

`_buildPacketInternal` actively **rejects** (returns a computed length of 0, i.e. refuses
to serialize) any type value in `{0,2,4,6,7,8,9,10,11,12,14}` and any value in `0x10..0x7e`
— only `{1,3,5,13,15,0x7f}` are ever emitted by this client (CONFIRMED: every other value
in `0..15` falls through a chain of `bt`/`cmp` checks straight to a `xor ebx,ebx; ret`
path).

**Build/parse asymmetry (TENTATIVE, flag for Task 7):** `_parsePacketInternal`'s dispatch
bitmasks do **not** match the build side's `0xa028`. Parsing groups type `{1,2}` together
(mask `0x6`) into the same 21-byte-header path as type 1, routes type `{4,14}` (mask
`0x4010`) into a third, distinct branch not traced further in this pass, and only accepts
type `{5,15}` (mask `0x8020` — **not** `3`/`13`) into the "simple 5-byte header" parser.
Working hypotheses, none confirmed: (a) a server-emitted response type `2` mirrors client
request type `1`, built server-side and only ever received here; (b) types `4`/`14` are
likewise received-only; (c) RTP media (`3`/`13`) may never reach the generic
`ZRTPPacket::parsePacket` at all — it might be demuxed by a different code path (e.g. raw
RTP-header sniffing) before generic parsing, while RTCP (`5`/`15`) is relayed through this
parser. Confirm/deny all three against the Task 7 capture.

### Endianness — REVISED by Task 7 (2026-07-12): REQUEST fields read as big-endian (TENTATIVE — see caveat below)

**This section's original conclusion was wrong for the REQUEST family (type `0x01`) and
is corrected here.** The original static-only reasoning below is preserved for context,
but its "little-endian" conclusion must now be read as scoped to whichever functions were
actually disassembled for it — not as a blanket claim about every `ZRTPPacket` type.

Task 7 validated a REAL captured REQUEST packet (41 bytes, driven via `makeCall()` on
loopback, config `fromId=111` (`0x6f`), `toId=222` (`0xde`), `callId=10` (`0x0a`),
`sessId="SP1CAPTURE"`; hex: `010100000000000000006f000000000000000b00010a000000de0000000a
0053503143415054555245`). Under the u32-field interpretation, the multi-byte integer fields
recovered from that packet read as **big-endian (network byte order)**, not little-endian
(the field widths/offsets are not yet settled from one small-value sample — treat the
endianness as TENTATIVE pending a wide-value capture; see the caveat below):
- `fromId` (u32, confirmed offset 7) serializes as wire bytes `00 00 00 6f` — reading that
  as little-endian would give `0x6f000000` (1,862,270,976), not 111. Reading it as
  big-endian gives exactly 111.
- `toId` (u32, confirmed offset 22) serializes as `00 00 00 de` → big-endian 222, not the
  little-endian misread of `0xde000000`.
- `callId` (u32, confirmed offset 26) serializes as `00 00 00 0a` → big-endian 10.

This directly falsifies prediction 2 in this appendix's original "Summary for Task 7"
section for the REQUEST family. **Original static reasoning (kept for record):** no
`bswap`/`ror`/`rol`/`htons`/`ntohs`-style byte-swap instruction was found anywhere inside
`_buildPacketInternal` (`0x001dbbb0`) or `_parsePacketInternal` (`0x001dc3c0`) — the only
two byte-swaps in the full `ZRTPPacket`-related symbol set (`rol r13w, 8` at `0x1f18fd` in
`CallController::handleZRTPPacket`, `rol r14w, 8` at `0x205591` in
`CallController::_handleZRTPP2PPacket`) convert a `sockaddr_in.sin_port` to host order,
unrelated to the packet body.

**Reconciliation (re-checked directly against the disassembly, not assumed):** the working
hypothesis going into this task was that a *different*, untraced REQUEST-specific builder
function must be doing the byte-swap. That hypothesis is **wrong** — re-disassembling the
actual call chain for `initZRTPPacketRequestInitCall` (the constructor that shape-matches
this capture) shows it *is* `_buildPacketInternal`'s existing, already-documented type-`1`
branch (the exact `mov dword [r14+0xa], ecx` etc. instructions the Request layout table
below was built from), and that branch does a genuine native (little-endian, no-bswap)
`mov` — confirmed by direct re-inspection, not re-assumed. Tracing one level further up
confirms the same all the way to the source: `CallController::_sendRequestInitZRTPInternal`
(`0x001f4330`, not part of Task 3's `ZRTPPacket`-only symbol grep, so untraced until now)
reads three plain `mov` loads — `mov r12d, dword [r14+0xe4]`, `mov r13d, dword [r14+0xe8]`,
`mov ebx, dword [r14+0xec]` off the `CallController` object — and passes them straight
through as `initZRTPPacketRequestInitCall`'s three `unsigned int` arguments (`edx`, `ecx`,
`r8d`) with **no byte-swap anywhere in that chain**. Those three arguments land at
`ZRTPPacket` object offsets `this+0x14`, `this+0x3c`, and `this+0x38` respectively inside
`initZRTPPacketRequestInitCall` (`this+0x3c`/`this+0x38` are **new fields not in the
original Request layout table below** — Task 3's table only covered the fixed 21-byte
header up to `this+0x1e`; these two get consumed later, by the per-`subCommand` trailer
switch in `_buildPacketInternal`, which explains why `toId`/`callId` land past the 21-byte
boundary in the real capture, see the table below).

**Conclusion:** if the wire bytes are genuinely big-endian — which the real capture
supports, see the caveat below — then no byte-swap happens anywhere in the
`CallController::_sendRequestInitZRTPInternal` → `initZRTPPacketRequestInitCall` →
`_buildPacketInternal` chain; the swap, if it is real, must already be baked into
`CallController`'s `this+0xe4`/`this+0xe8`/`this+0xec` fields *before* this function reads
them (e.g. those ints could be stored network-order from whatever code first assigns a
peer's id, similar to how `sin_port` is handled elsewhere in this class) — **untraced,
open question**, out of scope for this task.

**Important caveat on the "big-endian" call itself:** `fromId=111`, `toId=222`, and
`callId=10` are all single-byte-magnitude values, so a big-endian read at the stated offset
is numerically indistinguishable from a little-endian read 3 bytes later (e.g. `fromId`
read big-endian at offset 7 and read little-endian at offset 10 both yield 111, since only
one byte in the 4-byte span is non-zero either way). This capture alone cannot rule out "the
fields are still little-endian, just at different offsets than Task 3 predicted." Two things
favor the big-endian-at-offset-7/22/26 reading used by the parser: (1) it is what the
harness config directly specifies and what the task's ground truth mandates; (2) `toId`
(22–25) and `callId` (26–29) sit back-to-back with **zero gap**, which is a cleaner
structural fit than the alternative shifted-little-endian windows. But a capture using
larger id values (e.g. `fromId`/`toId` > 255) is needed to settle this definitively — flagged
here as **TENTATIVE pending a wider-value capture**, not fully CONFIRMED.

**Corrected conclusion:**
- REQUEST family (type `0x01`) integer fields: read as **big-endian / network byte order**
  at offsets 7/22/26 correctly recovers the harness's known `fromId`/`toId`/`callId` values
  in this capture (CONFIRMED for this one sample); whether that generalizes to "genuinely
  big-endian" vs. "little-endian at different offsets" is TENTATIVE, per the caveat above.
  Either way, the original blanket "little-endian, no byte-swap" conclusion for this family
  is **retracted** — the values are not recoverable by reading the appendix's originally
  hypothesized offsets as little-endian.
- Media (`0x03`/`0x05`/`0x0D`/`0x0F`) and P2P (`0x7F`) family integer fields: **still only
  TENTATIVE little-endian**, per the original `_buildPacketInternal`/`_parsePacketInternal`
  disassembly — that evidence is unchanged by this task, but it was never re-validated
  against a real captured media/P2P packet either, so treat it as unconfirmed rather than
  re-promoted to CONFIRMED by association. A future capture of an in-progress call (not
  just the initial REQUEST) is needed to settle those families.

### Layout — types `0x03`/`0x05`/`0x0D`/`0x0F` ("media", 5-byte fixed header)

| offset | size | field (TENTATIVE name) | object source | notes |
|---|---|---|---|---|
| `0x00` | 1 | type | `this+0x08` | CONFIRMED |
| `0x01`–`0x04` | 4 | token | `this+0x18` | native-endian `uint32`; populated from `CallController::getToken()` at the call site |
| `0x05`.. | var | payload | `this+0x70`, length = `this+0x5e8` | raw RTP/RTCP bytes, copied verbatim via `memcpy` |

Total length = `payload_len + 5` (CONFIRMED — `getPacketLength`'s fast path: `dword[this+0x5e8] + 5`).

### Layout — type `0x01` (`ZRTP_REQUEST`, 21-byte fixed header + variable trailer)

| offset | size | field (TENTATIVE name) | object source | notes |
|---|---|---|---|---|
| `0x00` | 1 | type | `this+0x08` | always `1` |
| `0x01` | 1 | mode/flag | `this+0x09` | `1` in every `init*Request*` traced (contrast with the P2P family's `0`, below) |
| `0x02`–`0x05` | 4 | field_A | `this+0x0c` | not written by any `init*Request*` traced here — stays at the ctor's zero default |
| `0x06`–`0x09` | 4 | field_B | `this+0x10` | written by `initZRTPPacketRequestForward` |
| `0x0A`–`0x0D` | 4 | sessionId/callId | `this+0x14` | written by `RequestInitCall`/`RequestEndCall`/`RequestForward`/`RequestChangeAddress`/`VideoControl` |
| `0x0E`–`0x11` | 4 | field_C / token | `this+0x18` | written by `RequestEndCall`/`RequestChangeAddress`/`RequestForward`/`VideoControl` |
| `0x12`–`0x13` | 2 | subCommand | `this+0x1c` | dispatch key into a 31-way switch in both `_buildPacketInternal` and `getPacketLength`; `switch_index = subCommand − 2` |
| `0x14` | 1 | field_D | `this+0x1e` | fixed `0x0a` for `VideoControl`; a caller-supplied byte for `RequestForward` |
| `0x15`.. | var | subCommand-specific trailer | varies (`this+0x28`, `this+0x44`, `this+0x50`, `this+0x38`, SSO strings at `this+0x20`/`this+0x48`) | **not fully mapped** — 31 possible cases, only a handful cross-referenced below; TENTATIVE |

Base fixed-header length = `0x15` (21, from `this+0x40`, the ctor's default — this field is
reused as a per-instance "fixed header length" and gets overridden by the P2P family, see
below). `getPacketLength`'s 31-case switch adds a per-`subCommand` variable amount on top
of that base (string lengths decoded from libc++ SSO size/flag bytes at `this+0x20` /
`this+0x48`, or raw counts at `this+0x28` / `this+0x50`).

Observed `subCommand` (`this+0x1c`) literal values, one per constructor (CONFIRMED — read
directly off each `init*`'s immediate operand):

| subCommand | constructor |
|---|---|
| `2` | `initZRTPPacketRequestPing` |
| `3` | `initZRTPPacketRequestEndCall` |
| `5` | `initZRTPPacketRequestEchoAnonymous` |
| `0x0E` (14) | `initZRTPPacketRequestChangeAddress` |
| `0x20` (32) | `initZRTPPacketVideoControl` **and** `initZRTPPacketRequestForward` — same literal from both constructors (TENTATIVE, unresolved aliasing between two otherwise-unrelated message kinds; `RequestForward` additionally writes a caller-supplied byte into wire offset `0x14` where `VideoControl` always writes the fixed value `0x0a`, so the two may in practice be disambiguated by that byte rather than by `subCommand` alone — needs a real capture to confirm) |
| `11` or `12` | `initZRTPPacketRequestInitCall` (`12 − arg`, i.e. one of two sub-values depending on a caller-supplied flag) |

**Task 7 real-capture confirmation (2026-07-12) — does NOT cleanly confirm the table
above.** The real 41-byte REQUEST packet (hex and config quoted in the corrected
"Endianness" section above) is an `initZRTPPacketRequestInitCall`-shaped packet (matches
the `RequestInitCall`/`callId`-writing row). Directly confirmed from it (offsets in
decimal, matching the parser in `tools/zcall-re/parse-zrtppacket.js`):

| offset (dec) | size | field | value in capture | status |
|---|---|---|---|---|
| 0 | 1 | type | `0x01` | CONFIRMED (matches table) |
| 1 | 1 | byte1 (mode/flag) | `0x01` | CONFIRMED (matches table's "always 1") |
| 2–6 | 5 | unmapped | all `0x00` | TENTATIVE (consistent with, not proof of, "field_A stays zero") |
| **7–10** | 4 | **fromId**, u32 **big-endian** | `111` (`0x6f`) | CONFIRMED via harness config |
| 11–21 | 11 | unmapped | `00 00 00 00 00 00 00 0b 00 01 0a` | TENTATIVE — not all zero; semantics unknown from one sample |
| **22–25** | 4 | **toId**, u32 **big-endian** | `222` (`0xde`) | CONFIRMED via harness config |
| **26–29** | 4 | **callId**, u32 **big-endian** | `10` (`0x0a`) | CONFIRMED via harness config |
| 30 | 1 | unmapped (marker?) | `0x00` | TENTATIVE |
| 31–40 | 10 | **sessId**, ASCII | `"SP1CAPTURE"` | CONFIRMED via harness config |

**This contradicts the static table's assumed 4-byte-aligned offsets, not just its
endianness.** The static table places `sessionId/callId` at `0x0A`–`0x0D` (offset 10–13)
and `field_C/token` at `0x0E`–`0x11` (offset 14–17); the real, config-confirmed `fromId`
sits at offset 7–10 instead, straddling the boundary between the table's hypothesized
`field_B` (offset 6–9) and `sessionId/callId` (offset 10–13) slots without matching either
one exactly (see the endianness section above for the caveat that, for these specific
small-magnitude values, an offset-10 little-endian read is numerically indistinguishable
from the offset-7 big-endian read used here — so "the offset itself is off by 3" cannot be
fully ruled out either). Likewise `toId`/`callId` (offset 22–29) fall well past the table's
`0x15` (21-byte) fixed-header boundary, inside the "subCommand-specific trailer… not fully
mapped" region the table already flagged as TENTATIVE.

**Re-disassembly follow-up (2026-07-12, done for this task, not deferred):** re-checking
`initZRTPPacketRequestInitCall` (`0x001db4a0`, the constructor this capture's subCommand
11/12 matches) directly explains the "past offset 21" finding: it takes three `unsigned
int` parameters and writes them to **`this+0x14`, `this+0x3c`, and `this+0x38`** — the
first lands in the fixed 21-byte header (matching the static table's `sessionId/callId`
slot), but **`this+0x3c` and `this+0x38` are two object fields the original static table
never listed at all** (it only enumerated the fixed header up to `this+0x1e`). Those two
almost certainly correspond to `toId`/`callId`, consumed by `_buildPacketInternal`'s
per-`subCommand` trailer switch (case index 9/10, for subCommand 11/12) rather than the
fixed header — which is consistent with them landing past offset 21 in the real capture.
**Conclusion: the static table's byte-for-byte field boundaries for the `0x01` family are
still only partially confirmed by this capture** — the five offsets in the confirmation
table above are solid for *decoding this one sample*, and the "two extra undocumented
fields" finding explains *why* `toId`/`callId` fall in the trailer region, but a full
byte-for-byte remap of the 21-byte fixed header (which of `this+0xc`/`this+0x10`/`this+0x18`
own which wire bytes) remains an open question — resolving it needs either more capture
variety (a `RequestPing`/`RequestForward` packet, which take a different code path through
`_buildPacketInternal`'s switch, to see which bytes change) or tracing the still-unexamined
callers of `CallController::_sendRequestInitZRTPInternal` (`0x001f4330`) that originally
populate `CallController`'s `this+0xe4`/`this+0xe8`/`this+0xec` fields — see the endianness
section above for why that upstream code, not `_buildPacketInternal` itself, is the most
likely place any byte-swap actually happens.

### Layout — type `0x7F` (`ZRTP_P2P`, 9-byte fixed header + variable trailer)

| offset | size | field (TENTATIVE name) | object source | notes |
|---|---|---|---|---|
| `0x00` | 1 | type | `this+0x08` | always `0x7f` |
| `0x01` | 1 | mode/flag | `this+0x09` | `0` in every P2P constructor traced |
| `0x02` | 1 | field_E | `this+0x5ec` | for P2P-tunneled audio/video: `!isCaller` |
| `0x03`–`0x06` | 4 | callId | `this+0x38` | for P2P-tunneled audio/video: `CallController::getZaloCallId()` |
| `0x07`–`0x08` | 2 | subCommand | `this+0x1c` | dispatch key into a 9-way switch; `switch_index = subCommand − 1` |
| `0x09`.. | var | subCommand-specific trailer | varies | **not fully mapped**; TENTATIVE |

`this+0x40` ("fixed header length" field) is **not** uniformly `9` across the P2P family
(CONFIRMED, corrected from an earlier draft of this appendix): the five control-plane P2P
constructors — `initP2PRequestBinding` (0x1db760), `initP2PResponseBinding` (0x1db7a0),
`initP2PAckBinding` (0x1db7e0), `initP2PSignalPkt` (0x1db820), `initP2PEchoPkt` (0x1db850) —
and the shared helper `_initP2PPkt` (0x1db6e0) all execute `mov word [rdi+0x40], 0xe` (14),
not 9; only the p2p-tunneled-media path inside `initZRTPPacketAudio`/`initZRTPPacketVideo`
(0x1db690 / 0x1db710, taken when the `p2pIsRunning()`-derived `bool` argument is true) writes
`mov word [rdi+0x40], 9`. Contrast with the Request family's `0x15` default.

Despite that, the actual **serialized** P2P header is still 9 bytes for every subCommand:
`_buildPacketInternal` (0x1dbbb0), on the `cmp cl, 0x7f` / type-`0x7f` path starting at
0x1dbd5f, unconditionally writes `byte[0]=0x7f` (type), `byte[1]=this+0x09` (mode/flag),
`byte[2]=this+0x5ec` (field_E), `dword[3..6]=this+0x38` (callId), and `word[7..8]=this+0x1c`
(subCommand) before falling into any subCommand-specific trailer logic — i.e. the 9-byte
layout above is baked into the serializer itself, independent of whatever `this+0x40`
happens to hold for a given constructor. So the "9-byte wire header" conclusion in the table
above remains correct (CONFIRMED from `_buildPacketInternal`).

**TENTATIVE — open question for Task 7:** `getPacketLength` (0x1db8f0) computes packet
length using `this+0x40` as the base ("fixed header length + payload/trailer"), so for the
five control-plane P2P constructors and `_initP2PPkt` it will compute a base of 14, while
`_buildPacketInternal` always serializes only 9 fixed bytes for those same subCommands. This
14-vs-9 `getPacketLength`-vs-serialized discrepancy is unresolved from static analysis alone
— same treatment as the existing type 2/4/14 build/parse asymmetry noted elsewhere in this
appendix — and should be checked against a real capture (does the reported/allocated length
for these subCommands actually come out 5 bytes too long, and does that "extra" length get
silently absorbed by the subCommand-specific trailer accounting instead?).

Observed `subCommand` literal values (CONFIRMED):

| subCommand | meaning |
|---|---|
| `1` | `initP2PRequestBinding` |
| `2` | `initP2PResponseBinding` |
| `3` | `initP2PAckBinding` |
| `4` | `initP2PEchoPkt` |
| `5` | `initP2PSignalPkt` |
| `6` / `7` | Audio RTP / RTCP tunneled over P2P (`initZRTPPacketAudio` when `p2pIsRunning()`) |
| `8` / `9` | Video RTP / RTCP tunneled over P2P (`initZRTPPacketVideo` when `p2pIsRunning()`) |

`getPacketLength`'s combined "case 5...8" (switch indices for `subCommand` 6/7/8, i.e. the
media-tunnel sub-commands) all resolve to `this+0x40 (=9) + this+0x5e8 (payload length)` —
a flat 9-byte header plus a raw payload copy, matching the non-P2P "media" family's
semantics exactly. `subCommand=9` (video RTCP tunnel) is one past that contiguous run and
was not individually traced to a specific case body in this pass — TENTATIVE.

### Summary for Task 7

Concrete, falsifiable predictions a real capture should confirm or deny:
1. The first byte of every UDP payload from this client is one of `{0x01, 0x03, 0x05,
   0x0D, 0x0F, 0x7F}` — nothing else.
2. No 2-or-4-byte field in a captured `ZRTPPacket` is byte-swapped relative to how it'd be
   stored in an x86 register — i.e. reading it as little-endian should produce sane
   values (small integers, plausible call IDs), not reading it as big-endian.
3. `0x01`-type packets are exactly 21 bytes before any variable trailer; `0x7F`-type
   packets are exactly 9 bytes before any variable trailer; `0x03`/`0x05`/`0x0D`/`0x0F`
   packets are exactly 5 bytes before the raw media payload.
4. Whether this client ever *receives* (not just sends) type `0x02`, `0x04`, or `0x0E` —
   if so, that confirms the build/parse asymmetry noted above and those are genuine
   server-originated packet types this RE pass didn't fully classify.

**Results (2026-07-12, one real 41-byte REQUEST packet, see the corrected Endianness and
Layout sections above for detail):**
1. **CONFIRMED for this sample** — the captured packet's first byte is `0x01`.
2. **FALSIFIED for the REQUEST family.** `fromId`/`toId`/`callId` are only recoverable by
   reading big-endian at offsets 7/22/26 — the values are not sane when read little-endian
   at the static table's hypothesized offsets. (Caveat: with this task's single
   small-magnitude sample, big-endian-at-offset-7 and little-endian-at-offset-10 are
   numerically indistinguishable — see the Endianness section. Media/P2P families remain
   unvalidated either way — no capture of an in-progress call was taken.)
3. **Not contradicted, but not fully confirmed either** — the real packet's semantic fields
   past offset 21 (`toId`, `callId`, `sessId`) are consistent with a fixed header ending
   somewhere at/before offset 21 followed by a variable trailer, but the fixed header's
   internal field boundaries were not independently re-verified byte-for-byte (see Layout
   section). `0x7F`/media-family sizes were not tested at all — no such packet was captured.
4. **Not observed either way** — only outbound REQUEST retransmits were captured; the
   loopback UDP responder (`tools/zcall-re/udp-responder.js`) echoes bytes back but nothing
   in this pass decoded what type value(s) the client treated an inbound packet as, so this
   prediction remains open.

PoC parser and test: `tools/zcall-re/parse-zrtppacket.js` /
`tools/zcall-re/__tests__/parse-zrtppacket.test.js`, validated (`node
tools/zcall-re/__tests__/parse-zrtppacket.test.js` exits 0) against the exact hex quoted in
the Endianness section above.

## Appendix D — JSON contracts

Sources: `app/native/nativelibs/zcall/vcmac.js` (`setConfigData`, `getEventMessage`,
`getListDevices`, `getActiveAudioCodecs`, `getCallInfo`, `getJsonStats406` wrappers),
`app/native/nativelibs/zcall/index.js` (`testConnect`'s sample config, `doCheckEventMessage`
poll loop), `tools/zcall-re/harness.js` (the driven `MODE=call` config + `setConfig`
call), and the real CI capture (`scratch/zcall-analysis/events.jsonl`,
`scratch/zcall-analysis/zcall-sanity.json` — both gitignored; values below are the actual
run outputs, quoted rather than depended on). Where noted "not observed in CI", the shape
comes from static reading of the JS only — no runtime confirmation.

### `setConfig` — call setup input

`vcmac.js`'s `setConfigData(config, caller, isVideoCall)` is the sole JS-side translator
from the renderer's single `config` object into the native `MainApp::setConfig`'s 12
positional arguments (see Appendix B). Argument map, in call order:

| # | native arg | JS source | notes |
|---|---|---|---|
| 1 | `configJson` | `JSON.stringify(config.settings)` | the `settings` sub-object, re-serialized standalone. |
| 2 | `userId` | `config.fromId` | caller's numeric account id. |
| 3 | `partnerId` | `config.toId` | callee's numeric account id. |
| 4 | `protocol` | `config.protocol` | small integer (sample: `3`). |
| 5 | `callId` | `config.callId` | numeric call id. |
| 6 | `genSession` | `config.sessId` | opaque session token string. |
| 7 | `config` | either `JSON.stringify(config.zrtc_config)` (if present) or the result of a `GET call_config` HTTP round-trip (`getConfigState()` / `authenication()`'s `CONFIG_URL`) | in the harness/CI driven call this was hardcoded to `JSON.stringify({})` — no ZRTC server config was fetched (no live server dependency in the harness). |
| 8 | `enableChangeZRTP` | `!!(config.changeZRTP.enable == 1)` | boolean, derived from `config.changeZRTP.enable`. |
| 9 | `isVideoCall` | the `setConfigData` caller's own `isVideoCall` param (defaults `true`) | not derived from `config` itself. |
| 10 | `logPath` | `path.join(electron.remote.app.getPath('userData'), 'call.log')` iff `config.settings.logDebug` is truthy, else `''` | Electron-only; wrapped in try/catch so it silently becomes `''` outside Electron (as in the Node-8 CI harness). |
| 11 | `osInfo` | `process.platform + ' ' + process.arch` | e.g. `"darwin x64"`; harness hardcoded `"linux x64"`. |
| 12 | `clientVersion` | `parseInt(config.clientVersion)` (fallback `0`) | not present in the `testConnect`/harness sample configs, so this is `0` in both. |

Two more calls follow `setConfig` in the same `setConfigData` flow, gated on `caller`/
`config.servers`:
- if `!caller` (incoming-call path): `setMediaConfig(config.audioConfig || "", config.extendData)`.
- if `caller` and `config.servers` is present: `setListServers(JSON.stringify(config.servers))`;
  otherwise `setConfigServer(config.rtcpIP, config.rtpIP)`.

**Renderer `config` object shape**, reconstructed from `index.js`'s `testConnect()` sample
payload and the harness's `MODE=call` config (both are real, distinct example instances —
`testConnect`'s is a captured production payload embedded in shipped JS; the harness's is
synthetic, built for the loopback capture):

```jsonc
{
  "fromId": 113733669,            // number, caller account id
  "toId": 156444475,              // number, callee account id
  "protocol": 3,                  // number
  "callId": 10,                   // number
  "status": 3,                    // number, unexplored — not read by setConfigData
  "sessId": "ObWyi2...",          // string, opaque session token
  "clientVersion": 0,             // number, optional — parseInt-fallback default 0
  "rtpIP": "120.138.74.196:8019", // "host:port" string, used when no `servers` list
  "rtcpIP": "120.138.74.196:4003",// "host:port" string, used when no `servers` list
  "servers": [                    // optional array; when present, wins over rtpIP/rtcpIP
    { "rtpaddr": "120.138.74.196:8020", "rtcpaddr": "120.138.74.196:4004" }
    // ... more relay/ICE candidates
  ],
  "changeZRTP": { "enable": 1, "threshold": 5 }, // enable: 0|1 (coerced to bool), threshold: number
  "settings": {                   // JSON.stringify'd standalone and passed as native arg 1
    "voipResetTime": 5, "dynamicFptime": 1, "logDebug": 1,
    "checkPkgRec": 7, "checkPkgSent": 10, "voipFTime3G": 20,
    "checkTimeOut": 1500, "dynamicBitrate": 1, "voipFTimeWifi": 20
  },
  "fec": {                        // forward-error-correction table; not separately passed to
    "enable": 2,                  // native (folded into `settings`/`zrtc_config` server-side,
    "tableLookup": [[-1,3,1],[15,0,0],[25,2,1],[35,3,2],[40,2,2]] // per JS it's read only for its own shape, not destructured by setConfigData)
  },
  "zrtc_config": { /* ... */ },   // optional; if present, used verbatim (stringified) as native arg 7 instead of an HTTP-fetched config
  "nativeCallPopup": { /* UI-only fields, not read by setConfigData */ },
  "msg": "", "tip": { /* UI-only display strings, not read by setConfigData */ }
}
```

Fields consumed by `setConfigData` are `fromId`, `toId`, `protocol`, `callId`, `sessId`,
`settings`, `clientVersion`, `changeZRTP.enable`, `zrtc_config` (optional), `servers`
(optional) / `rtpIP`+`rtcpIP` (fallback), `audioConfig`+`extendData` (callee path only).
`status`, `nativeCallPopup`, `msg`, `tip`, and `fec` are present in real payloads but not
read by this JS function — they are either UI-only or consumed natively via the
`config`/`zrtc_config` blob, not individually destructured here.

### `getEventMessage` — event polling protocol

`getEventMessage()` is polled from the renderer in a loop (`index.js`'s
`doCheckEventMessage`, driven by `checkEventMessage()` while `enableCheckEventMessage` is
true — set by `makeCall()`/`incomingCall()`). Each poll:
- returns `-100` (`NO_INSTANCE_ERROR`) if `this.instance` is falsy (`vcmac.js`) — the
  renderer checks `x == NO_INSTANCE_ERROR` and stops polling on this sentinel.
- otherwise returns either a falsy value (nothing to report this tick — the renderer's
  `if(x)` guard skips it) or a JSON *string* which the renderer `JSON.parse`s and forwards
  to `callbackEventMessage`.

**Observed event envelope** (from the real CI driven-call capture,
`scratch/zcall-analysis/events.jsonl`, produced by `tools/zcall-re/harness.js`'s
`MODE=call` poll loop against the loopback UDP responder): each parsed message is
`{"type": "<eventName>", ...eventFields}`. Two distinct events were emitted across the
whole ~15s capture window:

| t (ms, from `makeCall()`) | event |
|---|---|
| ≈101 | `{"type":"onMakeCall"}` |
| ≈11159 | `{"type":"onInitZrtpRequestFailed","retCode":"99"}` |

Notes:
- `retCode` is a JSON **string** (`"99"`), not a number — confirmed from the raw capture.
- The call never progressed past ZRTP init because the loopback responder
  (`tools/zcall-re/udp-responder.js`) is a bare packet echo, not a real ZRTP peer — so no
  connected/media/hangup events were exercised in this run.
- The full event `type` enum is materially larger than these two: `vcmac.js`/`index.js`
  don't enumerate event names (the type strings are native-side), and Appendix B's method
  table shows only the polling method, not the emitted vocabulary. **Only `onMakeCall` and
  `onInitZrtpRequestFailed` are confirmed; all other event types (e.g. anything for
  connected/ringing/media-established/hangup/error states) are unobserved in this SP1 pass**
  and would need either a real ZRTP-capable peer or static disassembly of the event-emit
  call sites to enumerate.

### `getListDevices` — device enumeration

Real output captured in CI sanity mode (`tools/zcall-re/harness.js` `app.getListDevices()`,
via `zcall-sanity.json`), a JSON string encoding an array of:

```jsonc
[
  { "t": 1, "n": "default (Apple Virtual Sound Device)", "i": "0" },
  // ... more entries, t=1 for each input device
  { "t": 2, "n": "<output device name>", "i": "<id>" }
  // ... t=2 for each output device
]
```

Fields: `t` (number) — device kind, `1` = audio input, `2` = audio output;
`n` (string) — human-readable device name; `i` (string, despite being a numeric-looking
id) — device id, passed back into `changeAudioDevice(inputId, outputId)`. On the macOS CI
runner the enumerated devices were virtual audio devices ("Apple Virtual Sound Device"),
not a real microphone/speaker — expected for a headless runner, doesn't change the schema.

### `getActiveAudioCodecs` — pre-call state

Real CI sanity output: the literal string `"[]"` (an empty JSON array, pre-call — no call
was active when this was sampled). Populated only once a call is active and codecs have
been negotiated; the populated shape was **not observed in CI** — from JS/static only,
`vcmac.js` just forwards the native call's return value verbatim with no JS-side parsing,
so no field-level shape can be inferred without a connected call.

### `getCallInfo` — pre-call state

Real CI sanity output: the empty string `""` (pre-call — no call was active). Like
`getActiveAudioCodecs`, `vcmac.js` passes the native return value through unparsed; the
populated (in-call) shape was **not observed in CI — from JS/static only**, and no static
JS-side schema exists to fall back on since the JS layer never destructures this value
either (Appendix B: `getCallInfo` delegates to `zrtc::Peer::getCallInfo`, native-only).

### `getJsonStats406` — call statistics

**Not observed in CI.** The driven call (`MODE=call`) failed at `onInitZrtpRequestFailed`
before any active-call stats existed, and the harness does not call
`getJsonStats406()` at all (Appendix B/harness.js: only `test`, `getListDevices`,
`getActiveAudioCodecs`, `getCallInfo` are sampled in sanity mode). No JS-side shape exists
either — `vcmac.js`'s `getJsonStats406(startNetworkType = 0, endNetworkType = 0)` forwards
both numeric args straight to native and returns the native string unparsed. Native
delegation chain (Appendix B) is the deepest in the table
(`MainApp::getJsonStats406` → `AppModel::getJsonStats406` → `zrtc::Peer::getJsonStats406`
→ `zrtc::CallController::getJsonStats`), consistent with this being a rich, engine-internal
stats blob (likely per-network-type — hence the two args — WebRTC-style RTT/jitter/loss
counters) — but its field names are unrecovered by this SP1 pass.

## Appendix E — Go/No-Go

This appendix synthesizes Appendices A–D and the dynamic CI-gate run into a feasibility
verdict for the parent goal (real voice/video Zalo calls on Linux), an effort/risk
estimate for SP2–SP6, and a recommendation. Every claim below cites the appendix or the CI
run that supports it. This report gates a multi-month, multi-sub-project commitment, so it
is deliberately conservative: where SP1 did not observe something, that is stated as an
unknown, not smoothed over.

### E.0 — What SP1 actually established (evidence recap)

- **Component identity is settled** (Appendix A): `zcall_mac.node` is Google WebRTC +
  libjingle (`talk/`) wrapped by Zalo's proprietary **ZRTC** C++ layer. It is a
  mixed-freshness fork, roughly 2017–2018-era based on the libopus 1.2.1 bump over an
  older `webrtc/base` layout — no single milestone assignable (pre-2016 `webrtc/base/`
  file naming; libjingle `cricket::` still un-folded; `libopus 1.2.1` pinned;
  beamformer/intelligibility modules that upstream later deleted still present).
  **No explicit WebRTC milestone stamp exists** — it is a long-lived, selectively-patched
  vendor branch, not any single upstream release.
- **The JS↔native API surface is fully mapped** (Appendix B): 29/29 `MainApp()` methods
  resolved to concrete native symbols, with the call chain `zvcm::MainAppWrapper` (Nan glue)
  → `MainApp` (facade) → `AppModel`/`zrtc::Peer`/`zrtc::CallController` (engine).
- **The wire format is partially recovered** (Appendix C): 6 packet types confirmed by
  immediate values (`0x01` REQUEST, `0x03/05/0D/0F` media RTP/RTCP, `0x7F` P2P); the REQUEST
  and media and P2P fixed-header layouts sketched; ~15 of ~40 subcommands enumerated.
- **Key JSON contracts are documented** (Appendix D): `setConfig`'s 12-arg map, the
  `getEventMessage` envelope (`{"type":...}`), `getListDevices` (`{t,n,i}`).
- **The addon was driven live on macOS CI** (CI-gate run): `test(123)=123`,
  `getListDevices` returned real devices, and `makeCall()` emitted real ZRTP REQUEST packets
  captured over loopback — this is the ground truth that corrected Appendix C's endianness.

That is a strong result for a feasibility spike. But the three things that decide whether a
Linux client can actually *interoperate* with Zalo — the full ZRTP crypto/key-exchange, the
media-frame path end to end, and confirmation that the mac binary is reusable — all came
back **negative or unobserved**. The rest of this appendix is about that gap.

### E.1 — Is the ZRTC transport/protocol reproducible on Linux?

**Partially — the framing is reproducible; the security handshake that makes it
interoperable is not yet reversed.**

Known well enough to reimplement today:
- **Packet framing / type dispatch** (Appendix C): first byte selects one of
  `{0x01,0x03,0x05,0x0D,0x0F,0x7F}`; no magic/version/length preamble on the wire
  (CONFIRMED). Media packets are a 5-byte header + raw RTP/RTCP; P2P is a 9-byte serialized
  header; REQUEST is a ~21-byte fixed header + per-subcommand trailer.
- **The initial outbound REQUEST packet** (Appendix C + CI capture): a real 41-byte
  `initZRTPPacketRequestInitCall` packet was captured and byte-decoded; `fromId`/`toId`/
  `callId`/`sessId` were recovered against known harness config values.
- **The call-setup input contract and the makeCall→onMakeCall event kickoff** (Appendix D):
  enough to construct a valid `setConfig` + `makeCall` from scratch.

Still unknown — and these are the parts that gate interop, not just parsing:
- **The full ZRTP crypto / key-exchange handshake is completely unreversed.** The driven
  call never progressed past ZRTP init: after the first REQUEST it retransmitted for ~11 s
  and then emitted `onInitZrtpRequestFailed` with `retCode "99"` (Appendix D + CI-gate run),
  because loopback is a bare packet echo, not a real ZRTP peer. So **everything after the
  first REQUEST packet — the challenge/response, key agreement, whatever `changeZRTP`
  toggles, and how session keys are derived — was never observed.** The class names
  (`ZRTPPacket`, not RFC-6189 `ZRTP`) and the `enableChangeZRTP` config flag strongly imply
  a **Zalo-custom** keying scheme, not standard SRTP/ZRTP; SP1 has no capture to reverse it
  against. This is the single most important open question in the whole spike.
- **The media-frame path is unobserved end to end.** Media packet *framing* is sketched
  (Appendix C), but no media packet was ever captured (the call never connected), and the
  media families' endianness was never validated against a real packet (Appendix C
  explicitly leaves `0x03/05/0D/0F` and `0x7F` as TENTATIVE little-endian).
- **~25 of ~40 subcommands are unmapped** (Appendix C): the REQUEST trailer switch (31 ways)
  and the P2P switch (9 ways) are only partially traced.
- **Endianness / field-widths of REQUEST are not definitively settled.** Task 7 corrected
  the REQUEST family from little- to **big-endian**, but the caveat (Appendix C, "Endianness")
  is real: with single-byte-magnitude test values, big-endian-at-offset-7 is numerically
  indistinguishable from little-endian-at-offset-10, so "the offsets are off by 3" is not
  ruled out. A wide-value capture is needed to close this (see E.5).
- **Build/parse asymmetry** (Appendix C): the client parses type values `{2,4,14}` it never
  builds, i.e. there are server-originated packet types SP1 never classified — again because
  no inbound traffic from a real peer was seen.
- **Stats contract unobserved** (Appendix D): `getJsonStats406` field names unrecovered.

**Bottom line for E.1:** the loopback-only capture got us the *client's outbound framing and
the setup contract* — genuinely useful for SP3 — but it got us **none of the
crypto/key-exchange**, which is exactly the part you cannot reimplement from framing alone
and cannot capture without a real server/peer.

### E.2 — Is the WebRTC engine obtainable/buildable for Linux?

**The engine can be built for Linux in principle, but not cheaply and not as a drop-in — and
the mac binary itself cannot be reused.**

- A ~2018-vintage Google WebRTC + libjingle tree **is** buildable for linux-x64 (that era of
  WebRTC had first-class Linux support). So the codec/DSP core is obtainable in principle.
- But it is **not a pinned target** (Appendix A): there is no milestone stamp, and the tree
  is a bespoke long-lived Zalo fork with individually-bumped third-party libs (Opus at 1.2.1
  over a pre-2016 base). SP2 cannot `git checkout branch-heads/NNNN` and get a match; it must
  approximate, then reconcile behavioral differences empirically.
- **Legacy codecs are a real parity risk** (Appendix A): the confirmed set is Opus, SILK,
  iSAC, iLBC (audio) + x264, OpenH264, VP8, VP9 (video). **SILK and iSAC are not in modern
  standard WebRTC** (iSAC was deprecated/removed upstream; SILK lives only inside Opus). If
  Zalo's servers/peers negotiate SILK or iSAC, a modern WebRTC build won't offer them and
  the call fails to a codec both sides support — so SP2 likely must resurrect these legacy
  codecs from the old tree, not use a current WebRTC.
- **The ZRTC C++ wrapper is proprietary and is not in that tree at all.** `zrtc::Peer`,
  `zrtc::CallController`, `ZRTPPacket`, `ZRtcConfig`, the whole transport/signaling layer
  (Appendices A–C) must be **reimplemented from the RE**, not obtained. SP2 gets you WebRTC;
  SP3 is where the genuinely hard, Zalo-specific reimplementation lives — and SP3 is gated on
  the unreversed crypto from E.1.

**Bottom line for E.2:** "obtain WebRTC for Linux" is the *tractable* half. It is real work
(build system, legacy-codec resurrection, version reconciliation) but it is bounded,
standard porting. The unbounded risk is the proprietary ZRTC layer on top of it.

### E.3 — The real blockers, ranked

1. **The mac binary cannot be reused on Linux → full reimplementation is mandatory** (CI-gate
   findings). `zcall_mac.node` is **x86_64-only** (no arm64/x64 variants exist; only
   `ZaloSetup-universal`), it links **macOS-only frameworks** (AVFoundation, CoreAudio/
   AudioUnit/AudioToolbox, CoreVideo/CoreMedia, IOSurface, OpenGL), and it was built against
   **NODE_MODULE_VERSION 57 (Node 8 / Electron 2.0, ~2018)** — it only loads under that
   ancient ABI (we ran it via Node 8.17.0 under Rosetta). There is **no "port the binary"
   shortcut**: the engine must be rebuilt from source (SP2) and the ZRTC layer reimplemented
   (SP3). This blocker is *confirmed*, and it sets the floor on the whole effort.
2. **The ZRTP crypto / key-exchange is unreversed — the make-or-break for interop** (E.1).
   Without it, a Linux client can *send* a valid first REQUEST but cannot complete a call
   with real Zalo infrastructure. Reversing it requires **captures of a real handshake
   against real Zalo servers/peers**, which is out of SP1's loopback-only, no-infra scope —
   and which raises **ToS / scope questions** (SP1 deliberately touched no Zalo
   infrastructure; a real-handshake capture would require a real logged-in account and real
   server traffic — that is a legal/policy decision, not just an engineering one). Until this
   is resolved, **the feasibility of the parent goal is genuinely unproven**, not merely
   unimplemented.
3. **Codec licensing/IP** (Appendix A): the confirmed codec set includes both
   copyleft-licensed and patent-encumbered components, which is a real distribution
   blocker for a proprietary Linux client, but a lower-severity one than blockers 1–2
   because it is a known, well-precedented problem with known mitigations (buy a license,
   swap to the royalty-free official binary, or drop the codec) rather than an open
   technical unknown:
   - **x264** is licensed **GPLv2, or a paid commercial license from x264 LLC.** Appendix A
     confirms a full, complete x264 encoder (not just OpenH264) is statically linked in
     (`_x264_predict_8x8_ddr_c`, `X264EncoderImplE`, SSE2/SSSE3/AVX/AVX2 variants, etc.,
     1778 string hits). Statically linking GPLv2 x264 into a shipped closed-source Linux
     app triggers copyleft obligations unless a commercial license is purchased — this is
     a real ship-blocker for a proprietary build, not a hypothetical one.
   - **H.264 patent pool (Via LA / MPEG-LA)**: H.264 encode/decode carries patent-pool
     royalties independent of which encoder implementation is used. OpenH264 (also present
     per Appendix A, `OpenH264] this = 0x%p` / `openh264 codec version = %s` strings) is
     itself BSD-licensed, and Cisco covers the H.264 royalties **only** when using Cisco's
     official prebuilt OpenH264 binary — building OpenH264 from source (as SP2 would need
     to, alongside x264) does **not** inherit that royalty coverage.
   - **VP8/VP9** (confirmed via symbols, Appendix A): royalty-free (Google), low risk.
   - **SILK/iSAC/Opus** (confirmed via symbols and strings, Appendix A): royalty-free
     today — Opus is IETF RFC 6716 and royalty-free, and SILK/iSAC usage here is folded
     into that royalty-free posture — low risk.
   - **Net**: for a Linux port that must actually ship, the x264 GPL/commercial-license
     question and the H.264 patent royalties are the material IP blockers; VP8/VP9/
     SILK/iSAC/Opus are low risk. This is ranked below blockers 1–2 because it doesn't
     block *engineering feasibility* the way an unreversed crypto handshake or a
     non-portable binary does — it blocks *distribution* of a proprietary build, and has
     known (if costly) resolutions: buy an x264/H.264 commercial license, or ship only
     the royalty-free codecs and accept reduced interop with peers that only offer x264/
     H.264.
4. **Legacy codec parity** (E.2): SILK/iSAC are outside modern WebRTC; a mismatch here is a
   silent "call won't connect" failure. Medium blocker — solvable by building the old tree,
   but it forecloses using a current, better-maintained WebRTC.
5. **Linux media I/O** (SP4 scope): PipeWire/PulseAudio + V4L2 + frame→canvas + desktop
   capture, all of which the mac binary got from macOS frameworks that don't exist on Linux.
   This is *known-hard-but-bounded* — standard Linux A/V integration work, lowest-novelty of
   the five.
6. (Secondary) **Account/login/token and server anti-abuse**: `setConfig` needs a real
   `sessId`/`callId`/account ids (Appendix D); obtaining those legitimately implies a
   logged-in account and Zalo's signaling path — entangled with blocker 2's ToS question.

### E.4 — Effort + risk estimate for SP2–SP6

Order-of-magnitude only; this is a very large, high-variance effort and the ZRTP unknown
(blocker 2) can move the total by a lot.

| SP | Scope | Effort (order of magnitude) | Risk | Why |
|---|---|---|---|---|
| SP2 | WebRTC engine for Linux | ~1–3 eng-months | Medium | Bounded porting, but legacy-codec resurrection (SILK/iSAC) + un-pinned fork reconciliation add drag. |
| SP3 | ZRTC transport reimplementation | ~3–6+ eng-months | **Very high** | Gated on the unreversed crypto (blocker 2). Framing is known (Appendix C); keying is not. Estimate is a floor and could balloon or prove impossible if the keying is server-attested / anti-tamper. |
| SP4 | Linux media I/O | ~1–2 eng-months | Medium | Standard PipeWire/PulseAudio/V4L2 work; lowest novelty. |
| SP5 | Node API binding + call state machine | ~1–2 eng-months | Low–Medium | The 29-method surface is fully mapped (Appendix B); the event vocabulary is only 2 of N observed (Appendix D), so the state machine is under-specified. |
| SP6 | Integration + real-call verification | ~1–3+ eng-months | **Very high** | The first place real interop is proven or disproven; heavily dependent on SP3, and iterative against real infra. |

**Aggregate: order of ~7–16+ engineer-months of specialized (RE + real-time-media + native)
work, with the SP3/SP6 portion carrying binary make-or-break risk.** The honest framing is
that this is a person-year-plus effort whose success is *not yet demonstrated to be
possible*, because the pivotal unknown (ZRTP keying) is untouched.

### E.5 — Recommendation: **CONDITIONAL** (lean cautious; do NOT commit SP2–SP6 yet)

SP1 succeeded as a spike — it identified the engine, mapped the API, recovered the framing,
and, critically, *found the wall*: the ZRTP crypto/key-exchange is unreversed and is the
make-or-break for interop. Committing the ~person-year of SP2–SP6 before that wall is
scouted would be committing on faith. So the verdict is **CONDITIONAL, not GO**.

**What must be resolved before a GO on SP2–SP6:**
- **A real-server/peer ZRTP handshake capture** that lets us reverse the crypto/key-exchange
  (blocker 2). This is the gate. It requires deciding the **ToS/legal question** of capturing
  a real handshake (real account, real Zalo signaling) — an explicit policy call, made
  *before* any capture, not an engineering afterthought. If that keying turns out to be
  standard-ish and reimplementable, this flips to GO. If it is server-attested / anti-tamper
  / otherwise not client-reimplementable, this flips to **NO-GO** and saves the person-year.

**The single cheapest next experiment (do this first — it is nearly free and de-risks the
foundation):**
- **A wide-value `makeCall` loopback capture.** Re-run the *existing* CI harness
  (`tools/zcall-re/harness.js`, `MODE=call`) with **large `fromId`/`toId`/`callId` values
  (all > 255, ideally each byte distinct)**. This needs **no Zalo infrastructure, no account,
  no new tooling** — it reuses the loopback capture already built — and it **definitively
  settles the REQUEST endianness and field-widths/offsets** that Appendix C flags as
  TENTATIVE (the small-magnitude sample can't distinguish big-endian-at-7 from
  little-endian-at-10). Cheap, zero-ToS-risk, and it hardens the one piece of the transport
  SP3 would build on first. It does **not** unblock the crypto (only the real-server capture
  does that), but it is the correct, lowest-cost *next* move and should precede the
  larger, ToS-sensitive real-handshake decision.

**Suggested sequencing if this proceeds:** (1) wide-value loopback capture → lock the REQUEST
wire format; (2) make the ToS/scope decision on real-server capture; (3) if approved, capture
+ reverse the ZRTP handshake — this is the true go/no-go gate; (4) only then commit SP2
(WebRTC/Linux) in parallel with SP3 (ZRTC transport), since SP2 is independently useful and
bounded; (5) SP4/SP5/SP6 follow. Do not start SP3 in earnest until step 3 answers whether the
keying is client-reimplementable at all.
