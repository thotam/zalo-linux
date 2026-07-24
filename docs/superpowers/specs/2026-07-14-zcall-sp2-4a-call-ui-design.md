# zcall SP2 4a-UI — Linux Audio Call Window (pixel-match macOS/Windows)

**Status:** design (brainstorming complete, awaiting user spec review)
**Date:** 2026-07-14
**Depends on:** SP2 4a functional engine (`tools/zcall-engine/main-engine.js`, `patch-zcall-main-engine.js`) — a real two-way audio call already works from the app call button on Linux; the only gap is the on-screen call window.

## Goal

When the user places a 1-1 **audio** call on Linux, show an on-screen call window that is visually identical to the macOS/Windows Zalo Call window, driven by the existing main-process engine, with working **End**, **Mute**, and **mic/speaker device selection**.

## Background / why custom

The macOS/Windows 1-1 call UI is drawn by a **native Qt Widgets helper** (`ZaloHelper.app/Contents/MacOS/ZaloCall` / `ZaloCall.exe`), spawned as a child process and socket-connected. That binary is **absent on Linux** (mac/win only), and the app's render JS has **no** 1-1 call screen to trigger (render `makeCall` only `_sendToNative`; only a GROUP_CALL modal exists). So the Linux call window must be **built custom** — there is no app UI to reuse or unlock.

The functional call already works headless. This sub-project adds only the window.

## Global Constraints

- Respond/comment in Vietnamese where prose; keep code/paths/identifiers English.
- **No `Co-Authored-By` / "Generated with" / 🤖** in any commit, PR, or output.
- Commit only when the user explicitly asks.
- ToS/safety: operator's own account/machine/traffic/phone only; per-call sessId/keys/relay addresses/pcap are ephemeral secrets that stay LOCAL and are never committed.
- Build native addons against Electron 39.8.10 ABI via `nativelibs/builder.js`.
- Reuse the app's own icons — do not redraw. Control glyphs come from the app's icon font `app/pc-dist/fonts/zalo-font.*.ttf` (already shipped), referenced by the same `fa-*` codepoints the app uses. No icon binary is committed to the repo; the patch copies the `.ttf` from the extracted app at build time. Only the small codepoint CSS map lives in the repo.

## Reference (from real Windows screenshots)

Window ~456×720 portrait, frameless, native win32 min/max/close (already provided by `patch-titlebar-controls`), title `Zalo Call - {name}`.

| Element | Spec |
| --- | --- |
| Title bar | ~32px, white, `border-bottom:1px solid #e1e4ea`; left: small Zalo-call glyph + `Zalo Call - {name}` dark bold; right: native window controls |
| Background | partner avatar, scaled to cover + blurred; **fallback = Zalo-blue gradient `#0068ff`** when no avatar |
| Avatar (center) | circle ~180px, thin white border, slightly above vertical center |
| Ringing state | animated loading **arc** around avatar + caption `Đang nối máy đến {name}` (white) |
| Connected state | no arc; **timer badge** top-left (dark-green pill, white `MM:SS`, counts up from connect) |
| Ended state | caption `Kết thúc` + dark toast `{name} đã kết thúc cuộc gọi.` |
| Bottom bar | floating pill, `rgba(255,255,255,.92)`, rounded; left→right: `📷 camera ▾` · **🔴 end-call** (red `#EF4E49`, center) · `🎤 mic ▾` · (spacer) · `⚙️ gear` (right) |
| Device dropdown | `Chọn micro` / device list (✓ default) / `Chọn loa` / device list (✓ default) / `Mở cài đặt` |

Colors: `#0068ff` (Zalo blue), `#EF4E49`/`#FF1415` (red end-call), `#001a33`, `#e1e4ea`, `#f4f5f7`. Fonts: Inter / Segoe UI / Roboto stack.

## Functional scope (this sub-project)

**Working:** End-call, Mute mic, mic-device select, speaker-device select, live states (ringing → connected+timer → ended), partner name + avatar.
**Parity (visible, wired later):** camera button, "Mở cài đặt" / gear, video.
**Excluded:** video UI, incoming calls (4b).

## Architecture

Three layers, all reusing the existing engine/IPC:

### 1. Native — ZAudio additions (`nativelibs/zaudio/src/zaudio.cpp`)

Add to the `ZAudio` N-API class (offline-testable codec path unchanged):

