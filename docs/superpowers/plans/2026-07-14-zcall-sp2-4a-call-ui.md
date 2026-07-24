# zcall SP2 4a-UI — Linux Audio Call Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an on-screen 1-1 audio call window on Linux, visually identical to the macOS/Windows Zalo Call window, driven by the existing main-process engine, with working End / Mute / mic+speaker selection.

**Architecture:** Three layers. (1) Native ZAudio (`nativelibs/zaudio`) gains `setMute` + device enumeration/selection. (2) A `tools/zcall-ui/` window: a main-process controller (`call-ui.js`) opens a frameless `BrowserWindow` and talks to it over unique-prefixed IPC; the renderer (`call.html`/`call.css`/`call.js`) draws the UI using the app's own icon font. (3) The engine (`main-engine.js`) drives the window through an injected `opts.ui` controller (guarded — headless still works), and the patch (`patch-zcall-main-engine.js`) wires it and copies the assets.

**Tech Stack:** Node/Electron 39.8.10, N-API (node-addon-api 8) + miniaudio 0.11 + libopus, plain HTML/CSS/JS renderer, plain `node`/`assert` tests.

## Global Constraints

- Respond/comment in Vietnamese where prose; keep code/paths/identifiers English.
- No `Co-Authored-By` / "Generated with" / 🤖 in any commit, PR, or output.
- Commit only when the user explicitly asks. (This plan's commit steps stage + commit locally; that IS the explicit request for the execution run.)
- ToS/safety: operator's own account/machine/traffic/phone only; per-call sessId/keys/relay addresses/pcap are ephemeral secrets that stay LOCAL and are never committed.
- Build native addons against Electron 39.8.10 ABI via `nativelibs/builder.js` (the patch does this). Unit tests build against Node ABI via `npm run build`.
- Reuse the app's own icons — do not redraw. Glyphs come from `app/pc-dist/fonts/zalo-font.*.ttf` referenced by the same `fa-*` codepoints the app uses. No icon binary committed; the patch copies the `.ttf` from the extracted app at build time. Only the codepoint CSS map lives in the repo.

---

### Task 1: ZAudio — `setMute`

**Files:**
- Modify: `nativelibs/zaudio/src/zaudio.cpp` (class members, `Init`, `DataCB`, new `SetMute`)
- Test: `nativelibs/zaudio/__tests__/mute-devices.test.js` (create)

**Interfaces:**
- Produces: `ZAudio.prototype.setMute(bool)` — when true, captured mic PCM is dropped (not encoded/sent); default false.

- [ ] **Step 1: Write the failing test**

Create `nativelibs/zaudio/__tests__/mute-devices.test.js`:

```js
const assert = require('assert');
const path = require('path');
const { ZAudio } = require(path.join(__dirname, '..', 'build', 'Release', 'zaudio.node'));

const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });

// setMute exists and is safe to toggle without a running device.
assert.strictEqual(typeof a.setMute, 'function', 'setMute is a method');
a.setMute(true);
a.setMute(false);
a.setMute(true);

console.log('OK zaudio setMute');
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd nativelibs/zaudio && npm run build:deps >/dev/null 2>&1; npm run build && node __tests__/mute-devices.test.js
```
Expected: FAIL — `TypeError: a.setMute is not a function`.

- [ ] **Step 3: Add the `muted_` member + `SetMute` method + register it**

In `nativelibs/zaudio/src/zaudio.cpp`, add to the private members (near `double micGain_`):

```cpp
  bool muted_ = false;              // when true, captured mic PCM is dropped before encode
```

Add the method declaration (near `void Stop(...)`):

```cpp
  void SetMute(const Napi::CallbackInfo& info);
```

Register it in `ZAudio::Init` (add to the `DefineClass` method list):

```cpp
    InstanceMethod("setMute", &ZAudio::SetMute),
```

Add the implementation (after `Stop`):

```cpp
void ZAudio::SetMute(const Napi::CallbackInfo& info) {
  if (info.Length() > 0) muted_ = info[0].ToBoolean().Value();
}
```

- [ ] **Step 4: Drop mic PCM in `DataCB` when muted**

In `ZAudio::DataCB`, wrap the capture-accumulate block. Replace:

```cpp
  if (in) {
    const opus_int16* mic = static_cast<const opus_int16*>(in);
```

with:

```cpp
  if (in && self->muted_) {
    self->capAccum_.clear();   // muted: discard mic, send nothing
  }
  if (in && !self->muted_) {
    const opus_int16* mic = static_cast<const opus_int16*>(in);
```

(The existing block body and its closing `}` stay unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd nativelibs/zaudio && npm run build && node __tests__/mute-devices.test.js
```
Expected: PASS — `OK zaudio setMute`.

- [ ] **Step 6: Verify the existing codec test still passes**

Run: `cd nativelibs/zaudio && node __tests__/opus-roundtrip.test.js`
Expected: PASS — `OK zaudio opus-roundtrip (...)`.

- [ ] **Step 7: Commit**

```bash
git add nativelibs/zaudio/src/zaudio.cpp nativelibs/zaudio/__tests__/mute-devices.test.js
git commit -m "zcall 4a-ui: ZAudio.setMute (drop mic PCM while muted)"
```

---

### Task 2: ZAudio — device enumeration + selection

**Files:**
- Modify: `nativelibs/zaudio/src/zaudio.cpp` (members, `Init`, `Start`, new `ListDevices`/`SetInputDevice`/`SetOutputDevice`/`EnsureContext`/`InitAndStartDevice`/`RestartDevice`)
- Test: `nativelibs/zaudio/__tests__/mute-devices.test.js` (extend)

**Interfaces:**
- Produces:
  - `ZAudio.prototype.listDevices()` → `{ capture: Array<{index:number,name:string,isDefault:boolean}>, playback: Array<...> }` (arrays may be empty on a headless host — not an error).
  - `ZAudio.prototype.setInputDevice(index:number)` / `setOutputDevice(index:number)` — `index` is into the matching `listDevices()` array; `-1` = system default. Applied on next `start()`, or immediately (device restarted in place) if already running.

- [ ] **Step 1: Extend the test (failing)**

Append to `nativelibs/zaudio/__tests__/mute-devices.test.js` (before the final `console.log`):

```js
// Device enumeration — shape only; a headless host may report zero devices.
assert.strictEqual(typeof a.listDevices, 'function', 'listDevices is a method');
const d = a.listDevices();
assert.ok(d && Array.isArray(d.capture) && Array.isArray(d.playback), 'listDevices() -> {capture:[],playback:[]}');
for (const dev of d.capture.concat(d.playback)) {
  assert.strictEqual(typeof dev.index, 'number', 'device.index');
  assert.strictEqual(typeof dev.name, 'string', 'device.name');
  assert.strictEqual(typeof dev.isDefault, 'boolean', 'device.isDefault');
}
// Selection setters are safe without a running device.
assert.strictEqual(typeof a.setInputDevice, 'function', 'setInputDevice is a method');
assert.strictEqual(typeof a.setOutputDevice, 'function', 'setOutputDevice is a method');
a.setInputDevice(-1);
a.setOutputDevice(-1);
a.setInputDevice(0);
```

Update the final line to:

```js
console.log('OK zaudio mute+devices (cap ' + d.capture.length + ', play ' + d.playback.length + ')');
```

Run: `cd nativelibs/zaudio && node __tests__/mute-devices.test.js`
Expected: FAIL — `TypeError: a.listDevices is not a function`.

- [ ] **Step 2: Add members for context + cached ids + selection**

In `nativelibs/zaudio/src/zaudio.cpp`, add to the private members (near `ma_device device_;`):

```cpp
  ma_context context_;
  bool ctxInit_ = false;
  std::vector<ma_device_id> captureIds_, playbackIds_;   // parallel to listDevices() indices
  int selCapture_ = -1, selPlayback_ = -1;               // -1 = system default
```

Add method declarations (near the others):

```cpp
  Napi::Value ListDevices(const Napi::CallbackInfo& info);
  void SetInputDevice(const Napi::CallbackInfo& info);
  void SetOutputDevice(const Napi::CallbackInfo& info);
  bool EnsureContext();
  bool InitAndStartDevice();
  void RestartDevice();
```

- [ ] **Step 3: Register the new methods**

In `ZAudio::Init`, add to the `DefineClass` list:

```cpp
    InstanceMethod("listDevices", &ZAudio::ListDevices),
    InstanceMethod("setInputDevice", &ZAudio::SetInputDevice),
    InstanceMethod("setOutputDevice", &ZAudio::SetOutputDevice),
```

- [ ] **Step 4: Implement context + enumeration + selection + device (re)start**

Add these implementations after `SetMute` in `nativelibs/zaudio/src/zaudio.cpp`:

```cpp
bool ZAudio::EnsureContext() {
  if (ctxInit_) return true;
  if (ma_context_init(NULL, 0, NULL, &context_) != MA_SUCCESS) return false;
  ctxInit_ = true;
  return true;
}

Napi::Value ZAudio::ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  Napi::Array cap = Napi::Array::New(env), play = Napi::Array::New(env);
  captureIds_.clear(); playbackIds_.clear();
  ma_device_info* pPlay = nullptr; ma_uint32 nPlay = 0;
  ma_device_info* pCap = nullptr;  ma_uint32 nCap = 0;
  if (EnsureContext() &&
      ma_context_get_devices(&context_, &pPlay, &nPlay, &pCap, &nCap) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < nCap; i++) {
      captureIds_.push_back(pCap[i].id);
      Napi::Object d = Napi::Object::New(env);
      d.Set("index", (int)i); d.Set("name", pCap[i].name); d.Set("isDefault", (bool)pCap[i].isDefault);
      cap.Set(i, d);
    }
    for (ma_uint32 i = 0; i < nPlay; i++) {
      playbackIds_.push_back(pPlay[i].id);
      Napi::Object d = Napi::Object::New(env);
      d.Set("index", (int)i); d.Set("name", pPlay[i].name); d.Set("isDefault", (bool)pPlay[i].isDefault);
      play.Set(i, d);
    }
  }
  out.Set("capture", cap); out.Set("playback", play);
  return out;
}

