# Linux voice/video call — diagnostics design

Date: 2026-07-12
Status: DESIGN (approved) — not yet implemented
Approach: Diagnostics-first (instrument, observe a real call, then fix in a follow-up)

## Background — how Zalo PC actually does calls (verified)

A deep static verification of the extracted app (`app/pc-dist`, `app/main-dist`) established:

- **`zcall_mac.node` is NOT the call engine.** The only usage of the native zcall module
  is `$znode.nativelibs.zcall().getListDevices()` (audio/video device enumeration for the
  picker). Every call-driving / video-rendering method of its JS wrapper
  (`setConfigData`, `bindCanvas`, `getVideoFrame(Local)`, `bindCallbackEventMessage`,
  `setListServers`, `getEventMessage`, `getJsonStats406`, …) has **zero** call sites
  anywhere in the app. So the SP1 "reverse ZRTP" direction is moot for enabling calls —
  that engine is legacy.
- **Real calls run in a `<webview>` loading Zalo's remote voice-call web app.** Evidence:
  `apiVoiceCallDomain: https://voicecall-wpa.${region}`, `createElement("webview", {ref: _webView, src, …})`,
  and the full signaling API `/api/voicecall/{requestcall,request,ringring,answer,answerack,cancel,endcall,holdreq,…}`
  (plus `/api/voicecall/group/*`). The **WebRTC media happens inside the webview** (Chromium),
  not in app code — there is no `getUserMedia`, no `mediaDevices`/`enumerateDevices`, no
  `RTCPeerConnection` used for calls (the one `RTCPeerConnection` is a `getLocalIP()`
  STUN-less IP-detection trick), and no `srcObject` anywhere.

**Implication for Linux:** the `<webview>` runs Chromium; the Linux build is Electron 39 =
Chromium 142 with full WebRTC. So the voicecall-wpa web app should run the same on Linux
**if** the webview is enabled and granted media. The exact gaps cannot be determined
statically (the call media is a remote web app + runtime-configured webview) — they must be
found empirically by running a real call on the Linux build.

## Static grounding for where fixes/instrumentation land

- The packaged `app/main-dist/main.js` creates several `BrowserWindow`s with
  `webPreferences:{… partition:"persist:zalo" …}`. **No `webviewTag` is set anywhere**
  (grep count 0) — yet the app uses `<webview>`, which Electron disables by default. So
  `<webview>` likely does not even attach on Linux without `webviewTag:true`.
- **No `setPermissionRequestHandler` exists anywhere** in the extracted app. Without a media
  permission grant on the `persist:zalo` session, `getUserMedia` inside the webview is denied.
- No existing `scripts/patches/*` touches webview / permissions / calls — this is net-new.

## Objective & scope boundary

Produce a **precise gap report** for Linux calls by instrumenting the call path (main
process), running one real 1‑1 call on the user's own account, and capturing diagnostics.

**Out of scope:** fixing the call feature (a separate follow-up task), reversing zcall/ZRTP
(irrelevant), touching Zalo infrastructure beyond what the app already does with the user's
own logged-in account, any third-party/other-user exposure.

## What to instrument (Electron main process)

A diagnostics module wired in the main process — it observes without altering the remote web
app:

1. **Webview lifecycle** — `app.on('web-contents-created', (_, contents) => …)`: for
   `contents.getType() === 'webview'`, log `did-attach-webview`, `did-finish-load`,
   `did-fail-load` (errorCode/description/validatedURL — is it the voicecall-wpa URL?),
   `console-message` (level/message/line/source — captures in-webview errors like
   `getUserMedia` NotAllowedError), and `render-process-gone`/`unresponsive`.
2. **Permission requests** — `session.fromPartition('persist:zalo').setPermissionRequestHandler`
   (and, defensively, the webview's own session via `web-contents-created`): **log every
   request** (permission type, requesting URL) and **grant `media`** (mic/cam) so the run
   reveals the downstream chain rather than dead-ending at the permission gap. Granting media
   is itself a likely required fix; here it doubles as instrumentation. Also install
   `setPermissionCheckHandler` to log/allow synchronous checks.
3. **Enable `webviewTag: true`** in the relevant `BrowserWindow` webPreferences (without it
   the `<webview>` cannot attach, so nothing downstream is observable) and log whether an
   attach actually occurs.
4. **`getListDevices`** — log the Linux result (currently `{error:'not support'}` because the
   zcall binding returns the not-support object on Linux) and whether the pre-call device
   picker errors on it.

All output goes to a single file (`$ZALO_CALL_LOG` or `~/zalo-call-diag.log`), append-only,
fail-open (never breaks the app), with a per-line timestamp + process role — mirroring the
existing native-lib logging harness style.

## Where it lands

A new **diagnostics-only** patch `scripts/patches/patch-call-diagnostics.js` (applied on a
diagnostics branch, not the shipping build):
- edits `app/main-dist/main.js` — set `webviewTag:true` on the app window(s) that host the
  call webview; and
- injects/writes a small main-process instrumentation module (the `web-contents-created`
  handler + permission logger + file logger) and requires it early in main startup.

Idempotent, fail-loud on anchor drift (like the other patches), removed before any shipping
build.

## Data flow (the empirical loop)

1. Build the Linux `.deb` with the diagnostics patch.
2. User logs in with their own account, places a real 1‑1 call (Linux ↔ their own phone),
   audio then video.
3. User sends `~/zalo-call-diag.log`.
4. We read it → enumerate the exact gaps in order (did the webview attach? did it load the
   voicecall-wpa URL or fail? what console errors? were media permissions requested/granted?
   did the device picker break?).

## Deliverable & success criteria

- The diagnostics patch + instrumentation module (committed on the diagnostics branch).
- A **gap report** appended to this spec (or a sibling doc) after the user's run: the ordered
  list of what breaks, each tied to a concrete log line, and the concrete fix each implies.
- Success = we can name every blocker between "click call" and "media flowing" on Linux,
  from real log evidence — enough to write a targeted "fix Linux calls" plan next.

## Error handling & safety

- The logger and all hooks are wrapped fail-open — a diagnostics error must never break the
  app or a call.
- Granting media permission is scoped to the app's own `persist:zalo` session for the user's
  own call; no third party is involved.
- Diagnostics-only: this patch is not part of the shipping E39 build and is reverted/omitted
  before release.
- Interop framing: we run a client we use, on the user's own accounts, on a platform Zalo
  doesn't officially support; we do not attack, probe, or reimplement Zalo infrastructure.

## Testing

- The patch itself: a unit test (like the other patch tests) asserting the anchor edit
  (`webviewTag:true`) applies + is idempotent + fails loud on anchor drift, and that the
  injected module is valid JS.
- The real validation is the empirical call run (user-driven), producing the log.
