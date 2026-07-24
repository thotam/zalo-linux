# SP2 step 4a — Wire the call engine into the app: OUTGOING + deb (design)

**Date:** 2026-07-14
**Parent decisions:**
- [Outgoing-call connect flow — media plane + connect validated live](../decisions/2026-07-14-zcall-outgoing-call-connect-flow.md)
- Full two-way audio proven (SP2 3): `tools/zcall-media` + `nativelibs/{zsrtp,zaudio}`.

**Status:** approved (brainstorming) → ready for writing-plans. Scope = **4a (outgoing) + Electron
build + deb**; 4b (incoming) is a documented follow-up phase.

## Goal

Make the **call button in the Zalo app on Linux place a real outgoing 1-1 audio call** (two-way
audio), by replacing the `$zcall` Linux stub with a real engine that implements the interface the
app's JS call-controller uses, and by building the native addons (`zsrtp`, `zaudio`) against Electron
and shipping them in the `.deb`. No protocol/crypto unknowns remain — the standalone flow
(`tools/zcall-media/live-audio.js`) already works end-to-end; 4a moves it inside the app.

## Global Constraints

- **Boundary:** own account / machine / phone only. Commit only when asked; no AI-attribution.
- **Engine runs in the preload/renderer** process (where `app/native/nativelibs/zcall/binding.js`
  is required — preload has Node access: `dgram`, native `.node`).
- **Addons:** built against **Electron headers** for shipping (`nativelibs/builder.js
  --target=<ELECTRON_VERSION>`), plus local Node for tests. `zsrtp` (static libsrtp2) + `zaudio`
  (static libopus + miniaudio dlopen) → **no new deb Depends**.
- Reuse the proven modules unchanged: `requestcall.js` (parseConfig/srtpMasterKey),
  `call-control.js` (buildExtendData/OPUS_CODEC), `initzrtp.js`, `media-session.js` (open/send/recv +
  retarget), `zaudio` (mic/speaker). The engine only adds the `$zcall` interface + state machine.

## Reverse-engineered `$zcall` interface (from the render bundle + diag log)

The app (renderer) uses `$zcall.MainApp()`:
- `initCall(config)` — init the engine with a settings/config object (called before makeCall).
- `sendDataToNative({ type, command, data })` — JS→native channel:
  - `{type:"request", command:"makeCall", data:{ partner:[{id:<calleeId>,…}], type:1 }}` — start an
    outgoing call (`type:1` = audio).
  - `{type:"control", data:{ act_type:"voip", act:"answer"|"request"|"end_call", data:{ callId,
    params:"{…rtpSerIp,sessId,…}", … } }}` — server-pushed call events (from the JS polling).
  - `{type:"update", command:"init"|…, data:…}` — init/state data.
- `onCallSignal(cb)` — register `cb(signalType, data)`; the engine calls it to make the JS execute
  the HTTP signaling. `cb` returns a **Promise** (e.g. `401` → the requestcall config). Signal types:
  `401`=requestcall `{calleeId,callId,codec,type}`, `416`=request
  `{calleeId,rtcpAddress,rtpAddress,codec,extendData,session,callId}`, `408`=answerack
  `{calleeId,callId}`, `406`=endcall, `407`=ringring.
- `onCallRequest(cb)` / `onCallUpdate(cb)` / `onCallCallback(cb)` / `onCallResponseDevices(cb)` —
  register callbacks (native→JS events: call state, devices). 4a uses `onCallCallback`/`onCallUpdate`
  to drive the in-call UI state; incoming (`onCallRequest`) is 4b.
- `getEventMessage()` / `getListDevices()` / `getCallInfo()` / device methods — polled getters.

## Architecture

### 1. `app/native/nativelibs/zcall/engine.js` (new) — the `$zcall` engine
A `MainApp()` factory returning an engine object with the interface above. Internally a per-call
state machine wrapping the proven modules:
- **`initCall(config)`** — store the runtime config/settings.
- **`onCallSignal(cb)`/`onCallCallback(cb)`/…** — store callbacks.
- **`sendDataToNative(msg)`** — route:
  - `makeCall` → `startOutgoing(calleeId, callType)`.
  - `control` `act:"answer"` → `onAnswer(callId, params)`.
  - `control` `act:"end_call"` → `teardown(callId)`.