bool ZAudio::InitAndStartDevice() {
  ma_device_config cfg = ma_device_config_init(ma_device_type_duplex);
  cfg.sampleRate = sampleRate_;
  cfg.capture.format = ma_format_s16;  cfg.capture.channels = channels_;
  cfg.playback.format = ma_format_s16; cfg.playback.channels = channels_;
  cfg.periodSizeInFrames = frameSamples_;
  cfg.dataCallback = &ZAudio::DataCB;
  cfg.pUserData = this;
  if (selCapture_  >= 0 && selCapture_  < (int)captureIds_.size())  cfg.capture.pDeviceID  = &captureIds_[selCapture_];
  if (selPlayback_ >= 0 && selPlayback_ < (int)playbackIds_.size()) cfg.playback.pDeviceID = &playbackIds_[selPlayback_];
  ma_context* ctx = EnsureContext() ? &context_ : NULL;
  if (ma_device_init(ctx, &cfg, &device_) != MA_SUCCESS) return false;
  if (ma_device_start(&device_) != MA_SUCCESS) { ma_device_uninit(&device_); return false; }
  return true;
}

void ZAudio::RestartDevice() {
  if (running_) { ma_device_uninit(&device_); running_ = false; }
  if (InitAndStartDevice()) running_ = true;
}

void ZAudio::SetInputDevice(const Napi::CallbackInfo& info) {
  selCapture_ = (info.Length() > 0) ? info[0].As<Napi::Number>().Int32Value() : -1;
  if (running_) RestartDevice();
}

void ZAudio::SetOutputDevice(const Napi::CallbackInfo& info) {
  selPlayback_ = (info.Length() > 0) ? info[0].As<Napi::Number>().Int32Value() : -1;
  if (running_) RestartDevice();
}
```

- [ ] **Step 5: Route `Start` through the shared device init**

In `ZAudio::Start`, replace the device-init/start block:

```cpp
  ma_device_config cfg = ma_device_config_init(ma_device_type_duplex);
  cfg.sampleRate = sampleRate_;
  cfg.capture.format = ma_format_s16;  cfg.capture.channels = channels_;
  cfg.playback.format = ma_format_s16; cfg.playback.channels = channels_;
  cfg.periodSizeInFrames = frameSamples_;
  cfg.dataCallback = &ZAudio::DataCB;
  cfg.pUserData = this;
  if (ma_device_init(NULL, &cfg, &device_) != MA_SUCCESS) { tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); Napi::Error::New(env, "ma_device_init failed").ThrowAsJavaScriptException(); return; }
  if (ma_device_start(&device_) != MA_SUCCESS) { ma_device_uninit(&device_); tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); Napi::Error::New(env, "ma_device_start failed").ThrowAsJavaScriptException(); return; }
  running_ = true;
```

with:

```cpp
  if (!InitAndStartDevice()) { tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); Napi::Error::New(env, "ma_device_init/start failed").ThrowAsJavaScriptException(); return; }
  running_ = true;
```

- [ ] **Step 6: Uninit the context in the destructor**

In `ZAudio::~ZAudio`, after the `if (running_) { ma_device_uninit(&device_); running_ = false; }` line, add:

```cpp
  if (ctxInit_) { ma_context_uninit(&context_); ctxInit_ = false; }
