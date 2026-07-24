# SP2 step 4a (revised) — Wire the engine into main.js (OUTGOING) + deb (design)

**Date:** 2026-07-14
**Supersedes the integration point of:** `2026-07-14-zcall-sp2-4a-app-engine-outgoing-design.md`
(that patched `binding.js`, which is a **legacy/unloaded** mac addon — the real call path is a
main-process controller driving a child-process engine).

**Status:** approved (brainstorming) → ready for writing-plans. Scope = 4a outgoing + deb; 4b incoming later.

## Goal

Make the app's call button place a real outgoing 1-1 audio call (two-way audio) by running our JS
call engine **in the main process**, replacing the absent child-process native engine (`N`). The
media/protocol/audio are already proven (`live-audio.js`); 4a re-targets that flow to the app's real
IPC signaling loop.

## Reverse-engineered architecture (live, 2026-07-14)

- Render `$zcall.<m>` = an IPC bridge: `ipcRenderer.invoke(apiKey, ...args)`. Keys:
  `SEND_TO_NATIVE="call-send-to-native"`, `CALL_SEND_SIGNAL="call-send-signal"`, `CALL_INIT="call-init"`.
- **Main process** (`app/main-dist/main.js`, one webpack module) `configure(ipcMain, _, getWC)`:
  `w = getWC()`; `ipcMain.on("call-send-to-native", (e,t)=> { ...; S(t) })`;
  `ipcMain.on("call-init", (e,t)=> D=t)`.
  - `S(t)` forwards `t` to the child engine `N`; queues in `L` + `W()` if `N` not started.
  - `N`'s out-messages `{type, command, data}` are forwarded to the render:
    `case "sendSignal": w.webContents.send("call-send-signal", e.command, e.data)`; `"update" →
    call-update`; `"request" → call-request` (`"killMe"` kills `N`).
  - `N` = a child PROCESS (`N.kill()` on stop), like Windows `ZaloCall.exe`. **Absent on Linux** →
    `S(t)` goes nowhere → the call button does nothing.
- **Render** `handleSendSignal(event, command, data)` executes the HTTP signal via the VoiceCall API:
  `401→requestCall(calleeId,callId,codec,type)` (→ config), `416→sendRequestCall(...extendData...)`,
  `408→sendAnswerACKCall`, `407→ringring`, `402→answer`, `405→cancel`, `409→endcall`. The result is
  returned to native via `a.then(res => handleRecvSignal(command, res))` → `sendDataToNative`
  (`call-send-to-native` → `S`). So the config comes BACK through `S`.

`binding.js`/`vcmac.js`/`index.js` (the mac ADDON engine, setConfig/setMediaConfig/getVideoFrame) is
legacy — not loaded by any process — so the earlier binding-swap patch is inert. Do not use it.

## Architecture

### 1. `app/native/zcall-engine/main-engine.js` (new) — event-driven main-process engine
Replaces the child engine `N`. Reuses `requestcall.js`/`call-control.js`/`media-session.js`/`zaudio`.
```
createMainEngine({ sendToRender, MediaSession?, ZAudio? })
  sendToRender(msg)   // = { type:'sendSignal'|'update', command, data } → the main.js emit path
  .handleSendToNative(t)   // = the S(t) input: makeCall intent / signal result (config) / control
  .start() / .stop()
```
Flow (event-driven, no promises across the IPC boundary):
- `handleSendToNative({type:'request',command:'makeCall',data:{partner:[{id}],type}})` →
  `callId=random`; `sendToRender({type:'sendSignal', command:401, data:{calleeId,callId,codec:'[]',type}})`.
- `handleSendToNative(<the 401 result: the requestcall config>)` (arriving via `handleRecvSignal`→S) →
  `parseConfig` → `MediaSession.open()` (InitZRTP) → `buildExtendData` →
  `sendToRender({type:'sendSignal', command:416, data:{rtcpAddress,rtpAddress:selectedRelay,
  codec:OPUS_CODEC, extendData, session:sessId, callId}})` → phone rings.
- `handleSendToNative({type:'control', data:{act:'answer', ...}})` →
  `sendToRender({type:'sendSignal', command:408, data:{calleeId,callId}})` + start `ZAudio`
  (mic→opus→`MediaSession.send`) and `session.on('media', → ZAudio.play)`.
- `end_call` → `sendToRender({type:'sendSignal', command:409, ...})` + teardown.
- Emits `{type:'update', ...}` for in-call UI state (ringing/connected/ended) via `call-update`.

Correlating the 401 result to the pending call: the RE'd `handleRecvSignal(command, res)` message
carries the callId; the engine keys the pending state machine on callId (RE the exact `S` payload
shape for the 401 result during impl — diag-log samples exist).

### 2. `scripts/patches/patch-zcall-main-engine.js` (new) — patch main.js
- Anchor on the minified `ipcMain.on("call-send-to-native", …)` registration + the `w`/emit path in
  the call module. Inject: load our engine; route `S(t)` (the `call-send-to-native` data) →
  `engine.handleSendToNative(t)`; give the engine `sendToRender = ({type,command,data}) =>
  w.webContents.send(type==='update'?'call-update':'call-send-signal', command, data)` (reuse the
  existing forwarding semantics); **neuter the child-process spawn** in `W()` so it doesn't try to
  launch the missing binary.
- Copy `main-engine.js` + reused modules (`requestcall`, `call-control`, `zpw`, `cdp-invoke`,
  `media-session`, `initzrtp`, `rtp`, `media-frame`, `srtp-*`, `zsrtp.js`, `zaudio.js`) + the two
  Electron-built `.node` into an app dir the main process can require. Idempotent, fail-loud.
- Supersede `patch-zcall-linux-engine.js` in the pipeline (that binding swap is inert).

### 3. Electron build + deb
`nativelibs/builder.js` builds `zsrtp`+`zaudio` for Electron (already wired); the deb bundles the
engine + modules + `.node` (no new Depends).

## Data flow
```
call button → makeCall → IPC call-send-to-native → main.js S(t) → engine.handleSendToNative
  → sendToRender(sendSignal 401) → render handleSendSignal → requestCall → handleRecvSignal → S → engine
  → MediaSession.open()/InitZRTP → sendToRender(sendSignal 416, extendData) → PHONE RINGS
  → answer → S(control answer) → engine → sendToRender(sendSignal 408) + MediaSession+ZAudio = TWO-WAY AUDIO
```

## Testing
- **Offline (suite):** `main-engine.js` with **mocked** `sendToRender` + injected fake
  `MediaSession`/`ZAudio` — feed makeCall, then the config, then answer; assert it emits
  `sendSignal 401 → 416 (well-formed extendData) → 408` in order and tears down on end_call. No
  device/network/addon.
- **Live (operator):** click the call button in the app → phone rings → answer → two-way audio.

## Open items (RE during impl)
- The exact `S` payload the render sends for the **401 result (config)** via `handleRecvSignal`
  (diag-log samples exist) — to route it into the engine keyed by callId.
- The minified **anchors** in `main.js` (the `call-send-to-native` handler, `w`, the `W()` spawn of
  `N`) for a robust, idempotent, fail-loud patch.
- Audio device from the **main** process (miniaudio should work; main has Node) — verify live.

## What this does NOT cover
- Incoming calls (`onCallRequest`/callee media) — 4b. Video, screen share, AEC.

## Success criteria
1. `main-engine.js` mock state-machine test passes (401→416→408 ordering + extendData).
2. `zsrtp`/`zaudio` build for Electron; deb bundles them (no new Depends).
3. Clicking the app call button places a real outgoing call with **two-way audio**.