- `setMute(bool)` — sets a `muted_` flag. In `DataCB` capture branch, when muted, clear `capAccum_` and skip encode/send (phone stops hearing us). Default false.
- `listDevices()` → `{ capture:[{index,name,isDefault}], playback:[{index,name,isDefault}] }`. Uses a persistent per-instance `ma_context_`; `ma_context_get_devices`; caches the `ma_device_id` values (copied by value) into `captureIds_`/`playbackIds_` so a later start can reference them by index. Empty lists on a headless host are valid (not an error).
- `setInputDevice(index)` / `setOutputDevice(index)` — store selected index (`-1` = system default). If the device is running, restart `ma_device_` in place (uninit → re-init `cfg.capture.pDeviceID`/`cfg.playback.pDeviceID` from cached ids → start) while preserving `tsfn_`, `capAccum_`, `playBuf_`.

`Start` uses the selected ids when set (else `NULL` = default), unchanged otherwise.

### 2. Main-process UI controller (`tools/zcall-ui/call-ui.js`)

`createCallUI({ BrowserWindow, ipcMain, htmlPath, screen? })` → controller:

- `show(partner)` — create a frameless, non-resizable ~456×720 `BrowserWindow` (`alwaysOnTop`, `skipTaskbar:false`), load `call.html` via `file://`, send `partner` `{name, avatar}` once ready.
- `setState(state, data)` — forward `{state, ...data}` to the window: `calling` | `connected` (with `connectedAt`) | `ended` | `free`.
- `setDevices({capture, playback, selectedIn, selectedOut})` — populate the dropdowns.
- `on(event, cb)` / `close()` — `event` ∈ `end`, `mute`(bool), `selectInput`(index), `selectOutput`(index), `openSettings`, `toggleCamera`.

IPC channels (unique-prefixed to avoid clashing with app channels):
- window → main: `zcall-ui:action` `{action, value}` (via a small `preload.js` `contextBridge`, `nodeIntegration:false`, `contextIsolation:true`).
- main → window: `zcall-ui:partner`, `zcall-ui:state`, `zcall-ui:devices`.

The window renderer (`tools/zcall-ui/call.html` + `call.css` + `call.js`) owns all visuals: blurred bg / gradient fallback, avatar, ringing arc, connected timer (its own `setInterval` from `connectedAt`), ended toast, bottom pill, device dropdown.

**Icons = the app's own icon font.** `call.css` `@font-face`s `assets/zalo-font.ttf` (copied by the patch from `app/pc-dist/fonts/zalo-font.*.ttf`) and renders each control glyph via its real `fa-*` codepoint (`icons.css` codepoint map, committed):

| Control | codepoint | app glyph |
| --- | --- | --- |
| End-call (round red) | `\edeb` | `videocall_btn_end` |
| Mic on / off | `\ec59` / `\ec5b` | `Mic_24_Filled` / `Mic-off_24_Filled` |
| Camera on / off | `\edf4` / `\edf3` | `videocall_video_on` / `_off` |
| Speaker on / off | `\ed5e` / `\ed5f` | `Speaker_s2_24_Filled` / `SpeakerOff_24_Filled` |
| Settings gear | `\ed1a` | `Setting_24_Line` |
| Chevron up / down | `\ea8d` / `\ea87` | `Chevron_Up/Down_24_Line` |
| Answer (4b) | `\eded` | `videocall_popup_btn_answer` |

(Exact end-call glyph confirmed against the screenshot at implementation; the em-1000 font renders crisp at any size.)

### 3. Engine integration (`tools/zcall-engine/main-engine.js`)

- Accept `opts.ui` (a `createCallUI` controller; optional — engine still works headless if absent, so existing tests pass unchanged).
- In `handleSendToNative` makeCall: capture `current.partner = { id, name: p.name||p.dName||p.displayName||String(p.id), avatar: p.avatar||p.avatarUrl||null }`.
- On `open OK` (ring, emit 416): `ui.show(current.partner); ui.setState('calling', {name})` and, once `audio` exists, `ui.setDevices(audio.listDevices()-shaped result)`.
- On answer (408): `ui.setState('connected', {connectedAt: Date.now()})`.
- On teardown: `ui.setState('ended', {name})`, then `ui.close()` after ~1.2s.
- Wire `ui.on`: `end` → `teardown` + emit 409; `mute` → `audio.setMute(v)`; `selectInput`→`audio.setInputDevice`; `selectOutput`→`audio.setOutputDevice`; `openSettings`/`toggleCamera` → no-op log (parity).