```

- [ ] **Step 7: Rebuild + run tests**

Run:
```bash
cd nativelibs/zaudio && npm run build && node __tests__/mute-devices.test.js && node __tests__/opus-roundtrip.test.js
```
Expected: PASS — `OK zaudio mute+devices (...)` and `OK zaudio opus-roundtrip (...)`.

- [ ] **Step 8: Commit**

```bash
git add nativelibs/zaudio/src/zaudio.cpp nativelibs/zaudio/__tests__/mute-devices.test.js
git commit -m "zcall 4a-ui: ZAudio device enumeration + input/output selection (miniaudio context)"
```

---

### Task 3: Renderer pure helpers (`call-format.js`)

**Files:**
- Create: `tools/zcall-ui/call-format.js`
- Test: `tools/zcall-ui/__tests__/call-format.test.js`

**Interfaces:**
- Produces (UMD — `module.exports` under node, `window.CallFormat` in the browser):
  - `formatDuration(sec:number)` → `"MM:SS"` (zero-padded, clamps negatives to 0, floors).
  - `statusText(state:string, name:string)` → caption string: `calling` → `"Đang nối máy đến {name}"`, `ended` → `"{name} đã kết thúc cuộc gọi."`, else `""`.

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-ui/__tests__/call-format.test.js`:

```js
const assert = require('assert');
const CF = require('../call-format.js');

assert.strictEqual(CF.formatDuration(0), '00:00');
assert.strictEqual(CF.formatDuration(9), '00:09');
assert.strictEqual(CF.formatDuration(75), '01:15');
assert.strictEqual(CF.formatDuration(3600), '60:00');
assert.strictEqual(CF.formatDuration(-5), '00:00');
assert.strictEqual(CF.formatDuration(9.8), '00:09');

assert.strictEqual(CF.statusText('calling', 'Tâm Tho'), 'Đang nối máy đến Tâm Tho');
assert.strictEqual(CF.statusText('connected', 'Tâm Tho'), '');
assert.ok(CF.statusText('ended', 'Tâm Tho').includes('đã kết thúc cuộc gọi'));
assert.strictEqual(CF.statusText('free', 'Tâm Tho'), '');

console.log('OK call-format');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-ui/__tests__/call-format.test.js`
Expected: FAIL — `Cannot find module '../call-format.js'`.

- [ ] **Step 3: Implement `call-format.js`**

Create `tools/zcall-ui/call-format.js`:

```js
// UMD pure helpers shared by the renderer (browser) and the node unit test.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CallFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function statusText(state, name) {
    name = name || '';
    if (state === 'calling') return 'Đang nối máy đến ' + name;
    if (state === 'ended') return name + ' đã kết thúc cuộc gọi.';
    return '';
  }
  return { formatDuration: formatDuration, statusText: statusText };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-ui/__tests__/call-format.test.js`
Expected: PASS — `OK call-format`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/call-format.js tools/zcall-ui/__tests__/call-format.test.js
git commit -m "zcall 4a-ui: renderer pure helpers (formatDuration/statusText)"
```

---

### Task 4: The window renderer (`call.html` + `call.css` + `icons.css` + `call.js` + `preload.js`)

**Files:**
- Create: `tools/zcall-ui/call.html`, `tools/zcall-ui/call.css`, `tools/zcall-ui/icons.css`, `tools/zcall-ui/call.js`, `tools/zcall-ui/preload.js`
- Test: `tools/zcall-ui/__tests__/renderer-structure.test.js`

**Interfaces:**
- Consumes: `window.CallFormat` (Task 3); `window.zcallUI` (exposed by `preload.js`).
- Produces: `preload.js` exposes `window.zcallUI = { onPartner(cb), onState(cb), onDevices(cb), action(name, value) }`. The renderer reacts to `zcall-ui:partner`/`:state`/`:devices` and emits `zcall-ui:action` `{action, value}` where `action ∈ end|mute|selectInput|selectOutput|openSettings|toggleCamera`.
- DOM ids the controller/tests rely on: `#bg #avatar #status #timer #btn-mic #btn-end #btn-cam #btn-gear #mic-menu`.

- [ ] **Step 1: Write the failing structural test**

Create `tools/zcall-ui/__tests__/renderer-structure.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'call.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'icons.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'call.js'), 'utf8');
const preload = fs.readFileSync(path.join(dir, 'preload.js'), 'utf8');

// html wires the stylesheets + scripts
for (const ref of ['icons.css', 'call.css', 'call-format.js', 'call.js']) {
  assert.ok(html.includes(ref), 'call.html references ' + ref);
}
// required DOM ids
for (const id of ['id="bg"', 'id="avatar"', 'id="status"', 'id="timer"', 'id="btn-mic"', 'id="btn-end"', 'id="btn-cam"', 'id="btn-gear"', 'id="mic-menu"']) {
  assert.ok(html.includes(id), 'call.html has ' + id);
}
// icon font wired + the real Zalo codepoints
assert.ok(/@font-face/.test(css) && css.includes('zalo-font.ttf'), 'icons.css @font-face zalo-font.ttf');
for (const cp of ['\\edeb', '\\ec59', '\\ec5b', '\\ed1a', '\\ea8d']) {
  assert.ok(css.includes(cp), 'icons.css defines codepoint ' + cp);
}
// renderer talks to the bridge for the two functional controls
assert.ok(js.includes("action('end'") || js.includes('action("end"'), 'call.js sends end');
assert.ok(js.includes("action('mute'") || js.includes('action("mute"'), 'call.js sends mute');
// preload exposes the bridge, no nodeIntegration leakage
assert.ok(preload.includes('exposeInMainWorld') && preload.includes('zcallUI'), 'preload exposes zcallUI');

console.log('OK renderer-structure');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-ui/__tests__/renderer-structure.test.js`
Expected: FAIL — `ENOENT ... call.html`.

- [ ] **Step 3: Create `preload.js`**