- **`startOutgoing(calleeId, type)`** (the proven flow, driven via `onCallSignal`):
  1. `callId = random`; `config = await onCallSignalCb(401, {calleeId, callId, codec:'[]', type})`.
  2. `parseConfig` → `key = srtpMasterKey(config.sessId)`; `MediaSession.open()` (InitZRTP on the
     media socket) → relay + flowToken + probe results.
  3. `extendData = buildExtendData(...)`; `await onCallSignalCb(416, {calleeId, rtcp/rtpAddress:
     selectedRelay, codec:OPUS_CODEC, extendData, session:config.sessId, callId})` → phone rings.
  4. Start `ZAudio` (mic→opus→`MediaSession.send`) + `session.on('media', …→ZAudio.play)`.
     (MediaSession auto-retargets outbound to the bridging relay; ts +320; gain default.)
  5. Emit call-state updates to the UI via `onCallCallback`/`onCallUpdate` (ringing → connected).
- **`onAnswer(callId, params)`** — `await onCallSignalCb(408, {calleeId, callId})`; mark connected;
  media already flowing.
- **`teardown`** — `ZAudio.stop()`, `MediaSession.close()`, clear state.
- **device/getters** — `getListDevices()` returns real devices (from a `zaudio` enumerate, or a
  minimal `[{default}]`); `getEventMessage()` drains a queued-events buffer if the UI polls
  (fallback to callbacks). Exact needs RE'd against the live UI during impl.

### 2. `binding.js` — replace the Linux stub
The Linux branch returns `require('./engine.js')` instead of the no-op Proxy (win/darwin branches
unchanged).

### 3. `scripts/patches/patch-zcall-linux-engine.js` (new; supersedes `patch-zcall-linux-stub.js`)
- Rewrite `binding.js` Linux branch → the engine. Copy `engine.js` + the reused `tools/zcall-*`
  modules + the two built `.node` addons into `app/native/nativelibs/zcall/`. Idempotent, fail-loud.
- Keep the existing call-button-enable patch (`patch-call-support-linux.js`) — the button must show.

### 4. Electron build + deb
- `nativelibs/builder.js` builds `zsrtp` + `zaudio` with `--target=<ELECTRON_VERSION>
  --dist-url=electronjs.org/headers` (the mechanism already used for the other native libs), for x64.
- The deb bundles both `.node` + `engine.js` + reused tools; no new `Depends` (static + dlopen).

## Data flow (outgoing)
```
UI call button → makeCall → sendDataToNative({request,makeCall,{partner:[{id}],type:1}})
  → engine.startOutgoing → onCallSignal(401)→config → MediaSession.open()/InitZRTP
  → onCallSignal(416, extendData) → phone RINGS
  → server answer → JS polling → sendDataToNative({control, act:answer}) → engine.onAnswer
  → onCallSignal(408, answerack) → ZAudio(mic→opus→send) + inbound(0x04→opus→speaker) = TWO-WAY AUDIO
```

## Testing
- **Offline (suite):** the engine state machine with **mocked** `onCallSignal`/`onCallCallback` and
  synthetic `sendDataToNative` inputs — assert it emits `401 → 416 (with a well-formed extendData) →
  408` in order for a makeCall, and tears down on end_call. Media/audio are stubbed (inject a fake
  MediaSession/ZAudio) so it runs without a device or network.
- **Live (operator):** build the deb (or patch a local install), launch the app, click call → the
  phone rings → answer → **two-way audio** from the app button.

## Open items (RE during impl — samples in the diag log)
- Exact `sendDataToNative` shapes for `makeCall`/`control:answer`/`update:init` (diag log has real
  redacted samples) and the exact `onCallSignal` return contract (Promise resolving to the config).
- `getEventMessage`/`onCallCallback`/`onCallUpdate` payloads to move the in-call UI to
  ringing/connected/ended (so the app shows the right call screen).
- `getListDevices` format for the mic/speaker picker (may return a minimal default).

## What this explicitly does NOT cover (4b / later)
- **Incoming calls** (`onCallRequest` + callee-side answer/media) — step 4b.
- Video, screen share, AEC/noise-suppression.

## Success criteria
1. Engine state-machine unit test passes (401→416→408 ordering + extendData shape) with mocks.
2. `zsrtp`/`zaudio` build against Electron headers; deb bundles them (no new Depends).
3. On a patched install / the deb, clicking the call button places a real outgoing call and the
   operator gets **two-way audio** with their phone.
