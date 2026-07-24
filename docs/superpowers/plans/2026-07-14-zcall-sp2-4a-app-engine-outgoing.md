# App call engine — OUTGOING (4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Zalo app's call button on Linux places a real outgoing 1-1 audio call (two-way audio), via a `$zcall` engine replacing the stub, with `zsrtp`/`zaudio` built for Electron + shipped in the deb.

**Architecture:** `tools/zcall-engine/engine.js` implements `MainApp()` the renderer's JS controller uses; it drives the proven outgoing flow (401→config→InitZRTP→416+extendData→answer→408→MediaSession+ZAudio) via the `onCallSignal` callback. A patch swaps `binding.js`'s Linux stub for the engine and copies the modules + addons into the app. Addons build against Electron for the deb.

**Spec:** `docs/superpowers/specs/2026-07-14-zcall-sp2-4a-app-engine-outgoing-design.md`

## Global Constraints

- **Boundary:** own account / machine / phone only. Commit only when asked; no AI-attribution.
- Engine runs in **preload/renderer** (Node access). Reuse `requestcall.js`, `call-control.js`
  (buildExtendData/OPUS_CODEC), `media-session.js`, `zaudio.js` unchanged — inject `MediaSession`/
  `ZAudio` so the engine unit test needs no device/addon.
- Addons: no new deb Depends (static + dlopen).

---

### Task 1: `tools/zcall-engine/engine.js` (outgoing state machine) + mock test

**Files:**
- Create: `tools/zcall-engine/engine.js`
- Test: `tools/zcall-engine/__tests__/engine-outgoing.test.js`

**Interfaces:**
- `createEngine(deps?) → engineObject` with the `$zcall` interface (`initCall`, `sendDataToNative`,
  `onCallSignal`/`onCallCallback`/`onCallUpdate`/…, getters). `deps` may inject `{ MediaSession,
  ZAudio, os, randomCallId }` for testing.
- `MainApp() → createEngine()` (the app entry).

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-engine/__tests__/engine-outgoing.test.js`:
```js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'engine.js');
const { createEngine } = require(MOD);

// Fakes so the engine runs with no device/network/addon.
class FakeSession {
  constructor(opts) { this.opts = opts; this._h = {}; this.sock = { address: () => ({ port: 55555 }) }; this.sent = 0; this.closed = false; }
  on(ev, cb) { this._h[ev] = cb; }
  async open() { return { results: [{ host: '10.0.0.1', recv: 3, rtt: 20, flowToken: Buffer.alloc(4, 1) }], host: '10.0.0.1', port: 4200, flowToken: Buffer.alloc(4, 1) }; }
  send() { this.sent++; }
  close() { this.closed = true; }
}
class FakeAudio { constructor() { this.started = false; this.stopped = false; } start(cb) { this.started = true; this._cb = cb; } play() {} stop() { this.stopped = true; } }

const CONFIG = { sessId: 'A'.repeat(154), servers: [{ rtpaddr: '10.0.0.1:4200' }], rtpIP: '10.0.0.1:4200', fromId: 111, toId: 222, changeZRTP: { enable: 0 } };
const signals = [];
const engine = createEngine({
  MediaSession: FakeSession,
  ZAudio: FakeAudio,
  os: { networkInterfaces: () => ({ eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }] }) },
  randomCallId: () => 4242,
});
engine.onCallSignal((type, data) => { signals.push({ type, data }); return type === 401 ? Promise.resolve(CONFIG) : Promise.resolve({ ok: true }); });

