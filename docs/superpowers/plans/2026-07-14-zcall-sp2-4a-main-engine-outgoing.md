# Main-process call engine — OUTGOING (4a, revised) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The app call button places a real outgoing 1-1 audio call (two-way audio) by running our JS engine in the MAIN process, replacing the absent child-process native engine, driving the app's real IPC signaling loop.

**Spec:** `docs/superpowers/specs/2026-07-14-zcall-sp2-4a-main-engine-outgoing-design.md`

## Global Constraints

- Own account / machine / phone only. Commit only when asked; no AI-attribution.
- Engine runs in the **main** process (Node/dgram/addons available). Reuse `requestcall.js`,
  `call-control.js`, `media-session.js`, `zaudio` unchanged; inject `MediaSession`/`ZAudio` for tests.
- Addons: no new deb Depends.

## RE'd protocol (main.js call module + render)

- Render `$zcall.<m>` → `ipcRenderer.invoke("call-send-to-native"|"call-send-signal"|"call-init", …)`.
- main.js `configure`: `w=n()`; `ipcMain.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:W(),S(t)}))`.
  - `W()` spawns the native binary (`ZaloHelper.app/ZaloCall`, **absent on Linux**) + a `net` server.
  - The child's messages `{type,command,data}` → `case "sendSignal": w.webContents.send("call-send-signal",command,data)`, `"update"→call-update`.
- Render `handleSendSignal(_, command, data)` runs the HTTP API: `401→requestCall`, `416→sendRequestCall`, `408→answerack`, `409→endcall`. The result returns via
  `handleRecvSignal(command, result)` → `_sendToNative({type:"recvSignal", command, data:result})` → `call-send-to-native` → `S`.
- So NATIVE inputs (S): `{type:"request",command:"makeCall",data:{partner:[{id}],type}}`;
  `{type:"recvSignal",command:401,data:<config>}`; `{type:"control",data:{act:"answer"|"end_call",data:{callId,params}}}`.
  NATIVE outputs (emit): `{type:"sendSignal",command:401|416|408|409,data}`; `{type:"update",…}`.

---

### Task 1: `main-engine.js` (event-driven) + mock test

**Files:**
- Create: `tools/zcall-engine/main-engine.js`
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:** `createMainEngine({ sendToRender, MediaSession?, ZAudio?, os?, randomCallId? }) → { handleSendToNative(t), start(), stop() }`.

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-engine/__tests__/main-engine.test.js`:
```js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'main-engine.js');
const { createMainEngine } = require(MOD);

class FakeSession {
  constructor(o){ this.o=o; this._h={}; this.sock={address:()=>({port:55555})}; }
  on(ev,cb){ this._h[ev]=cb; }
  async open(){ return { results:[{host:'10.0.0.1',recv:3,rtt:20,flowToken:Buffer.alloc(4,1)}], host:'10.0.0.1', port:4200, flowToken:Buffer.alloc(4,1) }; }
  send(){} close(){ this.closed=true; }
}
class FakeAudio { start(cb){ this.started=true; this._cb=cb; } play(){} stop(){ this.stopped=true; } }

const CONFIG = { sessId:'A'.repeat(154), servers:[{rtpaddr:'10.0.0.1:4200'}], rtpIP:'10.0.0.1:4200', fromId:111, toId:222, changeZRTP:{enable:0} };
const out = [];
const eng = createMainEngine({
  sendToRender: (m)=>out.push(m),
  MediaSession: FakeSession, ZAudio: FakeAudio,
  os: { networkInterfaces: ()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
  randomCallId: ()=>4242,
});

(async () => {
  eng.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{id:'6664'}], type:1 } });
  await new Promise(r=>setTimeout(r,10));
  assert.strictEqual(out[0].type, 'sendSignal', 'emit sendSignal');
  assert.strictEqual(out[0].command, 401, '401 requestcall');
  assert.strictEqual(out[0].data.calleeId, '6664', '401 calleeId');

  eng.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  const s416 = out.find(m=>m.command===416);
  assert.ok(s416, '416 emitted after config');
  assert.strictEqual(s416.data.rtpAddress, '10.0.0.1:4200', '416 selected relay');
  assert.ok(s416.data.codec.includes('opus/16000/1'), '416 opus codec');
  const ext = JSON.parse(s416.data.extendData);
  assert.ok(ext.serverResult.length>=1 && ext.serverAddr.length===1 && ext.srtpMode===1, '416 extendData');

  eng.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:4242 } } });
  await new Promise(r=>setTimeout(r,10));
  assert.ok(out.some(m=>m.command===408), '408 answerack after answer');

  eng.handleSendToNative({ type:'control', data:{ act:'end_call', data:{ callId:4242 } } });

  cp.execFileSync(process.execPath, ['--check', MOD]);
  console.log('OK main-engine');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js` → FAIL (module missing).

- [ ] **Step 3: Write `main-engine.js`**

Create `tools/zcall-engine/main-engine.js`:
```js
'use strict';
// Main-process $zcall engine (Linux) — replaces the absent child-process native engine. Event-driven
// over the app's IPC signaling loop: receives S(t) (makeCall / recvSignal config / control) and emits
// {type:'sendSignal',command,data} the render executes as HTTP signals. Media via MediaSession+ZAudio.
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');