### 4. Patch wiring (`scripts/patches/patch-zcall-main-engine.js`)

- Extend `REPLACEMENT` so the engine is created with `ui: _R(callUiPath).createCallUI({ BrowserWindow, ipcMain, htmlPath })` using `require('electron')` `BrowserWindow`/`ipcMain` (available in main process) and the copied `call.html` path under `app/native/zcall-ui/`.
- Add `tools/zcall-ui/**` to the copy list → `app/native/zcall-ui/`.
- Copy the app icon font: glob `app/pc-dist/fonts/zalo-font.*.ttf` → `app/native/zcall-ui/assets/zalo-font.ttf` (fail-loud if not found — signals the render bundle layout changed).
- Keep the existing marker/idempotency/fail-loud contract.

## Data flow

```
click call → makeCall (partner{name,avatar}) → engine 401
   → recvSignal 401 config → MediaSession.open → 416(ring)
        → ui.show(partner) + setState('calling') + setDevices(list)
   → answer 408 → ui.setState('connected', connectedAt)   [window runs timer]
   → window End button → zcall-ui:action{end} → engine teardown + 409 → ui 'ended' → close
   → window Mic button → zcall-ui:action{mute} → ZAudio.setMute
   → window device pick → zcall-ui:action{selectInput|selectOutput} → ZAudio.setInputDevice/OutputDevice
```

## Error handling

- No avatar / load failure → gradient fallback (already the CSS default; avatar layered on top, `onerror` hides it).
- `listDevices()` empty (headless) → dropdown shows only "Thiết bị mặc định". No throw.
- Engine created without `ui` (unit tests, headless CLI) → all `ui?.` calls are guarded no-ops.
- Window closed by the OS while a call is live → treated as `end`.
- `BrowserWindow`/`ipcMain` unavailable → controller construction is wrapped; engine falls back to headless (logs, no window).

## Testing

- **ZAudio native** (`nativelibs/zaudio/__tests__`): existing opus round-trip unchanged; new test asserts `setMute` toggles without throwing and `listDevices()` returns the `{capture,playback}` shape (arrays; may be empty) — runs headless in CI.
- **call-ui.js** (`tools/zcall-ui/__tests__/call-ui.test.js`): inject fake `BrowserWindow`/`ipcMain`; assert `show` creates a window + loads the html path; `setState`/`setDevices` send the right channels; a simulated `zcall-ui:action` fires the mapped `on(event)` callback; `close` destroys the window.
- **main-engine.js** (`tools/zcall-engine/__tests__/main-engine.test.js`): extend with a fake `ui` capturing calls; assert ring→`show`+`calling`, answer→`connected`, teardown→`ended`+`close`, and End/Mute/device actions route to teardown/`audio.setMute`/`audio.setInputDevice`. Existing no-`ui` assertions stay green.
- **patch** (`scripts/patches/__tests__/patch-zcall-main-engine.test.js`): assert the patched source references `createCallUI` and `zcall-ui`, still idempotent + fail-loud.
- **Renderer**: `call.html` opens standalone in a browser for visual iteration; final pixel-match verified live against the provided screenshots (ringing / connected+timer / ended).
- **Live**: real call → window appears, states transition, End/Mute/device-select work.

## File structure

```
tools/zcall-ui/
  call-ui.js                 # main-process controller (createCallUI)
  preload.js                 # contextBridge for the window
  call.html / call.css / call.js   # the window renderer
  icons.css                  # fa-* codepoint map (committed); zalo-font.ttf copied by patch
  __tests__/call-ui.test.js
nativelibs/zaudio/src/zaudio.cpp      # +setMute/listDevices/setInputDevice/setOutputDevice
nativelibs/zaudio/__tests__/...       # +mute/listDevices test
tools/zcall-engine/main-engine.js     # +ui integration
tools/zcall-engine/__tests__/main-engine.test.js  # +fake ui
scripts/patches/patch-zcall-main-engine.js        # +createCallUI wiring + copy zcall-ui
scripts/patches/__tests__/patch-zcall-main-engine.test.js
```