Create `tools/zcall-ui/preload.js`:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcallUI', {
  onPartner: (cb) => ipcRenderer.on('zcall-ui:partner', (_e, p) => cb(p)),
  onState:   (cb) => ipcRenderer.on('zcall-ui:state',   (_e, s) => cb(s)),
  onDevices: (cb) => ipcRenderer.on('zcall-ui:devices', (_e, d) => cb(d)),
  action:    (action, value) => ipcRenderer.send('zcall-ui:action', { action: action, value: value }),
});
```

- [ ] **Step 4: Create `icons.css`**

Create `tools/zcall-ui/icons.css` (the `.ttf` is copied next to it by the patch):

```css
@font-face {
  font-family: 'zalo-font';
  src: url('assets/zalo-font.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
}
.zic {
  font-family: 'zalo-font';
  font-style: normal;
  font-weight: normal;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  speak: none;
}
.zic::before { content: attr(data-glyph); }
.zic-endcall::before   { content: '\edeb'; }
.zic-mic::before       { content: '\ec59'; }
.zic-mic-off::before   { content: '\ec5b'; }
.zic-cam::before       { content: '\edf4'; }
.zic-cam-off::before   { content: '\edf3'; }
.zic-speaker::before   { content: '\ed5e'; }
.zic-gear::before      { content: '\ed1a'; }
.zic-chevron-up::before   { content: '\ea8d'; }
.zic-chevron-down::before { content: '\ea87'; }
```

- [ ] **Step 5: Create `call.css`**

Create `tools/zcall-ui/call.css` (colors/fonts from the spec; blurred-avatar bg with Zalo-blue gradient fallback):

```css
:root {
  --zalo-blue: #0068ff;
  --red-end: #ef4e49;
  --ink: #001a33;
  --line: #e1e4ea;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: 'Inter', 'Segoe UI', 'Roboto', system-ui, sans-serif;
  overflow: hidden;
  user-select: none;
  color: #fff;
}
#titlebar {
  height: 32px; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; background: #fff; color: var(--ink);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
#titlebar .tb-icon { width: 16px; height: 16px; color: var(--zalo-blue); }
#titlebar .tb-title { font-size: 13px; font-weight: 600; }
#stage {
  position: absolute; top: 32px; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  overflow: hidden;
  background: linear-gradient(160deg, #0068ff 0%, #004bb9 100%);   /* fallback */
}
#bg {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
  filter: blur(28px) brightness(0.75); transform: scale(1.15);
  opacity: 0; transition: opacity .25s;
}
#bg.on { opacity: 1; }
#avatar-wrap { position: relative; width: 184px; height: 184px; }
#avatar {
  position: absolute; inset: 8px; border-radius: 50%;
  background-size: cover; background-position: center;
  border: 3px solid rgba(255,255,255,.9);
  box-shadow: 0 6px 24px rgba(0,0,0,.25);
}
#ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 3px solid rgba(255,255,255,.35);
  border-top-color: #fff; display: none;
}
body[data-state="calling"] #ring { display: block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#status { margin-top: 18px; font-size: 15px; text-shadow: 0 1px 4px rgba(0,0,0,.4); min-height: 20px; }
#timer {
  position: absolute; top: 8px; left: 8px; display: none;
  background: #0b7a4b; color: #fff; font-size: 12px; font-weight: 600;
  padding: 2px 8px; border-radius: 3px;
}
body[data-state="connected"] #timer { display: block; }
#endtoast {
  position: absolute; display: none; background: rgba(0,0,0,.72); color: #fff;
  font-size: 13px; padding: 8px 14px; border-radius: 6px;
}
body[data-state="ended"] #endtoast { display: block; }
#bar {
  position: absolute; left: 16px; right: 16px; bottom: 16px; height: 56px;
  display: flex; align-items: center; gap: 10px; padding: 0 14px;
  background: rgba(255,255,255,.92); border-radius: 28px;
  box-shadow: 0 4px 18px rgba(0,0,0,.18);
}
.ctl {
  display: inline-flex; align-items: center; justify-content: center;
  border: none; cursor: pointer; background: transparent; color: var(--ink);
}
.ctl .zic { font-size: 22px; }
.round { width: 40px; height: 40px; border-radius: 50%; background: #f4f5f7; }
.round:hover { background: #e5efff; }
#btn-end { width: 48px; height: 48px; border-radius: 50%; background: var(--red-end); color: #fff; }
#btn-end .zic { font-size: 20px; }
.group { display: inline-flex; align-items: center; }
.chev { width: 20px; height: 40px; }
.chev .zic { font-size: 14px; }
.spacer { flex: 1; }
.btn-active { background: var(--red-end) !important; color: #fff !important; }  /* mic muted */
#mic-menu {
  position: absolute; left: 16px; bottom: 80px; display: none;
  background: #fff; color: var(--ink); border-radius: 8px; min-width: 240px;
  box-shadow: 0 6px 24px rgba(0,0,0,.2); padding: 8px 0; font-size: 13px;
}
#mic-menu.on { display: block; }
#mic-menu .mh { font-weight: 600; padding: 6px 14px; display: flex; gap: 8px; align-items: center; }
#mic-menu .mi { padding: 6px 14px 6px 34px; cursor: pointer; }
#mic-menu .mi:hover { background: #f4f5f7; }
#mic-menu .mi.sel { background: #e5efff; }
```

- [ ] **Step 6: Create `call.html`**

Create `tools/zcall-ui/call.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self'" />
  <link rel="stylesheet" href="icons.css" />
  <link rel="stylesheet" href="call.css" />
  <title>Zalo Call</title>
</head>
<body data-state="calling">
  <div id="titlebar">
    <span class="tb-icon zic zic-speaker"></span>
    <span class="tb-title" id="tb-title">Zalo Call</span>
  </div>
  <div id="stage">
    <div id="bg"></div>
    <div id="timer">00:00</div>
    <div id="avatar-wrap">
      <div id="ring"></div>
      <div id="avatar"></div>
    </div>
    <div id="status"></div>
    <div id="endtoast"></div>

    <div id="bar">
      <div class="group">
        <button class="ctl round" id="btn-cam"><span class="zic zic-cam"></span></button>
        <button class="ctl chev" id="cam-chev"><span class="zic zic-chevron-up"></span></button>
      </div>
      <button class="ctl" id="btn-end"><span class="zic zic-endcall"></span></button>
      <div class="group">
        <button class="ctl round" id="btn-mic"><span class="zic zic-mic"></span></button>
        <button class="ctl chev" id="mic-chev"><span class="zic zic-chevron-up"></span></button>
      </div>
      <span class="spacer"></span>
      <button class="ctl round" id="btn-gear"><span class="zic zic-gear"></span></button>
    </div>
    <div id="mic-menu"></div>
  </div>
  <script src="call-format.js"></script>
  <script src="call.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `call.js`**

Create `tools/zcall-ui/call.js`:

```js
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.zcallUI || { onPartner: function(){}, onState: function(){}, onDevices: function(){}, action: function(){} };
  var partner = { name: '', avatar: null };
  var timerIv = null, connectedAt = 0;
  var muted = false;
  var devices = { capture: [], playback: [] }, selIn = -1, selOut = -1;

  function setBg(url) {
    if (url) { $('bg').style.backgroundImage = 'url("' + url + '")'; $('bg').classList.add('on');
               $('avatar').style.backgroundImage = 'url("' + url + '")'; }
    else { $('bg').classList.remove('on'); $('avatar').style.backgroundImage = 'none'; }
  }

  api.onPartner(function (p) {
    partner = p || {};
    $('tb-title').textContent = 'Zalo Call' + (partner.name ? ' - ' + partner.name : '');
    setBg(partner.avatar);
    applyStatus(document.body.getAttribute('data-state'));
  });

  function applyStatus(state) {
    $('status').textContent = window.CallFormat.statusText(state, partner.name);
    if (state === 'ended') $('endtoast').textContent = partner.name + ' đã kết thúc cuộc gọi.';
  }

  function startTimer() {
    stopTimer();
    timerIv = setInterval(function () {
      $('timer').textContent = window.CallFormat.formatDuration((Date.now() - connectedAt) / 1000);
    }, 500);
  }
  function stopTimer() { if (timerIv) { clearInterval(timerIv); timerIv = null; } }

  api.onState(function (s) {
    var state = s && s.state || 'calling';
    document.body.setAttribute('data-state', state);
    applyStatus(state);
    if (state === 'connected') { connectedAt = (s && s.connectedAt) || Date.now(); startTimer(); }
    else if (state === 'ended' || state === 'free') { stopTimer(); }
  });

  api.onDevices(function (d) {
    devices = d || { capture: [], playback: [] };
    selIn = (d && typeof d.selectedIn === 'number') ? d.selectedIn : -1;
    selOut = (d && typeof d.selectedOut === 'number') ? d.selectedOut : -1;
    renderMenu();
  });

  function renderMenu() {
    var m = $('mic-menu');
    var html = '<div class="mh"><span class="zic zic-mic"></span>Chọn micro</div>';
    html += devItem('in', -1, 'Thiết bị mặc định', selIn === -1);
    devices.capture.forEach(function (dev) { html += devItem('in', dev.index, dev.name, selIn === dev.index); });
    html += '<div class="mh"><span class="zic zic-speaker"></span>Chọn loa</div>';
    html += devItem('out', -1, 'Thiết bị mặc định', selOut === -1);
    devices.playback.forEach(function (dev) { html += devItem('out', dev.index, dev.name, selOut === dev.index); });
    m.innerHTML = html;
    Array.prototype.forEach.call(m.querySelectorAll('.mi'), function (el) {
      el.addEventListener('click', function () {
        var kind = el.getAttribute('data-kind'), idx = parseInt(el.getAttribute('data-idx'), 10);
        if (kind === 'in') { selIn = idx; api.action('selectInput', idx); }
        else { selOut = idx; api.action('selectOutput', idx); }
        renderMenu();
      });
    });
  }
  function devItem(kind, idx, name, sel) {
    return '<div class="mi' + (sel ? ' sel' : '') + '" data-kind="' + kind + '" data-idx="' + idx + '">' +
           name.replace(/[<>&]/g, '') + '</div>';
  }

  $('btn-end').addEventListener('click', function () { api.action('end'); });
  $('btn-mic').addEventListener('click', function () {
    muted = !muted;
    $('btn-mic').classList.toggle('btn-active', muted);
    $('btn-mic').querySelector('.zic').className = 'zic ' + (muted ? 'zic-mic-off' : 'zic-mic');
    api.action('mute', muted);
  });
  $('mic-chev').addEventListener('click', function () { $('mic-menu').classList.toggle('on'); });
  $('btn-gear').addEventListener('click', function () { api.action('openSettings'); });
  $('btn-cam').addEventListener('click', function () { api.action('toggleCamera'); });
  $('cam-chev').addEventListener('click', function () { api.action('toggleCamera'); });
})();
```

- [ ] **Step 8: Run the structural test**

Run: `node tools/zcall-ui/__tests__/renderer-structure.test.js`
Expected: PASS — `OK renderer-structure`.

- [ ] **Step 9: Commit**

```bash
git add tools/zcall-ui/call.html tools/zcall-ui/call.css tools/zcall-ui/icons.css tools/zcall-ui/call.js tools/zcall-ui/preload.js tools/zcall-ui/__tests__/renderer-structure.test.js
git commit -m "zcall 4a-ui: call window renderer (html/css/js) using the app icon font"
```

---

### Task 5: Main-process UI controller (`call-ui.js`)

**Files:**
- Create: `tools/zcall-ui/call-ui.js`
- Test: `tools/zcall-ui/__tests__/call-ui.test.js`

**Interfaces:**
- Consumes: injected Electron `BrowserWindow` (class) + `ipcMain` (with `.on`/`.removeListener`), plus `htmlPath`, `preloadPath`.
- Produces: `createCallUI({ BrowserWindow, ipcMain, htmlPath, preloadPath }) → { show(partner), setState(state, data), setDevices(d), on(event, cb), close() }`.
  - `show(partner)` creates a 456×720 frameless `BrowserWindow` (or, if one is open, just re-sends the partner); sends `zcall-ui:partner` after `did-finish-load`.
  - `setState`/`setDevices` send `zcall-ui:state`/`zcall-ui:devices`.
  - Renderer `zcall-ui:action` `{action,value}` invokes the registered `on(action)` callback with `value`.
  - OS-closing the window fires the `end` callback once.

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-ui/__tests__/call-ui.test.js`:

```js
const assert = require('assert');
const path = require('path');
const { createCallUI } = require('../call-ui.js');

// Fake Electron
let lastWin = null;
class FakeWin {
  constructor(opts) {
    this.opts = opts; this.sent = []; this._on = {}; this._once = {}; this.destroyed = false; lastWin = this;
  }
  loadFile(p) { this.loaded = p; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  on(ev, cb) { this._on[ev] = cb; }
  once(ev, cb) { this._once[ev] = cb; }
  removeAllListeners(ev) { delete this._on[ev]; }
  get webContents() { const self = this; return {
    send: (ch, payload) => self.sent.push([ch, payload]),
    once: (ev, cb) => { self._once[ev] = cb; },
  }; }
  _finishLoad() { if (this._once['did-finish-load']) this._once['did-finish-load'](); }
  _osClose() { if (this._on['closed']) this._on['closed'](); }
}
const ipcHandlers = {};
const fakeIpc = {
  on: (ch, cb) => { ipcHandlers[ch] = cb; },
  removeListener: (ch, cb) => { if (ipcHandlers[ch] === cb) delete ipcHandlers[ch]; },
  _emit: (ch, msg) => { if (ipcHandlers[ch]) ipcHandlers[ch]({}, msg); },
};

const ui = createCallUI({ BrowserWindow: FakeWin, ipcMain: fakeIpc, htmlPath: '/x/call.html', preloadPath: '/x/preload.js' });

// show -> constructs a frameless 456x720 window, loads html, sends partner after finish-load
ui.show({ name: 'Tâm Tho', avatar: 'http://a/x.png' });
assert.ok(lastWin, 'window created');
assert.strictEqual(lastWin.opts.width, 456); assert.strictEqual(lastWin.opts.height, 720);
assert.strictEqual(lastWin.opts.frame, false, 'frameless');
assert.strictEqual(lastWin.opts.webPreferences.preload, '/x/preload.js', 'preload wired');
assert.strictEqual(lastWin.loaded, '/x/call.html', 'loadFile(html)');
lastWin._finishLoad();
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:partner' && m[1].name === 'Tâm Tho'), 'partner sent');

// setState / setDevices
ui.setState('connected', { connectedAt: 123 });
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:state' && m[1].state === 'connected' && m[1].connectedAt === 123), 'state sent');
ui.setDevices({ capture: [], playback: [], selectedIn: -1, selectedOut: -1 });
assert.ok(lastWin.sent.some(m => m[0] === 'zcall-ui:devices'), 'devices sent');

// renderer action -> registered handler
let ended = 0, muteVal = null;
ui.on('end', () => { ended++; });
ui.on('mute', (v) => { muteVal = v; });
fakeIpc._emit('zcall-ui:action', { action: 'mute', value: true });
assert.strictEqual(muteVal, true, 'mute handler got value');
fakeIpc._emit('zcall-ui:action', { action: 'end' });
assert.strictEqual(ended, 1, 'end handler fired');

// OS close fires end exactly once, and programmatic close does not
ui.show({ name: 'A' }); lastWin._finishLoad();
let osEnds = 0; ui.on('end', () => { osEnds++; });
lastWin._osClose();
assert.strictEqual(osEnds, 1, 'OS close -> end');

// programmatic close destroys and removes the ipc listener
ui.show({ name: 'B' }); lastWin._finishLoad();
let afterClose = 0; ui.on('end', () => { afterClose++; });
ui.close();
assert.ok(lastWin.destroyed, 'window destroyed on close()');
assert.strictEqual(afterClose, 0, 'close() does not fire end');

console.log('OK call-ui');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-ui/__tests__/call-ui.test.js`
Expected: FAIL — `Cannot find module '../call-ui.js'`.

- [ ] **Step 3: Implement `call-ui.js`**

Create `tools/zcall-ui/call-ui.js`:

```js
'use strict';
// Main-process controller for the Linux call window. Injected BrowserWindow/ipcMain keep it
// unit-testable offline. The engine drives it via show/setState/setDevices; window buttons come
// back through on(event, cb).
function createCallUI(opts) {
  opts = opts || {};
  var BrowserWindow = opts.BrowserWindow;
  var ipcMain = opts.ipcMain;
  var htmlPath = opts.htmlPath;
  var preloadPath = opts.preloadPath;
  var handlers = {};
  var win = null;
  var pendingPartner = null;

  function onAction(_e, msg) {
    if (!msg || !msg.action) return;
    var cb = handlers[msg.action];
    if (cb) { try { cb(msg.value); } catch (e) {} }
  }
  ipcMain.on('zcall-ui:action', onAction);

  function send(channel, payload) {
    if (win && !win.isDestroyed()) { try { win.webContents.send(channel, payload); } catch (e) {} }
  }

  return {
    show: function (partner) {
      pendingPartner = partner || {};
      if (win && !win.isDestroyed()) { send('zcall-ui:partner', pendingPartner); return; }
      win = new BrowserWindow({
        width: 456, height: 720, resizable: false, frame: false, alwaysOnTop: true,
        title: 'Zalo Call', backgroundColor: '#0068ff',
        webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true },
      });
      win.on('closed', function () {
        win = null;
        var cb = handlers['end']; if (cb) { try { cb(); } catch (e) {} }
      });
      win.webContents.once('did-finish-load', function () { send('zcall-ui:partner', pendingPartner); });
      win.loadFile(htmlPath);
    },
    setState: function (state, data) {
      var payload = { state: state };
      if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
      send('zcall-ui:state', payload);
    },
    setDevices: function (d) { send('zcall-ui:devices', d || {}); },
    on: function (event, cb) { handlers[event] = cb; },
    close: function () {
      if (win && !win.isDestroyed()) {
        var w = win; win = null;
        try { w.removeAllListeners('closed'); } catch (e) {}
        try { w.destroy(); } catch (e) {}
      }
      try { ipcMain.removeListener('zcall-ui:action', onAction); } catch (e) {}
    },
  };
}
module.exports = { createCallUI: createCallUI };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-ui/__tests__/call-ui.test.js`
Expected: PASS — `OK call-ui`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/call-ui.js tools/zcall-ui/__tests__/call-ui.test.js
git commit -m "zcall 4a-ui: main-process call window controller (createCallUI)"
```

---

### Task 6: Engine integration (`main-engine.js`)

**Files:**
- Modify: `tools/zcall-engine/main-engine.js`
- Test: `tools/zcall-engine/__tests__/main-engine.test.js` (extend)

**Interfaces:**
- Consumes: `opts.ui` — a controller shaped like `createCallUI(...)` (`show`/`setState`/`setDevices`/`on`/`close`); optional. `opts.uiCloseDelay` (ms, default 1200) — delay before closing the window after `ended`. `ZAudio` instances now expose `setMute`/`listDevices`/`setInputDevice`/`setOutputDevice` (Tasks 1–2).
- Produces: no change to the existing headless signal behavior; when `ui` is present it is driven through the call lifecycle and its `end`/`mute`/`selectInput`/`selectOutput` actions are wired back.

- [ ] **Step 1: Extend the test (failing)**

In `tools/zcall-engine/__tests__/main-engine.test.js`, extend `FakeAudio` (replace its definition) so it records the new methods:

```js
class FakeAudio {
  constructor(){ this.muted=null; this.inDev=null; this.outDev=null; }
  start(cb){ this.started=true; this._cb=cb; }
  play(){}
  stop(){ this.stopped=true; }
  setMute(v){ this.muted=v; }
  listDevices(){ return { capture:[{index:0,name:'mic0',isDefault:true}], playback:[{index:0,name:'spk0',isDefault:true}] }; }
  setInputDevice(i){ this.inDev=i; }
  setOutputDevice(i){ this.outDev=i; }
}
```

Then, before the final `console.log('OK main-engine')`, add a second engine wired with a fake UI:

```js
// --- UI-driven engine ---
const uiCalls = []; const uiHandlers = {};
const fakeUi = {
  show: (p) => uiCalls.push(['show', p]),
  setState: (s, d) => uiCalls.push(['setState', s, d]),
  setDevices: (d) => uiCalls.push(['setDevices', d]),
  on: (e, cb) => { uiHandlers[e] = cb; },
  close: () => uiCalls.push(['close']),
};
const out2 = [];
let lastAudio = null;
class SpyAudio extends FakeAudio { constructor(o){ super(o); lastAudio = this; } }
const eng2 = createMainEngine({
  sendToRender: (m) => out2.push(m),
  MediaSession: FakeSession, ZAudio: SpyAudio, ui: fakeUi, uiCloseDelay: 5,
  os: { networkInterfaces: () => ({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }] }) },
  randomCallId: () => 7777,
});

(async () => {
  eng2.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'Tâm Tho', avatar:'http://a/x.png' }], type:1 } });
  eng2.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  assert.ok(uiCalls.some(c=>c[0]==='show' && c[1].name==='Tâm Tho' && c[1].avatar==='http://a/x.png'), 'ui.show(partner)');
  assert.ok(uiCalls.some(c=>c[0]==='setState' && c[1]==='calling'), 'ui calling');
  assert.ok(uiCalls.some(c=>c[0]==='setDevices' && c[1].capture.length===1), 'ui devices from listDevices');

  eng2.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:7777 } } });
  await new Promise(r=>setTimeout(r,10));
  const conn = uiCalls.find(c=>c[0]==='setState' && c[1]==='connected');
  assert.ok(conn && typeof conn[2].connectedAt === 'number', 'ui connected + connectedAt');

  // window actions route back to engine/audio
  uiHandlers['mute'](true);
  assert.strictEqual(lastAudio.muted, true, 'mute -> audio.setMute');
  uiHandlers['selectInput'](0);
  assert.strictEqual(lastAudio.inDev, 0, 'selectInput -> audio.setInputDevice');
  uiHandlers['selectOutput'](0);
  assert.strictEqual(lastAudio.outDev, 0, 'selectOutput -> audio.setOutputDevice');

  uiHandlers['end']();
  assert.ok(out2.some(m=>m.command===409), 'end -> 409 endcall signal');
  assert.ok(uiCalls.some(c=>c[0]==='setState' && c[1]==='ended'), 'ui ended');
  await new Promise(r=>setTimeout(r,15));
  assert.ok(uiCalls.some(c=>c[0]==='close'), 'ui closed after delay');

  console.log('OK main-engine ui');
})().catch(e=>{ console.error(e); process.exit(1); });
```

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: FAIL — no `ui.show` recorded (`AssertionError: ui.show(partner)`), no 409.

- [ ] **Step 2: Capture partner + a UI-safe helper**

In `tools/zcall-engine/main-engine.js`, inside `createMainEngine`, after the `const randomCallId = ...` line add:

```js
  const ui = opts.ui || null;
  const uiCloseDelay = typeof opts.uiCloseDelay === 'number' ? opts.uiCloseDelay : 1200;
  const uiSafe = (fn) => { if (!ui) return; try { fn(); } catch (e) { zlog('ui err', e && e.message); } };
```

In `startOutgoing`, capture the partner. Change the signature and body:

```js
  function startOutgoing(partner, type) {
    const calleeId = partner && partner.id;
    const callId = randomCallId();
    current = { callId, calleeId: String(calleeId), type: type || 1,
                partner: { id: String(calleeId),
                           name: (partner && (partner.name || partner.dName || partner.displayName)) || String(calleeId),
                           avatar: (partner && (partner.avatar || partner.avatarUrl)) || null } };
    calls.set(String(callId), current);
    zlog('makeCall', calleeId, '-> 401', callId);
    emit('sendSignal', 401, { calleeId: String(calleeId), callId, codec: '[]', type: type || 1 });
  }
```

Update the caller in `handleSendToNative` (the makeCall branch):

```js
      if (p && !current) startOutgoing(p, m.data.type);   // one outgoing at a time (makeCall repeats)
```

- [ ] **Step 3: Drive the window on ring**

In `onConfig`, right after the existing `emit('sendSignal', 416, {...})` and `emit('update', 'callState', { state: 'calling', callId })` lines, add:

```js
    uiSafe(() => {
      ui.show(c.partner);
      ui.setState('calling', { name: c.partner.name });
      let devs = { capture: [], playback: [] };
      try { devs = audio.listDevices(); } catch (e) { zlog('listDevices err', e && e.message); }
      ui.setDevices(Object.assign({ selectedIn: -1, selectedOut: -1 }, devs));
    });
```

- [ ] **Step 4: Drive the window on answer**

In `onAnswer`, after `emit('update', 'callState', { state: 'connected', callId: c.callId })`, add:

```js
    uiSafe(() => ui.setState('connected', { connectedAt: Date.now(), name: c.partner && c.partner.name }));
```

- [ ] **Step 5: Drive the window on teardown**

In `teardown`, after `emit('update', 'callState', { state: 'free', callId: c.callId })`, add:

```js
    uiSafe(() => { ui.setState('ended', { name: c.partner && c.partner.name }); setTimeout(() => uiSafe(() => ui.close()), uiCloseDelay); });
```

- [ ] **Step 6: Wire the window actions back to the engine**

In `createMainEngine`, immediately before `return { handleSendToNative, ... }`, add:

```js
  if (ui) {
    ui.on('end', () => {
      const c = current;
      if (c) emit('sendSignal', 409, { calleeId: c.calleeId, callId: Number(c.callId) });
      teardown(c && c.callId);
    });
    ui.on('mute', (v) => { const c = current; if (c && c.audio) try { c.audio.setMute(!!v); } catch (e) { zlog('setMute err', e && e.message); } });
    ui.on('selectInput', (i) => { const c = current; if (c && c.audio) try { c.audio.setInputDevice(i); } catch (e) { zlog('setInput err', e && e.message); } });
    ui.on('selectOutput', (i) => { const c = current; if (c && c.audio) try { c.audio.setOutputDevice(i); } catch (e) { zlog('setOutput err', e && e.message); } });
  }
```

- [ ] **Step 7: Run tests to verify both engines pass**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: PASS — `OK main-engine` and `OK main-engine ui`.

- [ ] **Step 8: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4a-ui: engine drives the call window (guarded opts.ui) + wires end/mute/device"
```

---

### Task 7: Patch wiring (`patch-zcall-main-engine.js`)

**Files:**
- Modify: `scripts/patches/patch-zcall-main-engine.js`
- Test: `scripts/patches/__tests__/patch-zcall-main-engine.test.js` (extend)

**Interfaces:**
- Consumes: everything above, in the app layout (`app/native/zcall-engine/`, `app/native/zcall-media/`, and new `app/native/zcall-ui/`).
- Produces: patched `main.js` creates the engine with a real `createCallUI(...)` controller; the patch copies `tools/zcall-ui/**` (minus tests) to `app/native/zcall-ui/` and the app icon font to `app/native/zcall-ui/assets/zalo-font.ttf`.

- [ ] **Step 1: Extend the patch test (failing)**

In `scripts/patches/__tests__/patch-zcall-main-engine.test.js`, after the existing assertions (before the final `console.log`), add:

```js
assert.ok(out.includes('createCallUI'), 'engine created with a call UI controller');
assert.ok(out.includes("'zcall-ui'") || out.includes('"zcall-ui"') || out.includes('zcall-ui'), 'references zcall-ui dir');
assert.ok(out.includes('call.html'), 'passes the call.html path');
```

Run: `node scripts/patches/__tests__/patch-zcall-main-engine.test.js`
Expected: FAIL — `AssertionError: engine created with a call UI controller`.

- [ ] **Step 2: Add the UI to the engine-creation replacement**

In `scripts/patches/patch-zcall-main-engine.js`, replace the `REPLACEMENT` constant with:

```js
const REPLACEMENT =
  "((e,t)=>{try{if(t&&t._optional)delete t._optional;var _R=globalThis.__zengRequire;" +
  "if(!globalThis.__zeng){var _P=_R('path');var _b=_P.join(__dirname,'..','native');" +
  "var _mkUi=function(){try{var _el=_R('electron');var _u=_P.join(_b,'zcall-ui');" +
  "return _R(_P.join(_u,'call-ui.js')).createCallUI({BrowserWindow:_el.BrowserWindow,ipcMain:_el.ipcMain," +
  "htmlPath:_P.join(_u,'call.html'),preloadPath:_P.join(_u,'preload.js')});}catch(_ue){try{console.error('[ZENGINE ui]',_ue&&_ue.stack||_ue)}catch(__){}return null;}};" +
  "globalThis.__zeng=_R(_P.join(_b,'zcall-engine','main-engine.js')).createMainEngine({" +
  "sendToRender:function(mm){w.webContents.send(mm.type==='update'?'call-update':'call-send-signal',mm.command,mm.data)}," +
  "ui:_mkUi()});}" +
  "globalThis.__zeng.handleSendToNative(t);}catch(_e){try{console.error('[ZENGINE]',_e&&_e.stack||_e)}catch(__){}}})";
```

(The `MARKER = '__zeng.handleSendToNative'` still appears in the new string, so idempotency is unchanged.)

- [ ] **Step 3: Copy the `zcall-ui` dir + the icon font in `main()`**

In `scripts/patches/patch-zcall-main-engine.js`, add a constant near the top (after `const ENGINE_DIR = ...`):

```js
const UI_SRC = path.join(REPO, 'tools', 'zcall-ui');
const UI_DIR = path.join(REPO, 'app', 'native', 'zcall-ui');
const FONTS_DIR = path.join(REPO, 'app', 'pc-dist', 'fonts');
```

In `main()`, after the block that copies the addons into `mediaDir` (right before `// Patch main.js.`), add:

```js
  // Copy the call-window UI (minus its tests) to app/native/zcall-ui/.
  fs.ensureDirSync(UI_DIR);
  fs.copySync(UI_SRC, UI_DIR, { filter: (src) => !src.split(path.sep).includes('__tests__') });
  // Reuse the app's own icon font for the call glyphs (fail loud if the render bundle moved it).
  const fontMatch = fs.existsSync(FONTS_DIR)
    ? fs.readdirSync(FONTS_DIR).find((f) => /^zalo-font\..*\.ttf$/.test(f))
    : null;
  if (!fontMatch) {
    throw new Error('patch-zcall-main-engine: zalo-font.*.ttf not found in ' + logger.formatPath(FONTS_DIR) + ' — render bundle layout changed');
  }
  fs.ensureDirSync(path.join(UI_DIR, 'assets'));
  fs.copySync(path.join(FONTS_DIR, fontMatch), path.join(UI_DIR, 'assets', 'zalo-font.ttf'));
```

- [ ] **Step 4: Run the patch test**

Run: `node scripts/patches/__tests__/patch-zcall-main-engine.test.js`
Expected: PASS — `OK patch-zcall-main-engine`.

- [ ] **Step 5: Run the whole call test suite**

Run:
```bash
node tools/zcall-ui/__tests__/call-format.test.js && \
node tools/zcall-ui/__tests__/renderer-structure.test.js && \
node tools/zcall-ui/__tests__/call-ui.test.js && \
node tools/zcall-engine/__tests__/main-engine.test.js && \
node scripts/patches/__tests__/patch-zcall-main-engine.test.js
```
Expected: all PASS (`OK ...` lines, including `OK main-engine ui`).

- [ ] **Step 6: Commit**

```bash
git add scripts/patches/patch-zcall-main-engine.js scripts/patches/__tests__/patch-zcall-main-engine.test.js
git commit -m "zcall 4a-ui: patch wires createCallUI + copies zcall-ui and the app icon font"
```

---

### Task 8: End-to-end build + live verification

**Files:** none (integration checkpoint).

- [ ] **Step 1: Rebuild the patched app**

Run: `npm run setup`
Expected: completes; `app/native/zcall-ui/` contains `call.html`, `call.js`, `call-ui.js`, `preload.js`, `icons.css`, `call-format.js`, and `assets/zalo-font.ttf`; `app/main-dist/main.js` contains `createCallUI`.

Verify:
```bash
ls app/native/zcall-ui app/native/zcall-ui/assets && grep -c createCallUI app/main-dist/main.js
```
Expected: files listed, `assets/zalo-font.ttf` present, grep prints `1` (or more).

- [ ] **Step 2: Live call — the window appears and matches**

Launch the app, place a 1-1 audio call to the operator's own phone, and confirm against the Windows screenshots:
- Window opens titled `Zalo Call - {name}`, blurred-avatar bg (or Zalo-blue gradient if no avatar), avatar centered.
- Ringing: loading arc + `Đang nối máy đến {name}`.
- Answer: arc gone, timer badge counts up from `00:00`.
- Bottom bar renders the real Zalo glyphs (camera▾ · red end · mic▾ · gear).

- [ ] **Step 3: Live controls**

- Click **mic** → glyph flips to mic-off, button turns red, phone stops hearing you; click again → restored.
- Open the **mic ▾** menu → pick a different mic/speaker → audio continues on the new device.
- Click **red end** → call tears down (phone call ends), window shows `{name} đã kết thúc cuộc gọi.` then closes.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Notes for the implementer

- Tests are plain `node <file>` scripts using `assert`; there is no test runner. A passing test prints an `OK ...` line and exits 0.
- The native addon must be built before its test: `cd nativelibs/zaudio && npm run build:deps && npm run build`. `build:deps` is idempotent/cached; you only need it once.
- The renderer files are not exercised by a DOM in unit tests — `call-format.js` (pure logic) and `renderer-structure.test.js` (wiring/asset structure) are the guards; the visual/interaction correctness is verified live in Task 8.
- `Date.now()`/`setTimeout` are fine here — this is engine/app code, not a Workflow script.
- Do not commit any `.ttf`, pcap, sessId, key, or relay address. The font is copied at build time from the already-extracted app; `app/` is not committed.