function zlog() {
  const msg = '[ZENGINE ' + new Date().toISOString() + '] ' + Array.from(arguments).join(' ');
  try { console.error(msg); } catch (_) {}
  try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'zalo-engine.log'), msg + '\n'); } catch (_) {}
}
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }

function createMainEngine(opts) {
  opts = opts || {};
  const sendToRender = opts.sendToRender || (() => {});
  const getMediaSession = () => opts.MediaSession || require('../zcall-media/media-session.js').MediaSession;
  const getZAudio = () => opts.ZAudio || require('../zcall-media/zaudio.js').ZAudio;
  const os = opts.os || require('os');
  const randomCallId = opts.randomCallId || (() => Math.floor(Math.random() * 1e9));
  const calls = new Map();   // callId(str) -> { callId, calleeId, session, audio, config }
  let current = null;        // the outgoing call awaiting its 401 config

  const emit = (type, command, data) => { try { sendToRender({ type, command, data }); } catch (e) { zlog('emit err', e && e.message); } };

  function startOutgoing(calleeId, type) {
    const callId = randomCallId();
    current = { callId, calleeId: String(calleeId), type: type || 1 };
    calls.set(String(callId), current);
    zlog('makeCall', calleeId, '-> 401', callId);
    emit('sendSignal', 401, { calleeId: String(calleeId), callId, codec: '[]', type: type || 1 });
  }

  async function onConfig(config) {
    const c = current;
    if (!c) { zlog('config with no pending call'); return; }
    let cfg;
    try { cfg = parseConfig(typeof config === 'string' ? config : JSON.stringify(config)); }
    catch (e) { zlog('config parse err', e && e.message); return; }
    const callId = c.callId;
    const MediaSession = getMediaSession(); const ZAudio = getZAudio();
    const key = srtpMasterKey(cfg.sessId);
    const session = new MediaSession({ key, ssrc: cfg.fromId });
    const selHost = cfg.rtpIP ? parseAddr(cfg.rtpIP).host : null;
    const servers = cfg.servers.slice(); if (cfg.rtpIP) servers.push({ rtpaddr: cfg.rtpIP });
    const opened = await session.open({ servers, fromId: cfg.fromId, toId: cfg.toId, callId, sessId: cfg.sessId, preferHost: selHost });
    if (!opened) { zlog('no relay replied'); emit('update', 'state', { callId, state: 'error' }); return; }
    const sport = session.sock.address().port;
    const p2p = []; const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });
    c.session = session; c.config = cfg;
    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    c.audio = audio;
    session.on('media', (m) => { try { audio.play(m.payload); } catch (_) {} });
    zlog('open OK relay', opened.host, '-> 416 (ring)');
    emit('sendSignal', 416, { calleeId: c.calleeId, rtcpAddress: opened.host + ':4200', rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(extendData), session: cfg.sessId, callId });
    emit('update', 'state', { callId, state: 'ringing' });
    audio.start((opus) => { try { session.send(opus); } catch (_) {} });   // stream during ringing
  }

  function onAnswer(callId) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    zlog('answer', callId, '-> 408');
    emit('sendSignal', 408, { calleeId: c.calleeId, callId: Number(c.callId) });
    emit('update', 'state', { callId: c.callId, state: 'connected' });
  }

  function teardown(callId) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    try { c.audio && c.audio.stop(); } catch (_) {}
    try { c.session && c.session.close(); } catch (_) {}
    calls.delete(String(c.callId));
    if (current && String(current.callId) === String(c.callId)) current = null;
    emit('update', 'state', { callId: c.callId, state: 'ended' });
  }

  function handleSendToNative(t) {
    let m; try { m = typeof t === 'string' ? JSON.parse(t) : t; } catch (_) { return; }
    if (!m) return;
    zlog('S<-', m.type, m.command, m.data && m.data.act);
    if (m.type === 'request' && m.command === 'makeCall') {
      const p = m.data && m.data.partner && m.data.partner[0];
      if (p && !current) startOutgoing(p.id, m.data.type);   // one outgoing at a time (makeCall repeats)
    } else if (m.type === 'recvSignal' && Number(m.command) === 401) {
      onConfig(m.data).catch((e) => zlog('onConfig err', e && e.message));
    } else if (m.type === 'control' && m.data && m.data.act) {
      const d = m.data.data || {};
      if (m.data.act === 'answer') onAnswer(d.callId);
      else if (m.data.act === 'end_call') teardown(d.callId);
    } else if (m.type === 'request' && m.command === 'endCall') {
      teardown(m.data && m.data.callId);
    }
  }

  return { handleSendToNative, start() {}, stop() { if (current) teardown(current.callId); } };
}