(async () => {
  // makeCall intent → engine drives 401 then 416
  engine.sendDataToNative({ type: 'request', command: 'makeCall', data: { partner: [{ id: '6664' }], type: 1 } });
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(signals[0].type, 401, 'first signal is 401 requestcall');
  assert.strictEqual(signals[0].data.calleeId, '6664', '401 calleeId = original id');
  assert.strictEqual(signals[1].type, 416, 'second signal is 416 request');
  assert.strictEqual(signals[1].data.rtpAddress, '10.0.0.1:4200', '416 rtpAddress = selected relay');
  assert.ok(signals[1].data.codec.includes('opus/16000/1'), '416 codec = opus');
  const ext = JSON.parse(signals[1].data.extendData);
  assert.ok(ext.serverResult.length >= 1 && ext.serverAddr.length === 1 && ext.srtpMode === 1, '416 extendData well-formed');
  assert.strictEqual(signals[1].data.session, CONFIG.sessId, '416 session = sessId');

  // answer control → engine sends 408 answerack
  engine.sendDataToNative({ type: 'control', data: { act_type: 'voip', act: 'answer', data: { callId: 4242, params: '{"rtpSerIp":"10.0.0.1:4200"}' } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(signals.some((s) => s.type === 408), 'answer → 408 answerack sent');

  // end_call → teardown (no throw)
  engine.sendDataToNative({ type: 'control', data: { act_type: 'voip', act: 'end_call', data: { callId: 4242 } } });

  cp.execFileSync(process.execPath, ['--check', MOD]);
  console.log('OK engine-outgoing');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-engine/__tests__/engine-outgoing.test.js`
Expected: FAIL "Cannot find module '../engine.js'".

- [ ] **Step 3: Write `engine.js`**

Create `tools/zcall-engine/engine.js`:
```js
'use strict';
// The $zcall engine (Linux) — implements MainApp() that the app's renderer JS call-controller uses.
// Drives the proven OUTGOING flow via onCallSignal; media via MediaSession + ZAudio. Runs in the
// preload/renderer (Node access). Own account / own phone only.
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');

function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }

function createEngine(deps = {}) {
  const getMediaSession = () => deps.MediaSession || require('../zcall-media/media-session.js').MediaSession;
  const getZAudio = () => deps.ZAudio || require('../zcall-media/zaudio.js').ZAudio;
  const os = deps.os || require('os');
  const randomCallId = deps.randomCallId || (() => Math.floor(Math.random() * 1e9));

  let signalCb = null, callbackCb = null, updateCb = null;
  const calls = new Map();   // callId(str) -> { session, audio, calleeId }

  async function startOutgoing(calleeId, type) {
    const MediaSession = getMediaSession();
    const ZAudio = getZAudio();
    const callId = randomCallId();
    let config;
    try {
      const raw = await signalCb(401, { calleeId: String(calleeId), callId, codec: '[]', type: type || 1 });
      config = parseConfig(typeof raw === 'string' ? raw : JSON.stringify(raw));
    } catch (e) { if (updateCb) updateCb({ callId, state: 'error', error: String(e && e.message || e) }); return; }

    const key = srtpMasterKey(config.sessId);
    const session = new MediaSession({ key, ssrc: config.fromId });
    const selHost = config.rtpIP ? parseAddr(config.rtpIP).host : null;
    const servers = config.servers.slice();
    if (config.rtpIP) servers.push({ rtpaddr: config.rtpIP });
    const opened = await session.open({ servers, fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, preferHost: selHost });
    if (!opened) { if (updateCb) updateCb({ callId, state: 'error', error: 'no-relay' }); return; }

    const sport = session.sock.address().port;
    const p2p = [];
    const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });

    await signalCb(416, { calleeId: String(calleeId), rtcpAddress: opened.host + ':4200', rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(extendData), session: config.sessId, callId });

    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    session.on('media', (m) => { try { audio.play(m.payload); } catch (_) {} });
    audio.start((opus) => { try { session.send(opus); } catch (_) {} });

    calls.set(String(callId), { session, audio, calleeId: String(calleeId), toId: config.toId });
    if (updateCb) updateCb({ callId, state: 'ringing' });
  }

  async function onAnswer(callId, _params) {
    const c = calls.get(String(callId));
    if (!c) return;
    try { await signalCb(408, { calleeId: c.calleeId, callId: Number(callId) }); } catch (_) {}
    if (updateCb) updateCb({ callId, state: 'connected' });
  }

  function teardown(callId) {
    const c = calls.get(String(callId));
    if (!c) return;
    try { c.audio.stop(); } catch (_) {}
    try { c.session.close(); } catch (_) {}
    calls.delete(String(callId));
    if (updateCb) updateCb({ callId, state: 'ended' });
  }

  return {
    test: (x) => x,
    initCall: (_config) => {},
    onCallSignal: (cb) => { signalCb = cb; },
    onCallCallback: (cb) => { callbackCb = cb; },
    onCallUpdate: (cb) => { updateCb = cb; },
    onCallRequest: (_cb) => {},          // 4b (incoming)
    onCallResponseDevices: (_cb) => {},
    removeListenCallDevices: () => {},
    getEventMessage: () => null,
    getListDevices: () => '[]',
    getCallInfo: () => '{}', getExtendData: () => '{}', getActiveAudioCodecs: () => '{}', getJsonStats406: () => '{}',
    getVideoFrame: () => null, getVideoFrameLocal: () => null,
    sendDataToNative: (msg) => {
      let m; try { m = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch (_) { return; }
      if (!m) return;
      if (m.type === 'request' && m.command === 'makeCall') {
        const p = m.data && m.data.partner && m.data.partner[0];
        if (p) startOutgoing(p.id, m.data.type).catch(() => {});
      } else if (m.type === 'control' && m.data && m.data.act) {
        const d = m.data.data || {};
        if (m.data.act === 'answer') onAnswer(d.callId, d.params).catch(() => {});
        else if (m.data.act === 'end_call') teardown(d.callId);
      }
    },
  };
}

module.exports = { MainApp: () => createEngine(), createEngine };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-engine/__tests__/engine-outgoing.test.js`
Expected: `OK engine-outgoing`.

- [ ] **Step 5: Commit** (only if asked)

```bash
git add tools/zcall-engine/engine.js tools/zcall-engine/__tests__/engine-outgoing.test.js
git commit -m "zcall SP2 4a: \$zcall engine (outgoing state machine) — 401->config->InitZRTP->416+extendData->408 + media/audio (mock-tested)"
```

---

### Task 2: `binding.js` replacement patch (`patch-zcall-linux-engine.js`)

**Files:**
- Create: `scripts/patches/patch-zcall-linux-engine.js`
- Test: `scripts/patches/__tests__/patch-zcall-linux-engine.test.js`

**Interfaces:** `main()` — rewrites the app's `binding.js` Linux branch to `return require('./engine.js')`, and copies `engine.js` + reused modules (`tools/zcall-signaling/{requestcall,call-control,cdp-invoke,zpw}.js`, `tools/zcall-media/{media-session,initzrtp,rtp,media-frame,srtp-*,zsrtp,zaudio}.js`) + the two built `.node` addons into `app/native/nativelibs/zcall/`, preserving the relative `../zcall-signaling` / `../zcall-media` layout the engine requires. Idempotent, fail-loud.

- [ ] **Step 1: Write the failing test**

Create `scripts/patches/__tests__/patch-zcall-linux-engine.test.js`:
```js
const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { applyBindingPatch } = require('../patch-zcall-linux-engine.js');

// applyBindingPatch(src) is the pure string transform on binding.js — test it in isolation.
const STUB = "function getLib(){ if(process.platform==='win32'){return require('./zcall_x64.node');} else { return {MainApp:function(){return {}}}; } }\nmodule.exports = getLib();";
const out = applyBindingPatch(STUB);
assert.ok(out.includes("require('./engine.js')") || out.includes('require("./engine.js")'), 'Linux branch requires engine.js');
assert.ok(out.includes("zcall_x64.node"), 'win branch preserved');
assert.ok(applyBindingPatch(out) === out, 'idempotent');
assert.throws(() => applyBindingPatch('no getLib here'), /anchor/, 'fail-loud on missing anchor');
console.log('OK patch-zcall-linux-engine');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/patch-zcall-linux-engine.test.js`
Expected: FAIL "Cannot find module '../patch-zcall-linux-engine.js'".

- [ ] **Step 3: Write the patch**

Create `scripts/patches/patch-zcall-linux-engine.js`:
```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ZCALL_DIR = path.join(__dirname, '..', '..', 'app', 'native', 'nativelibs', 'zcall');
const BINDING = path.join(ZCALL_DIR, 'binding.js');
const MARKER = '/*linux-zcall-engine*/';

// Modules the engine requires (copied preserving ../zcall-signaling and ../zcall-media layout).
const COPY = [
  ['tools/zcall-engine/engine.js', 'engine.js'],
  ['tools/zcall-signaling/requestcall.js', '../zcall-signaling/requestcall.js'],
  ['tools/zcall-signaling/call-control.js', '../zcall-signaling/call-control.js'],
  ['tools/zcall-signaling/cdp-invoke.js', '../zcall-signaling/cdp-invoke.js'],
  ['tools/zcall-signaling/zpw.js', '../zcall-signaling/zpw.js'],
  ['tools/zcall-media/media-session.js', '../zcall-media/media-session.js'],
  ['tools/zcall-media/initzrtp.js', '../zcall-media/initzrtp.js'],
  ['tools/zcall-media/rtp.js', '../zcall-media/rtp.js'],
  ['tools/zcall-media/media-frame.js', '../zcall-media/media-frame.js'],
  ['tools/zcall-media/srtp-kdf.js', '../zcall-media/srtp-kdf.js'],
  ['tools/zcall-media/srtp-decrypt.js', '../zcall-media/srtp-decrypt.js'],
  ['tools/zcall-media/zsrtp.js', '../zcall-media/zsrtp.js'],
  ['tools/zcall-media/zaudio.js', '../zcall-media/zaudio.js'],
];

// Pure: rewrite the binding.js Linux branch to require the engine. Fail-loud if the anchor is gone.
function applyBindingPatch(src) {
  if (src.includes(MARKER)) return src;
  if (!src.includes('function getLib()') || !src.includes('MainApp')) {
    throw new Error('patch-zcall-linux-engine: binding.js anchor (getLib/MainApp) not found — layout changed.');
  }
  // Replace the whole non-win/non-darwin else-branch body with the engine require.
  return src.replace(/(\}else\{)([\s\S]*?)(\}\s*\})\s*\nmodule\.exports/, function (_m, a, _body, c) {
    return a + MARKER + "return require('./engine.js');" + c + '\nmodule.exports';
  });
}

const REPO = path.join(__dirname, '..', '..');

async function main() {
  if (!fs.existsSync(BINDING)) throw new Error('patch-zcall-linux-engine: ' + logger.formatPath(BINDING) + ' not found (run extract first)');
  // 1) copy modules + addons
  for (const [from, to] of COPY) {
    const dst = path.join(ZCALL_DIR, to);
    fs.ensureDirSync(path.dirname(dst));
    fs.copySync(path.join(REPO, from), dst);
  }
  for (const addon of ['zsrtp', 'zaudio']) {
    const built = path.join(REPO, 'nativelibs', addon, 'build', 'Release', addon + '.node');
    if (!fs.existsSync(built)) throw new Error('patch-zcall-linux-engine: missing built addon ' + addon + '.node (build it against Electron first)');
    fs.copySync(built, path.join(ZCALL_DIR, addon + '.node'));
  }
  // 2) rewrite binding.js
  let s = fs.readFileSync(BINDING, 'utf8');
  s = applyBindingPatch(s);
  fs.writeFileSync(BINDING, s, 'utf8');
  if (!s.includes(MARKER)) throw new Error('patch-zcall-linux-engine: marker not applied');
  logger.success('zcall-linux-engine: binding.js -> engine.js + modules/addons copied');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyBindingPatch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/patch-zcall-linux-engine.test.js`
Expected: `OK patch-zcall-linux-engine`.

- [ ] **Step 5: Commit** (only if asked)

```bash
git add scripts/patches/patch-zcall-linux-engine.js scripts/patches/__tests__/patch-zcall-linux-engine.test.js
git commit -m "zcall SP2 4a: patch-zcall-linux-engine — binding.js -> engine + copy modules/addons (idempotent, tested)"
```

---

### Task 3: Build addons against Electron + wire into the deb pipeline

**Files:**
- Modify: the build/patch pipeline entrypoint that applies patches (add `patch-zcall-linux-engine`
  after `patch-call-support-linux`, replacing the `patch-zcall-linux-stub` step).
- Verify: `nativelibs/builder.js` builds `zsrtp` + `zaudio` for Electron.

- [ ] **Step 1: Build both addons against Electron**

Run (for each addon):
```
node nativelibs/builder.js nativelibs/zsrtp
node nativelibs/builder.js nativelibs/zaudio
```
Expected: each produces `build/Release/<addon>.node` linked against the Electron ABI
(`--target=<ELECTRON_VERSION> --dist-url=https://electronjs.org/headers`, per `builder.js`). Fix any
Electron-ABI build error (e.g. re-run `build:deps` first so `.deps` exist).

- [ ] **Step 2: Swap the stub patch for the engine patch in the pipeline**

Find where `patch-zcall-linux-stub.js` is invoked (the patch runner / build script) and replace it
with `patch-zcall-linux-engine.js`. Keep `patch-call-support-linux.js` (button) + the call-diag
patch (for `ZALO_REMOTE_DEBUG`, still useful). Show the exact edited lines.

- [ ] **Step 3: Build the deb**

Run the repo's deb build (the same command used for prior releases). Expected: the deb includes
`app/native/nativelibs/zcall/{engine.js, zsrtp.node, zaudio.node, ../zcall-signaling/*, ../zcall-media/*}`
and no new `Depends`. Verify with `dpkg-deb -c <deb> | grep -E 'engine.js|zsrtp.node|zaudio.node'`.

- [ ] **Step 4: Commit** (only if asked)

```bash
git add <pipeline file>
git commit -m "zcall SP2 4a: build zsrtp/zaudio for Electron + swap stub->engine patch in the deb pipeline"
```

---

### Task 4: Live app-button validation (operator)

Not a CI step. Install the deb (or apply the patches to a local `/opt/Zalo` copy + rebuild the
addons for Electron), launch the app, log in:
1. Click the **call button** on your own phone's contact.
2. The phone rings → answer → **two-way audio** from the app.
3. Hang up → the call ends cleanly.

If the call button does nothing or media doesn't flow, capture `~/zalo-call-diag.log` (the engine's
`sendDataToNative` inputs + any errors) and diff against the standalone `live-audio.js` flow — the
likely gaps are the exact `onCallSignal` return contract or the in-call UI `onCallUpdate` payloads
(spec open items). Record the redacted result in the spec success criteria.

---

## Manual live validation (operator, after Task 3)

Build deb → install → click call → confirm **two-way audio from the app button**. Note any
`sendDataToNative`/`onCallSignal` shape that differs from the mocks so the engine can be adjusted.