module.exports = { createMainEngine };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js` → `OK main-engine`.

- [ ] **Step 5: Commit** (only if asked)

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall SP2 4a: main-process engine (event-driven) — S(makeCall/recvSignal/control) -> emit sendSignal 401/416/408 + media (mock-tested)"
```

---

### Task 2: patch main.js (`patch-zcall-main-engine.js`) + pure test

**Files:**
- Create: `scripts/patches/patch-zcall-main-engine.js`
- Test: `scripts/patches/__tests__/patch-zcall-main-engine.test.js`

**Interfaces:** `applyMainPatch(src)` (pure) + `main()` (copies engine/modules/addons + patches `app/main-dist/main.js`).

The patch:
1. Prepend `globalThis.__zengRequire=require;` to `main.js` line 1 (capture Node's require before the
   webpack IIFE shadows it — main.js's top-level `require` is Node's, in the Electron main entry).
2. Replace the call-send-to-native handler body so it routes to our engine (using `w` in scope for the
   emit), bypassing the dead child (`W()`/`S(t)` never run → spawn neutered by omission):
   - Anchor (exact): `((e,t)=>{t._optional?delete t._optional:W(),S(t)})`
   - Replacement: `((e,t)=>{try{if(t&&t._optional)delete t._optional;var _R=globalThis.__zengRequire;if(!globalThis.__zeng){var _p=_R('path').join(__dirname,'..','native','zcall-engine','main-engine.js');globalThis.__zeng=_R(_p).createMainEngine({sendToRender:function(mm){w.webContents.send(mm.type==='update'?'call-update':'call-send-signal',mm.command,mm.data)}});}globalThis.__zeng.handleSendToNative(t);}catch(_e){try{console.error('[ZENGINE]',_e&&_e.stack||_e)}catch(__){}}})`
3. Copy `main-engine.js` + reused modules + the Electron-built `.node` into `app/native/zcall-engine/`
   (preserving `../zcall-signaling` / `../zcall-media` relative layout the engine requires).

- [ ] **Step 1: Write the failing test**

Create `scripts/patches/__tests__/patch-zcall-main-engine.test.js`:
```js
const assert = require('assert');
const { applyMainPatch } = require('../patch-zcall-main-engine.js');

const SRC = 'var x=1;(function(){e&&e.on("call-send-to-native",((e,t)=>{t._optional?delete t._optional:W(),S(t)})).on("call-init",((e,t)=>{t&&t._optional&&delete t._optional,D=t}))})();';
const out = applyMainPatch(SRC);
assert.ok(out.startsWith('globalThis.__zengRequire=require;'), 'require captured at top');
assert.ok(out.includes('__zeng.handleSendToNative(t)'), 'handler routes to engine');
assert.ok(out.includes('call-send-signal'), 'emit path present');
assert.ok(!out.includes(':W(),S(t)})).on("call-init"'), 'dead child handler replaced');
assert.ok(out.includes('call-init'), 'call-init handler preserved');
assert.strictEqual(applyMainPatch(out), out, 'idempotent');
assert.throws(() => applyMainPatch('no anchor here'), /anchor/, 'fail-loud');
console.log('OK patch-zcall-main-engine');
```

- [ ] **Step 2: Run test → fails** (`node scripts/patches/__tests__/patch-zcall-main-engine.test.js`).

- [ ] **Step 3: Write `scripts/patches/patch-zcall-main-engine.js`**

```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const REPO = path.join(__dirname, '..', '..');
const MAIN_JS = path.join(REPO, 'app', 'main-dist', 'main.js');
const ENGINE_DIR = path.join(REPO, 'app', 'native', 'zcall-engine');
const MARKER = '__zeng.handleSendToNative';
const REQCAP = 'globalThis.__zengRequire=require;';
const ANCHOR = '((e,t)=>{t._optional?delete t._optional:W(),S(t)})';
const REPLACEMENT =
  "((e,t)=>{try{if(t&&t._optional)delete t._optional;var _R=globalThis.__zengRequire;" +
  "if(!globalThis.__zeng){var _p=_R('path').join(__dirname,'..','native','zcall-engine','main-engine.js');" +
  "globalThis.__zeng=_R(_p).createMainEngine({sendToRender:function(mm){w.webContents.send(mm.type==='update'?'call-update':'call-send-signal',mm.command,mm.data)}});}" +
  "globalThis.__zeng.handleSendToNative(t);}catch(_e){try{console.error('[ZENGINE]',_e&&_e.stack||_e)}catch(__){}}})";

const COPY = [
  ['tools/zcall-engine/main-engine.js', 'main-engine.js'],
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

function applyMainPatch(src) {
  if (src.includes(MARKER)) return src;
  if (!src.includes(ANCHOR)) throw new Error('patch-zcall-main-engine: call-send-to-native handler anchor not found — main.js layout changed.');
  let out = src.replace(ANCHOR, REPLACEMENT);
  if (!out.startsWith(REQCAP)) out = REQCAP + out;
  return out;
}

const { execSync } = require('child_process');
const BUILDER = path.join(REPO, 'nativelibs', 'builder.js');

async function main() {
  if (!fs.existsSync(MAIN_JS)) throw new Error('patch-zcall-main-engine: ' + logger.formatPath(MAIN_JS) + ' not found (run extract first)');
  for (const addon of ['zsrtp', 'zaudio']) {
    const libDir = path.join(REPO, 'nativelibs', addon);
    const bd = path.join(libDir, 'scripts', 'build-deps.sh');
    if (fs.existsSync(bd)) execSync('bash "' + bd + '"', { cwd: REPO, stdio: 'inherit' });
    execSync('node "' + BUILDER + '" "' + libDir + '"', { cwd: REPO, stdio: 'inherit' });
  }
  fs.ensureDirSync(ENGINE_DIR);
  for (const [from, to] of COPY) { const dst = path.join(ENGINE_DIR, to); fs.ensureDirSync(path.dirname(dst)); fs.copySync(path.join(REPO, from), dst); }
  for (const addon of ['zsrtp', 'zaudio']) fs.copySync(path.join(REPO, 'nativelibs', addon, 'build', 'Release', addon + '.node'), path.join(REPO, 'app', 'native', 'nativelibs', 'zcall', addon + '.node'));
  let s = fs.readFileSync(MAIN_JS, 'utf8');
  s = applyMainPatch(s);
  fs.writeFileSync(MAIN_JS, s, 'utf8');
  if (!s.includes(MARKER)) throw new Error('patch-zcall-main-engine: marker not applied');
  logger.success('zcall-main-engine: main.js call handler -> main-process engine; modules/addons copied');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyMainPatch };
```
(The engine requires `../zcall-media/zsrtp.js`/`zaudio.js` loaders, which already try `../zcall/<addon>.node`; keep the addons at `app/native/nativelibs/zcall/`. Adjust the loader candidate to also try `app/native/nativelibs/zcall/` relative to the new engine dir if needed during impl.)

- [ ] **Step 4: Run test → `OK patch-zcall-main-engine`.** Also verify on the real main.js:
  `node -e "const {applyMainPatch}=require('./scripts/patches/patch-zcall-main-engine.js');const fs=require('fs');const o=applyMainPatch(fs.readFileSync('app/main-dist/main.js','utf8'));new Function(o);console.log('valid JS + patched', o.includes('__zeng.handleSendToNative'))"`

- [ ] **Step 5: Commit** (only if asked)

```bash
git add scripts/patches/patch-zcall-main-engine.js scripts/patches/__tests__/patch-zcall-main-engine.test.js
git commit -m "zcall SP2 4a: patch main.js call handler -> main-process engine (require-capture + handler route, neuter child spawn)"
```

---

### Task 3: Pipeline swap + Electron build + deb

- [ ] **Step 1:** In `scripts/main.js`, replace the `patch-zcall-linux-engine` line (the inert binding
  swap) with `patch-zcall-main-engine`. Keep `patch-call-support-linux` + `patch-call-diagnostics`.
- [ ] **Step 2:** `npm run setup` — applies patches (builds `zsrtp`/`zaudio` for Electron, copies,
  patches main.js). Verify `~/zalo-engine.log` gets `createEngine`-style lines only when a call runs.
- [ ] **Step 3:** `npm run build` (or the deb command) — bundles engine + `.node` (no new Depends).
  Verify with `dpkg-deb -c <deb> | grep -E 'zcall-engine|zsrtp.node|zaudio.node'`.
- [ ] **Step 4: Commit** the pipeline swap (only if asked).

---

### Task 4: Live app-button validation (operator)

`unset ELECTRON_RUN_AS_NODE && npm start` → log in → click call → phone rings → answer →
**two-way audio from the app**. Watch `~/zalo-engine.log` for `S<- request makeCall` → `401` →
`S<- recvSignal 401` → `open OK -> 416` → `answer -> 408`. If the config doesn't arrive as
`recvSignal 401`, adjust `handleSendToNative`'s recvSignal branch to the real shape (log shows it).
Record the redacted result in the spec success criteria.
