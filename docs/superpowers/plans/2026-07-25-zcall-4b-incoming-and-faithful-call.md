# zcall 4b — Incoming Calls + Faithful Call UI/Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm cuộc gọi ĐẾN 1-1 audio 2 chiều trên Linux và sửa cuộc gọi ĐI cho khớp app gốc (state/âm thanh/UI/call-log), dùng asset native trích từ ZaloCall.exe.

**Architecture:** Engine ở main-process (`tools/zcall-engine/main-engine.js`) là máy trạng thái caller **và** callee, nối vào IPC `call-send-to-native`. Media/crypto/audio native (`nativelibs/zsrtp`, `nativelibs/zaudio`) + JS signaling/media (`tools/zcall-signaling`, `tools/zcall-media`) **đối xứng** — callee tái dùng nguyên qua helper `setupMedia`. UI là các cửa sổ overlay (`tools/zcall-ui`) do controller `call-ui.js` quản lý: `incoming.html` (màn gọi đến, mới) + `call.html` (in-call, rebuild bằng PNG native) + `devices.html` (có). Âm thanh phát ở renderer (`sounds.js`) theo state.

**Tech Stack:** Electron (main + renderer), Node.js, N-API addons (libopus/miniaudio, libsrtp2), JS thuần signaling. Không thêm dependency mới.

## Global Constraints

- Ngôn ngữ: tiếng Việt; giữ nguyên thuật ngữ/tên lệnh/biến/đường dẫn/code/định danh English.
- Attribution: KHÔNG `Co-Authored-By`, KHÔNG chữ ký "Generated with…"/🤖 ở commit/PR/issue/output.
- Git: chỉ commit/push khi được yêu cầu rõ ràng. Identity: thotam. Nhánh: `zcall/incoming-4b` (từ `main`).
- An toàn/ToS: chỉ account/máy/traffic/điện thoại của chính operator; `sessId`/keys/relay-addr/pcap là secret phù du, chỉ local, KHÔNG commit.
- Asset native (PNG/MP3) trích từ ZaloCall.exe: chỉ tái tạo UI cho bản port cá nhân; không phân phối công khai (ghi rõ trong `tools/zcall-ui/assets/native/README.md`).
- Chỉ audio. Video out of scope (chỉ chừa kiến trúc).
- Test pattern hiện có: mỗi module có `__tests__/*.test.js` chạy bằng `node <file>` (không framework), dùng `assert` + injected fakes (`FakeSession`/`FakeAudio`/fake `ui`). Giữ đúng pattern này.
- Đơn vị test engine: `node tools/zcall-engine/__tests__/main-engine.test.js` phải in `OK ...` cho từng block và exit 0.

---

## Bối cảnh code hiện tại (đọc trước khi bắt đầu)

- Engine `tools/zcall-engine/main-engine.js`: `createMainEngine(opts)` → `{handleSendToNative, start, stop}`. Caller flow: `startOutgoing`→401; `onConfig`(recvSignal 401)→ mở relay + media + audio + UI + 416 + callState 'calling'; `onAnswer`(control answer status 0)→408 + callState 'connected'; `teardown(callId, reason)`→ callState 'free' + bubble call-log (role:1). `recvSignal 409` / `control cancel|end_call` → teardown. `ui.on('end'|'mute'|'selectInput'|'selectOutput')`.
- `onConfig` L48-86 chứa đoạn **role-agnostic** (L55-85: mở relay, MediaSession, ZAudio, p2p/extendData, wire media/audio/UI, `audio.start`) sẽ tách thành `setupMedia`.
- UI controller `tools/zcall-ui/call-ui.js`: `createCallUI({BrowserWindow, ipcMain, htmlPath, preloadPath, devicesHtmlPath})` → `{show, setState, setDevices, on, close}`. Owns `win` + `devWin`. IPC `zcall-ui:action` route: `win`/`devwin`/`openSettings`/handlers. Listener giữ sống suốt đời controller.
- Renderer `call.html`/`call.js`/`preload.js`: preload expose `zcallUI.{onPartner,onState,onDevices,action}`. `call.js` render state/timer/devices; icon hiện dùng font glyph `.zic` (icons.css + zalo-font.ttf).
- `call-format.js`: `formatDuration(sec)`, `statusText(state, name)` (chỉ có `calling`/`ended`).
- Patch `scripts/patches/patch-zcall-main-engine.js`: splice engine vào main.js (`ANCHOR`→`REPLACEMENT`), build addon, COPY modules, copy `tools/zcall-ui`→`app/native/zcall-ui`, copy zalo-font. Wired ở `scripts/main.js:76`. `patch-call-log.js` ở `:77`.
- Signaling: `requestcall.js` (`parseConfig`, `srtpMasterKey(sessId)=Buffer(sessId[0:30])`); `call-control.js` (`buildExtendData({results, selectedHost, p2p})`, `OPUS_CODEC`).
- Asset đã trích sẵn ở `scratch/zcall-native-assets/` (169 file, tên chuẩn). Inventory: `/tmp/.../scratchpad/inventory.md`.

---

# PHASE 0 — Nền tảng (assets + setupMedia + sounds)

### Task 0.1: Vendor asset native vào repo

**Files:**
- Create: `tools/zcall-ui/assets/native/` (copy PNG + MP3 từ `scratch/zcall-native-assets/`)
- Create: `tools/zcall-ui/assets/native/README.md`
- Create: `tools/zcall-ui/__tests__/native-assets.test.js`

**Interfaces:**
- Produces: thư mục `tools/zcall-ui/assets/native/` chứa các file tên cố định (dùng ở Task 1.6, 2.6): `accept_audiocall.png`, `endcall.png`, `mic.png`, `mic_off.png`, `speaker.png`, `speaker_off.png`, `setting.png`, `close.png`, `more.png`, `accept_videocall.png`, `decor-call-wave.png`, `decor-call-wave@2x.png`, `decor-call-wave@3x.png`, `zalo_logo.png`, `zalo_ringtone.mp3`, `zalo_ringback.mp3`, `connecting.mp3`, `endcall.mp3`, `busy.mp3`, `disconnect.mp3`.

- [ ] **Step 1: Copy asset cần dùng**

```bash
cd /mnt/data/Work/zalo-linux
mkdir -p tools/zcall-ui/assets/native
SRC=scratch/zcall-native-assets
for f in accept_audiocall.png endcall.png mic.png mic_off.png icon2__speaker.png setting.png close.png more.png accept_videocall.png 'decor-call-wave.png' 'decor-call-wave@2x.png' 'decor-call-wave@3x.png' zalo_logo.png zalo_ringtone.mp3 zalo_ringback.mp3 connecting.mp3 endcall.mp3 busy.mp3 disconnect.mp3; do
  cp "$SRC/$f" tools/zcall-ui/assets/native/ 2>/dev/null || echo "MISSING: $f"
done
# speaker: đổi tên collision-safe -> speaker.png; speaker_off từ inventory
cp "$SRC/icon2__speaker.png" tools/zcall-ui/assets/native/speaker.png
cp "$SRC/speaker_off.png"    tools/zcall-ui/assets/native/speaker_off.png 2>/dev/null || echo "check speaker_off name in inventory"
ls -1 tools/zcall-ui/assets/native/
```

Expected: liệt kê ~20 file, không dòng `MISSING`. Nếu tên khác (vd `speaker_off`), tra `/tmp/.../scratchpad/inventory.md` (`grep -i speaker inventory.md`) rồi copy đúng basename.

- [ ] **Step 2: Viết README nguồn + license note**

```bash
cat > tools/zcall-ui/assets/native/README.md <<'MD'
# Native call assets (extracted from ZaloCall.exe Qt resource)

Trích từ `ZaloCall.exe` (Zalo Desktop Windows) qua parse Qt RCC tree — tên file giữ nguyên gốc
(`qrc:/icon2/resources/offical-v2/*.png`, `qrc:/sound/*.mp3`). Dùng để tái tạo giao diện cuộc gọi
1-1 cho bản port Linux cá nhân.

KHÔNG phân phối công khai bộ asset này. Nếu release, rà lại license/branding trước.
MD
```

- [ ] **Step 3: Viết failing test (asset tồn tại + PNG/MP3 magic hợp lệ)**

```js
// tools/zcall-ui/__tests__/native-assets.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'assets', 'native');
const NEED = ['accept_audiocall.png','endcall.png','mic.png','mic_off.png','speaker.png','speaker_off.png',
  'setting.png','close.png','more.png','decor-call-wave.png','zalo_logo.png',
  'zalo_ringtone.mp3','zalo_ringback.mp3','connecting.mp3','endcall.mp3','busy.mp3','disconnect.mp3'];
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
for (const f of NEED) {
  const p = path.join(DIR, f);
  assert.ok(fs.existsSync(p), 'missing asset: ' + f);
  const b = fs.readFileSync(p);
  if (f.endsWith('.png')) assert.ok(b.slice(0,8).equals(PNG), 'bad PNG magic: ' + f);
  if (f.endsWith('.mp3')) assert.ok(b.slice(0,3).toString('ascii')==='ID3', 'bad MP3(ID3) magic: ' + f);
}
console.log('OK native-assets');
```

- [ ] **Step 4: Chạy test**

Run: `node tools/zcall-ui/__tests__/native-assets.test.js`
Expected: `OK native-assets`. Nếu FAIL vì tên file → sửa Step 1 copy đúng basename từ inventory.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/assets/native tools/zcall-ui/__tests__/native-assets.test.js
git commit -m "zcall 4b P0: vendor native call assets (icons+sounds) extracted from ZaloCall.exe"
```

---

### Task 0.2: Tách `setupMedia(c, cfg)` khỏi `onConfig` (refactor role-agnostic)

**Files:**
- Modify: `tools/zcall-engine/main-engine.js` (tách L55-85 của `onConfig` thành `async function setupMedia(c, cfg)`)
- Test: `tools/zcall-engine/__tests__/main-engine.test.js` (giữ xanh + thêm assert)

**Interfaces:**
- Produces: `async function setupMedia(c, cfg)` — mở relay + tạo `MediaSession`+`ZAudio`, wire media/audio/UI, `audio.start(...)`. Trả `true` nếu mở relay OK (gán `c.session`, `c.audio`, `c.extendData`, `c.opened`); `false` nếu không relay nào trả lời (đã emit callState 'free'). KHÔNG tự emit 416 và KHÔNG set state 'calling' (để caller/callee tự quyết state + signal). Consume bởi `onConfig` (caller) và `acceptIncoming` (callee, Task 2.2).

- [ ] **Step 1: Thêm assert vào test hiện có để chốt hành vi không đổi**

Thêm vào block "main-engine" (sau dòng 47, trước dòng 49) trong `tools/zcall-engine/__tests__/main-engine.test.js`:

```js
  // setupMedia populated the call: extendData available + audio started
  assert.ok(s416.data.session === CONFIG.sessId, '416 carries sessId as session');
```

- [ ] **Step 2: Chạy để xác nhận vẫn xanh (baseline trước refactor)**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: in `OK main-engine`, `OK main-engine ui`, ... tất cả block, exit 0.

- [ ] **Step 3: Refactor — tách `setupMedia`**

Trong `tools/zcall-engine/main-engine.js`, thay thân `onConfig` (từ sau `const callId = c.callId;` tới hết hàm) sao cho phần media chuyển vào `setupMedia`. Cụ thể, thêm hàm mới và rút gọn `onConfig`:

```js
  // Role-agnostic media bring-up: open a relay, wire MediaSession + ZAudio + UI devices, start mic.
  // Populates c.session / c.audio / c.extendData / c.opened. Returns false (and emits callState free)
  // if no relay replied. Caller and callee (acceptIncoming) both call this; it does NOT emit 416 or
  // set the 'calling'/'connected' state — that stays with the role-specific caller.
  async function setupMedia(c, cfg) {
    const callId = c.callId;
    const MediaSession = getMediaSession(); const ZAudio = getZAudio();
    const key = srtpMasterKey(cfg.sessId);
    const session = new MediaSession({ key, ssrc: c.selfId != null ? c.selfId : cfg.fromId });
    const selHost = cfg.rtpIP ? parseAddr(cfg.rtpIP).host : null;
    const servers = cfg.servers.slice(); if (cfg.rtpIP) servers.push({ rtpaddr: cfg.rtpIP });
    const opened = await session.open({ servers, fromId: (c.selfId != null ? c.selfId : cfg.fromId), toId: (c.peerId != null ? c.peerId : cfg.toId), callId, sessId: cfg.sessId, preferHost: selHost });
    if (!opened) { zlog('no relay replied'); emit('update', 'callState', { state: 'free', callId }); return false; }
    const sport = session.sock.address().port;
    const p2p = []; const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    c.extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });
    c.opened = opened; c.session = session; c.config = cfg;
    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    c.audio = audio;
    let inCount = 0, outCount = 0;
    session.on('media', (m) => { inCount++; try { audio.play(m.payload); } catch (e) { zlog('play err', e && e.message); } });
    session.on('retarget', (h) => zlog('retarget ->', h));
    session.on('authfail', () => { c._authfail = (c._authfail || 0) + 1; });
    c._iv = setInterval(() => zlog('media in', inCount, 'out', outCount, 'authfail', c._authfail || 0, 'relay', session.relay && session.relay.host), 3000);
    c._outTick = () => { outCount++; };
    uiSafe(() => {
      let devs = { capture: [], playback: [] };
      try { devs = audio.listDevices(); } catch (e) { zlog('listDevices err', e && e.message); }
      ui.setDevices(Object.assign({ selectedIn: -1, selectedOut: -1 }, devs));
    });
    audio.start((opus) => { if (c._outTick) c._outTick(); try { session.send(opus); } catch (_) {} });
    return true;
  }

  async function onConfig(config) {
    const c = current;
    if (!c) { zlog('config with no pending call'); return; }
    let cfg;
    try { cfg = parseConfig(typeof config === 'string' ? config : JSON.stringify(config)); }
    catch (e) { zlog('config parse err', e && e.message); return; }
    const ok = await setupMedia(c, cfg);
    if (!ok) return;
    zlog('open OK relay', c.opened.host, '-> 416 (ring)');
    emit('sendSignal', 416, { calleeId: c.calleeId, rtcpAddress: c.opened.host + ':4200', rtpAddress: c.opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(c.extendData), session: cfg.sessId, callId: c.callId });
    emit('update', 'callState', { state: 'calling', callId: c.callId });
    uiSafe(() => {
      ui.show(c.partner);
      ui.setState('calling', { name: c.partner.name });
    });
  }
```

Ghi chú: `setupMedia` dùng `c.selfId`/`c.peerId` nếu có (callee sẽ set), fallback `cfg.fromId`/`cfg.toId` (caller giữ nguyên hành vi cũ). Việc `ui.show` + `setState('calling')` dời xuống sau (giữ đúng thứ tự cũ cho caller).

- [ ] **Step 4: Chạy test — vẫn xanh**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: tất cả block in `OK ...`, exit 0. (Refactor không đổi hành vi caller.)

- [ ] **Step 5: `--check` cú pháp + Commit**

```bash
node --check tools/zcall-engine/main-engine.js
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P0: factor role-agnostic setupMedia() out of onConfig"
```

---

### Task 0.3: `sounds.js` — sound player renderer (state → mp3)

**Files:**
- Create: `tools/zcall-ui/sounds.js`
- Create: `tools/zcall-ui/__tests__/sounds.test.js`

**Interfaces:**
- Produces: `createSounds(opts)` → `{ apply(state, outcome), stopAll() }`. `opts.make(name)` = factory trả một audio-like `{play(), pause(), loop}` (renderer truyền `()=> new Audio('assets/native/'+name)`; test truyền fake). `apply(state, outcome)`:
  - `state==='ringing'` (caller) → loop `zalo_ringback.mp3`
  - `state==='ringing-incoming'` (callee) → loop `zalo_ringtone.mp3`
  - `state==='connecting'` → loop `connecting.mp3`
  - `state==='connected'` → stop tất cả loop
  - `state==='ended'` → stop loop, one-shot theo `outcome`: `'busy'`→`busy.mp3`, `'disconnect'`→`disconnect.mp3`, else `endcall.mp3`
  - state khác → stop tất cả loop.

- [ ] **Step 1: Viết failing test**

```js
// tools/zcall-ui/__tests__/sounds.test.js
const assert = require('assert');
const path = require('path');
const { createSounds } = require('../sounds.js');

function mk() {
  const log = [];
  const make = (name) => ({ name, loop:false, play(){ log.push('play:'+this.name+(this.loop?':loop':'')); }, pause(){ log.push('pause:'+this.name); } });
  return { log, s: createSounds({ make }) };
}

let { log, s } = mk();
s.apply('ringing');
assert.ok(log.some(l=>l.startsWith('play:zalo_ringback.mp3')), 'ringing -> ringback');
s.apply('connecting');
assert.ok(log.some(l=>l==='pause:zalo_ringback.mp3'), 'connecting stops ringback');
assert.ok(log.some(l=>l.startsWith('play:connecting.mp3')), 'connecting -> connecting.mp3');
s.apply('connected');
assert.ok(log.filter(l=>l.startsWith('pause:')).length>=1, 'connected stops loops');

({ log, s } = mk());
s.apply('ringing-incoming');
assert.ok(log.some(l=>l.startsWith('play:zalo_ringtone.mp3')), 'incoming -> ringtone');

({ log, s } = mk());
s.apply('ended', 'busy');
assert.ok(log.some(l=>l.startsWith('play:busy.mp3')), 'ended busy -> busy.mp3');
({ log, s } = mk());
s.apply('ended');
assert.ok(log.some(l=>l.startsWith('play:endcall.mp3')), 'ended default -> endcall.mp3');

require('child_process').execFileSync(process.execPath, ['--check', path.join(__dirname,'..','sounds.js')]);
console.log('OK sounds');
```

- [ ] **Step 2: Chạy — FAIL (chưa có sounds.js)**

Run: `node tools/zcall-ui/__tests__/sounds.test.js`
Expected: FAIL `Cannot find module '../sounds.js'`.

- [ ] **Step 3: Viết `sounds.js`**

```js
// tools/zcall-ui/sounds.js — renderer sound player. State-driven; the engine owns state, this only
// plays. UMD so the node test can require it. In the browser pass make = (n)=> new Audio('assets/native/'+n).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.createSounds = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return function createSounds(opts) {
    opts = opts || {};
    var make = opts.make || function () { return { play: function(){}, pause: function(){}, loop:false }; };
    var cache = {};
    function get(name) { if (!cache[name]) cache[name] = make(name); return cache[name]; }
    var loops = ['zalo_ringback.mp3', 'zalo_ringtone.mp3', 'connecting.mp3'];
    function stopLoops() { loops.forEach(function (n) { if (cache[n]) { try { cache[n].pause(); } catch (e) {} } }); }
    function playLoop(name) { stopLoops(); var a = get(name); a.loop = true; try { a.currentTime = 0; } catch (e) {} try { a.play(); } catch (e) {} }
    function oneShot(name) { var a = get(name); a.loop = false; try { a.currentTime = 0; } catch (e) {} try { a.play(); } catch (e) {} }
    return {
      apply: function (state, outcome) {
        if (state === 'ringing') playLoop('zalo_ringback.mp3');
        else if (state === 'ringing-incoming') playLoop('zalo_ringtone.mp3');
        else if (state === 'connecting') playLoop('connecting.mp3');
        else if (state === 'connected') stopLoops();
        else if (state === 'ended') { stopLoops(); oneShot(outcome === 'busy' ? 'busy.mp3' : outcome === 'disconnect' ? 'disconnect.mp3' : 'endcall.mp3'); }
        else stopLoops();
      },
      stopAll: function () { stopLoops(); },
    };
  };
});
```

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-ui/__tests__/sounds.test.js`
Expected: `OK sounds`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/sounds.js tools/zcall-ui/__tests__/sounds.test.js
git commit -m "zcall 4b P0: sounds.js state-driven renderer sound player"
```

---

# PHASE 1 — Outgoing faithfulness

### Task 1.1: Engine xử lý 407 → state `ringing`

**Files:**
- Modify: `tools/zcall-engine/main-engine.js` (thêm nhánh `recvSignal 407` trong `handleSendToNative`)
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Consumes: `emit`, `uiSafe`, `ui.setState`, `current`.
- Produces: khi nhận `{type:'recvSignal', command:407, data:{callId}}` → `emit('update','callState',{state:'ringing',callId})` + `ui.setState('ringing', {name})`. KHÔNG gửi signal ra (native chỉ đổi state/sound).

- [ ] **Step 1: Viết failing test** (thêm block mới cuối file test)

```js
// --- caller receives 407 ringring -> ringing state (ringback), no outbound signal ---
(async () => {
  const outR = []; const uiR = [];
  const engR = createMainEngine({
    sendToRender:(m)=>outR.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, setState:(s,d)=>uiR.push([s,d]), setDevices:()=>{}, on:()=>{}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>5151,
  });
  engR.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'R' }], type:1 } });
  engR.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,20));
  outR.length = 0; uiR.length = 0;
  engR.handleSendToNative({ type:'recvSignal', command:407, data:{ callId:5151 } });
  assert.ok(outR.some(m=>m.command==='callState' && m.data.state==='ringing'), '407 -> callState ringing');
  assert.ok(uiR.some(c=>c[0]==='ringing'), '407 -> ui ringing');
  assert.ok(!outR.some(m=>m.type==='sendSignal'), '407 sends no outbound signal');
  console.log('OK main-engine ringing');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: block mới ném (không có `callState ringing`).

- [ ] **Step 3: Thêm nhánh 407** — trong `handleSendToNative`, ngay trước nhánh `recvSignal 409`:

```js
    } else if (m.type === 'recvSignal' && Number(m.command) === 407) {
      const c = current;
      if (c) { zlog('recv 407 ringring -> ringing'); emit('update', 'callState', { state: 'ringing', callId: c.callId }); uiSafe(() => ui.setState('ringing', { name: c.partner && c.partner.name })); }
```

- [ ] **Step 4: Chạy — PASS** (tất cả block, gồm `OK main-engine ringing`)

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P1: caller handles 407 ringring -> ringing state (P2 fix)"
```

---

### Task 1.2: Engine thêm state `connecting` giữa answer và connected

**Files:**
- Modify: `tools/zcall-engine/main-engine.js` (`onAnswer`)
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Produces: `onAnswer(callId, data)` emit `callState 'connecting'` + `ui.setState('connecting')` NGAY khi accept, gửi 408, rồi khi media đầu tiên nhận được (session `'media'` event) → `callState 'connected'` + `ui.setState('connected', {connectedAt})` + start timer. Nếu không có media trong `opts.connectDelayMs` (default 1500) thì vẫn chuyển 'connected' (fallback).

- [ ] **Step 1: Sửa test hiện có** — block "main-engine ui" (dòng ~86-89): sau khi answer status 0, phải thấy `connecting` TRƯỚC `connected`. Thay đoạn assert connected:

```js
  eng2.handleSendToNative({ type:'control', data:{ act:'answer', data:{ callId:7777, status:0 } } });
  await new Promise(r=>setTimeout(r,10));
  const connectingIdx = uiCalls.findIndex(c=>c[0]==='setState' && c[1]==='connecting');
  assert.ok(connectingIdx >= 0, 'answer -> ui connecting first');
  // simulate first inbound media -> connected
  if (lastAudio) { /* connected fires via session media or fallback timer */ }
  await new Promise(r=>setTimeout(r,20));
  const conn = uiCalls.find(c=>c[0]==='setState' && c[1]==='connected');
  assert.ok(conn && typeof conn[2].connectedAt === 'number', 'ui connected + connectedAt after connecting');
  const connIdx = uiCalls.findIndex(c=>c[0]==='setState' && c[1]==='connected');
  assert.ok(connIdx > connectingIdx, 'connecting precedes connected');
```

- [ ] **Step 2: Chạy — FAIL** (chưa có 'connecting')

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 3: Sửa `onAnswer` + thêm `markConnected`**

```js
  function markConnected(c) {
    if (!c || c.connectedAt) return;
    c.connectedAt = Date.now();
    if (c._connTimer) { try { clearTimeout(c._connTimer); } catch (_) {} c._connTimer = null; }
    emit('update', 'callState', { state: 'connected', callId: c.callId });
    uiSafe(() => ui.setState('connected', { connectedAt: c.connectedAt, name: c.partner && c.partner.name }));
  }

  function onAnswer(callId, data) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    zlog('answer', callId, 'status=', data && data.status, '-> 408 + connecting');
    c.answered = true;
    emit('sendSignal', 408, { calleeId: c.calleeId, callId: Number(c.callId) });
    emit('update', 'callState', { state: 'connecting', callId: c.callId });
    uiSafe(() => ui.setState('connecting', { name: c.partner && c.partner.name }));
    // connect when first media arrives, or after a short fallback
    if (c.session) { try { c.session.on('media', () => markConnected(c)); } catch (_) {} }
    const delay = typeof opts.connectDelayMs === 'number' ? opts.connectDelayMs : 1500;
    c._connTimer = setTimeout(() => markConnected(c), delay);
  }
```

Lưu ý: `teardown` phải clear `c._connTimer` (thêm `try { if (c._connTimer) clearTimeout(c._connTimer); } catch(_){}` cạnh chỗ clear `c._iv`). `c.connectedAt` giờ set ở `markConnected` (bỏ dòng set cũ trong onAnswer). Test dùng `FakeSession` không phát media → fallback timer sẽ chuyển connected; giảm `connectDelayMs` cho test bằng cách thêm `connectDelayMs: 5` vào `eng2` config nếu cần nhanh.

- [ ] **Step 3b:** Thêm `connectDelayMs: 5` vào các `createMainEngine(...)` trong test block "ui" (eng2) để fallback nhanh.

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: tất cả block xanh; connecting precedes connected.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P1: connecting state between answer and connected (P3 fix)"
```

---

### Task 1.3: Engine no-answer timeout → 405 cancel + missed log

**Files:**
- Modify: `tools/zcall-engine/main-engine.js` (đặt/hủy ring timeout)
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Produces: khi `onConfig` gửi 416 (bắt đầu đổ chuông) → đặt `c._ringTimer = setTimeout(..., opts.ringTimeoutMs || 60000)`. Hết hạn mà chưa answered → `emit('sendSignal',405,{toId,callId,callType})` + `teardown(callId, 2)` (missed, generic). Hủy timer khi answered/teardown.

- [ ] **Step 1: Viết failing test** (block mới)

```js
// --- no-answer: ring timeout fires -> 405 cancel + missed bubble reason 2 ---
(async () => {
  const outN = []; const hN = {};
  const engN = createMainEngine({
    sendToRender:(m)=>outN.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, ringTimeoutMs:30, connectDelayMs:5,
    ui:{ show:()=>{}, setState:()=>{}, setDevices:()=>{}, on:(e,cb)=>{hN[e]=cb;}, close:()=>{} },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>8181,
  });
  engN.handleSendToNative({ type:'request', command:'makeCall', data:{ partner:[{ id:'6664', name:'N' }], type:1 } });
  engN.handleSendToNative({ type:'recvSignal', command:401, data:CONFIG });
  await new Promise(r=>setTimeout(r,60));  // > ringTimeoutMs
  assert.ok(outN.some(m=>m.command===405), 'ring timeout -> 405 cancel');
  const bubN = outN.find(m=>m.command==='bubble');
  assert.ok(bubN && bubN.data.missed===true && bubN.data.reason===2, 'ring timeout -> missed reason 2');
  console.log('OK main-engine no-answer-timeout');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 3: Thêm ring timeout** — trong `onConfig`, sau khi emit 416:

```js
    const rt = typeof opts.ringTimeoutMs === 'number' ? opts.ringTimeoutMs : 60000;
    c._ringTimer = setTimeout(() => {
      if (!c.answered) { zlog('ring timeout -> 405 cancel'); emit('sendSignal', 405, { toId: c.calleeId, callId: Number(c.callId), callType: c.type || 1 }); teardown(c.callId, 2); }
    }, rt);
```

Trong `onAnswer` (đầu hàm) và `teardown` (cạnh clear khác): `try { if (c._ringTimer) { clearTimeout(c._ringTimer); c._ringTimer = null; } } catch (_) {}`.

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: `OK main-engine no-answer-timeout` + các block khác xanh.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P1: caller-side no-answer ring timeout -> 405 + missed log (P4 fix)"
```

---

### Task 1.4: `call-format.js` labels `ringing`/`connecting`

**Files:**
- Modify: `tools/zcall-ui/call-format.js`
- Create: `tools/zcall-ui/__tests__/call-format.test.js` (nếu chưa có; nếu có thì Modify)

**Interfaces:**
- Produces: `statusText(state, name)` bổ sung: `calling`→"Đang gọi " + name (đổi từ "Đang nối máy đến" cho khớp native "Đang gọi"; verify live), `ringing`→"Đang đổ chuông...", `connecting`→"Đang kết nối...", `connected`→'' (timer hiển thị), giữ `ended`.

- [ ] **Step 1: Viết/mở rộng failing test**

```js
// tools/zcall-ui/__tests__/call-format.test.js
const assert = require('assert');
const { statusText, formatDuration } = require('../call-format.js');
assert.strictEqual(formatDuration(75), '01:15', 'duration mm:ss');
assert.ok(statusText('ringing','An').includes('đổ chuông'), 'ringing label');
assert.ok(statusText('connecting','An').includes('kết nối'), 'connecting label');
assert.ok(statusText('calling','An').includes('An'), 'calling shows name');
assert.strictEqual(statusText('connected','An'), '', 'connected empty (timer shown)');
console.log('OK call-format');
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-ui/__tests__/call-format.test.js`

- [ ] **Step 3: Sửa `statusText`**

```js
  function statusText(state, name) {
    name = name || '';
    if (state === 'calling') return 'Đang gọi ' + name;
    if (state === 'ringing') return 'Đang đổ chuông...';
    if (state === 'connecting') return 'Đang kết nối...';
    if (state === 'ended') return name + ' đã kết thúc cuộc gọi.';
    return '';
  }
```

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-ui/__tests__/call-format.test.js`
Expected: `OK call-format`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/call-format.js tools/zcall-ui/__tests__/call-format.test.js
git commit -m "zcall 4b P1: call-format ringing/connecting labels"
```

---

### Task 1.5: Rebuild call window UI bằng PNG native + wire sounds + timer màu

**Files:**
- Modify: `tools/zcall-ui/call.html`, `tools/zcall-ui/call.css`, `tools/zcall-ui/call.js`
- Create: `tools/zcall-ui/icons-native.css` (map class → PNG native, thay dần zalo-font)
- Test: `tools/zcall-ui/__tests__/call-dom.test.js` (jsdom-free: test logic thuần trong call.js đã tách; xem Step 1)

**Interfaces:**
- Consumes: `sounds.js` (`createSounds`), asset ở `assets/native/*`, `call-format.statusText`.
- Produces: `call.js` gọi `sounds.apply(state, outcome)` mỗi khi state đổi; timer đổi class màu (`.timer-secure` khi state connected + `s.secure`, `.timer-warn` khi `s.quality==='poor'`). Icon control dùng `<img src="assets/native/*.png">` thay `.zic` glyph.

- [ ] **Step 1: Tách logic timer-color + sound-trigger thành pure fn testable**

Thêm vào `call-format.js` (pure, đã có test): `timerClass(state, opts)`:

```js
  function timerClass(state, o) {
    o = o || {};
    if (state === 'connected' && o.secure) return 'timer-secure';
    if (o.quality === 'poor') return 'timer-warn';
    return 'timer-normal';
  }
```
Và export nó. Thêm assert vào `call-format.test.js`:
```js
const { timerClass } = require('../call-format.js');
assert.strictEqual(timerClass('connected',{secure:true}), 'timer-secure', 'secure timer');
assert.strictEqual(timerClass('connected',{quality:'poor'}), 'timer-warn', 'poor timer');
assert.strictEqual(timerClass('connected',{}), 'timer-normal', 'normal timer');
```

- [ ] **Step 2: Chạy — FAIL rồi thêm `timerClass` → PASS**

Run: `node tools/zcall-ui/__tests__/call-format.test.js`
Expected: sau khi thêm `timerClass`: `OK call-format`.

- [ ] **Step 3: `icons-native.css` — map class → PNG**

```css
/* tools/zcall-ui/icons-native.css — native PNG icons (extracted from ZaloCall.exe) */
.nic { width: 28px; height: 28px; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
.nic-mic      { background-image: url("assets/native/mic.png"); }
.nic-mic-off  { background-image: url("assets/native/mic_off.png"); }
.nic-speaker  { background-image: url("assets/native/speaker.png"); }
.nic-endcall  { background-image: url("assets/native/endcall.png"); }
.nic-gear     { background-image: url("assets/native/setting.png"); }
.nic-more     { background-image: url("assets/native/more.png"); }
```

- [ ] **Step 4: `call.html` — dùng `<span class="nic ...">` + link css + sounds.js**

Thay `<link rel="stylesheet" href="icons.css" />` thêm `<link rel="stylesheet" href="icons-native.css" />`; đổi các control icon từ `<span class="zic zic-mic">` → `<span class="nic nic-mic">` (mic/speaker/endcall/gear). Thêm trước `</body>`: `<script src="sounds.js"></script>` (trước `call.js`). Thêm control speaker (thay camera pill bằng speaker toggle nếu chưa có — audio call không có camera). Giữ CSP `img-src 'self'`.

- [ ] **Step 5: `call.css` — palette native**

Thêm/sửa: nền `#stage{background:#1A1A1A;}`; `#status,#tb-title{color:#fff;}`; name Roboto: `#status{font-family:Roboto,'Segoe UI',sans-serif;}`; status pill `#status{background:rgba(0,0,0,.39);border-radius:5px;padding:4px 12px;}`; timer màu: `.timer-normal{color:#fff;} .timer-warn{color:#f8d15a;} .timer-secure{color:#81e331;}`; nút end nền đỏ `#btn-end{background:#ef4e49;border-radius:50%;}`.

- [ ] **Step 6: `call.js` — wire sounds + timer class + speaker toggle**

Trong `api.onState`:
```js
  var sounds = window.createSounds ? window.createSounds({ make: function (n) { var a = new Audio('assets/native/' + n); return a; } }) : { apply: function(){}, stopAll: function(){} };
  api.onState(function (s) {
    var state = s && s.state || 'calling';
    document.body.setAttribute('data-state', state);
    applyStatus(state);
    sounds.apply(state, s && s.outcome);
    $('timer').className = window.CallFormat.timerClass(state, { secure: s && s.secure, quality: s && s.quality });
    if (state === 'connected') { connectedAt = (s && s.connectedAt) || Date.now(); startTimer(); }
    else if (state === 'ended' || state === 'free') { stopTimer(); }
  });
```
Mic toggle đổi `.nic` class (`nic-mic`/`nic-mic-off`). Thêm handler `btn-speaker` → `api.action('toggleSpeaker')` (no-op engine cho giờ, hoặc map sang chọn speaker mặc định — để đơn giản chỉ toggle mute-speaker sau; giữ nút hiển thị đúng).

- [ ] **Step 7: Chạy test format + `--check` call.js + verify build không lỗi cú pháp**

Run: `node tools/zcall-ui/__tests__/call-format.test.js && node --check tools/zcall-ui/call.js && node --check tools/zcall-ui/sounds.js`
Expected: `OK call-format`, không lỗi.

- [ ] **Step 8: Commit** (UI pixel-tuning cuối cùng verify live ở Task Final)

```bash
git add tools/zcall-ui/call.html tools/zcall-ui/call.css tools/zcall-ui/call.js tools/zcall-ui/icons-native.css tools/zcall-ui/call-format.js tools/zcall-ui/__tests__/call-format.test.js
git commit -m "zcall 4b P1: rebuild call window with native PNG icons + palette + timer colors + sounds"
```

---

# PHASE 2 — Incoming calls (4b)

### Task 2.1: Engine `startIncoming` (control request → 407 + ringing-incoming + busy auto-decline)

**Files:**
- Modify: `tools/zcall-engine/main-engine.js`
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Consumes: `parseConfig`, `emit`, `uiSafe`, `ui.showIncoming`.
- Produces: nhánh `handleSendToNative` cho `{type:'control', data:{act:'request', act_type:'voip', data:{...}, _caller, inCallStatus}}` → `startIncoming(m.data)`. `startIncoming(ctrl)`: nếu `ctrl.inCallStatus==='zalo'` → `emit('sendSignal',402,{callerId, callId, status:1})` (busy) + return. Ngược lại: dựng `current = { callId, calleeId: caller uid, selfId: our uid, peerId: caller uid, partner:{name,avatar từ _caller}, incoming:true, incomingCfg }`; `emit('sendSignal',407,{callerId, callId})`; `emit('update','callState',{state:'ringing-incoming',callId})`; `uiSafe(()=> ui.showIncoming(partner))`. `ui.setState('ringing-incoming')` để renderer phát ringtone.

Trường trong `ctrl.data` (từ RE; verify live spike #1): `callId`, `sessId`, `servers`, `fromId`(caller uid), `toId`(our uid), `codec`. Caller name/avatar ở `ctrl._caller` (render patch Task 2.7). Dùng `ctrl.data.fromId` làm callerId; `ctrl.data.toId` làm selfId (fallback: nếu thiếu, dùng `ctrl.data.uidN`/`ctrl.data.fromId`).

- [ ] **Step 1: Viết failing test** (2 case: ring + busy)

```js
// --- incoming: control request -> 407 ring + ringing-incoming + showIncoming ---
const INC = { act:'request', act_type:'voip', _caller:{ name:'Caller X', avatar:'http://a/c.png' },
  data:{ callId:6001, sessId:'B'.repeat(154), servers:[{rtpaddr:'10.0.0.2:4200'}], rtpIP:'10.0.0.2:4200', fromId:333, toId:444, codec:'opus/16000/1', ts:String(Date.now()) } };
(async () => {
  const outI = []; const uiI = []; const hI = {};
  const engI = createMainEngine({
    sendToRender:(m)=>outI.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, connectDelayMs:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiI.push(['showIncoming',p]), setState:(s,d)=>uiI.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hI[e]=cb;}, close:()=>uiI.push(['close']), closeIncoming:()=>uiI.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engI.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  assert.ok(outI.some(m=>m.command===407 && m.data.callId===6001), 'incoming -> 407 ringring');
  assert.ok(outI.some(m=>m.command==='callState' && m.data.state==='ringing-incoming'), 'incoming -> ringing-incoming');
  assert.ok(uiI.some(c=>c[0]==='showIncoming' && c[1].name==='Caller X'), 'ui.showIncoming(caller)');
  // busy path
  const busyCtrl = JSON.parse(JSON.stringify(INC)); busyCtrl.inCallStatus='zalo'; busyCtrl.data.callId=6002;
  outI.length=0;
  engI.handleSendToNative({ type:'control', data: busyCtrl });
  assert.ok(outI.some(m=>m.command===402 && m.data.status===1 && m.data.callId===6002), 'busy -> 402 status 1');
  console.log('OK main-engine incoming-ring');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 3: Thêm `startIncoming` + nhánh dispatch**

Trong `handleSendToNative`, sửa nhánh `m.type==='control'`: TRƯỚC khi xử lý `m.data.act==='answer'`, thêm:

```js
      if (m.data.act === 'request') { startIncoming(m.data); return; }
```

Thêm hàm:

```js
  function startIncoming(ctrl) {
    const d = (ctrl && ctrl.data) || {};
    const callId = d.callId;
    const callerId = String(d.fromId != null ? d.fromId : d.uidN);
    if (ctrl.inCallStatus === 'zalo') { zlog('incoming busy -> 402 status 1'); emit('sendSignal', 402, { callerId, callId, status: 1 }); return; }
    if (current) { zlog('incoming while busy(local) -> 402 status 1'); emit('sendSignal', 402, { callerId, callId, status: 1 }); return; }
    const caller = ctrl._caller || {};
    current = { callId, calleeId: callerId, selfId: (d.toId != null ? String(d.toId) : null), peerId: callerId,
      type: 1, incoming: true, incomingCfg: d,
      partner: { id: callerId, name: caller.name || callerId, avatar: caller.avatar || null } };
    calls.set(String(callId), current);
    zlog('incoming', callerId, 'callId', callId, '-> 407 ring');
    emit('sendSignal', 407, { callerId, callId });
    emit('update', 'callState', { state: 'ringing-incoming', callId });
    uiSafe(() => { ui.showIncoming(current.partner); ui.setState('ringing-incoming', { name: current.partner.name }); });
  }
```

Ghi chú: `selfId`/`peerId` để `setupMedia` dùng đúng ssrc (spike #4 — nếu `toId` vắng ở payload thật, chỉnh sau khi live-capture).

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: `OK main-engine incoming-ring` + các block cũ xanh.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P2: engine startIncoming (control request -> 407 ring + busy auto-decline)"
```

---

### Task 2.2: Engine `acceptIncoming` (setupMedia callee + 402 status=0 + connected)

**Files:**
- Modify: `tools/zcall-engine/main-engine.js`
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Consumes: `setupMedia`, `parseConfig`, `ui.showIncoming`/`ui.closeIncoming`/`ui.show`, `ui.on('accept')`.
- Produces: `ui.on('accept')` → `acceptIncoming()`: `parseConfig(incomingCfg)` → `setupMedia(current, cfg)` (dùng `selfId` làm ssrc) → `emit('sendSignal',402,{callerId, callId, status:0, codec:OPUS_CODEC, extendData:JSON.stringify(current.extendData), rtcpAddress:host+':4200', rtpAddress:host+':4200', session:cfg.sessId})` → `current.answered=true` → `ui.closeIncoming()` + `ui.show(partner)` + `markConnected(current)` (connected + timer).

- [ ] **Step 1: Viết failing test** (nối tiếp block incoming — dùng `hI['accept']`)

```js
// --- incoming accept -> 402 status 0 + media + connected ---
(async () => {
  const outA = []; const uiA = []; const hA = {};
  const engA = createMainEngine({
    sendToRender:(m)=>outA.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5, connectDelayMs:5,
    ui:{ show:(p)=>uiA.push(['show',p]), showIncoming:(p)=>uiA.push(['showIncoming',p]), setState:(s,d)=>uiA.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hA[e]=cb;}, close:()=>uiA.push(['close']), closeIncoming:()=>uiA.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engA.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  hA['accept']();
  await new Promise(r=>setTimeout(r,20));
  const ans = outA.find(m=>m.command===402);
  assert.ok(ans && ans.data.status===0 && ans.data.session===INC.data.sessId, 'accept -> 402 status 0 + session');
  assert.ok(ans.data.codec.includes('opus/16000/1'), '402 opus codec');
  assert.ok(uiA.some(c=>c[0]==='closeIncoming'), 'accept closes incoming window');
  assert.ok(uiA.some(c=>c[0]==='show'), 'accept opens call window');
  assert.ok(uiA.some(c=>c[0]==='setState' && c[1]==='connected'), 'accept -> connected');
  console.log('OK main-engine incoming-accept');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 3: Thêm `acceptIncoming` + đăng ký `ui.on('accept')`**

Trong khối `if (ui) { ui.on('end', ...) ... }`, thêm:

```js
    ui.on('accept', () => { acceptIncoming().catch((e) => zlog('accept err', e && e.message)); });
    ui.on('decline', () => { declineIncoming(); });
```

Thêm hàm:

```js
  async function acceptIncoming() {
    const c = current;
    if (!c || !c.incoming) return;
    let cfg;
    try { cfg = parseConfig(typeof c.incomingCfg === 'string' ? c.incomingCfg : JSON.stringify(c.incomingCfg)); }
    catch (e) { zlog('incoming cfg parse err', e && e.message); return; }
    const ok = await setupMedia(c, cfg);
    if (!ok) return;
    const host = c.opened.host;
    zlog('accept incoming -> 402 status 0');
    emit('sendSignal', 402, { callerId: c.calleeId, callId: Number(c.callId), status: 0, codec: OPUS_CODEC, extendData: JSON.stringify(c.extendData), rtcpAddress: host + ':4200', rtpAddress: host + ':4200', session: cfg.sessId });
    c.answered = true;
    uiSafe(() => { ui.closeIncoming(); ui.show(c.partner); ui.setState('connecting', { name: c.partner.name }); });
    if (c.session) { try { c.session.on('media', () => markConnected(c)); } catch (_) {} }
    c._connTimer = setTimeout(() => markConnected(c), typeof opts.connectDelayMs === 'number' ? opts.connectDelayMs : 1500);
  }
```

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: `OK main-engine incoming-accept`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P2: engine acceptIncoming (callee setupMedia + 402 status 0 + connected)"
```

---

### Task 2.3: Engine `declineIncoming` + remote-cancel đóng incoming + teardown role

**Files:**
- Modify: `tools/zcall-engine/main-engine.js` (`declineIncoming`, `teardown` role param, đóng incoming window)
- Test: `tools/zcall-engine/__tests__/main-engine.test.js`

**Interfaces:**
- Produces: `declineIncoming()` → `emit('sendSignal',402,{callerId, callId, status:3})` + `teardown(callId, 3)`. `teardown` thêm dùng `c.incoming` để chọn `role` (0 nếu incoming, 1 nếu outgoing) trong bubble + gọi `ui.closeIncoming()` nếu đang có incoming window. Remote cancel khi đang `ringing-incoming` (control cancel/end_call/409) → teardown đóng incoming.

- [ ] **Step 1: Viết failing test** (decline + remote-cancel)

```js
// --- incoming decline -> 402 status 3 + teardown role 0 ---
(async () => {
  const outD2 = []; const uiD2 = []; const hD2 = {};
  const engD2 = createMainEngine({
    sendToRender:(m)=>outD2.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiD2.push(['showIncoming',p]), setState:(s,d)=>uiD2.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hD2[e]=cb;}, close:()=>uiD2.push(['close']), closeIncoming:()=>uiD2.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engD2.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  hD2['decline']();
  assert.ok(outD2.some(m=>m.command===402 && m.data.status===3), 'decline -> 402 status 3');
  const bubI = outD2.find(m=>m.command==='bubble');
  assert.ok(bubI && bubI.data.role===0 && bubI.data.missed===true, 'incoming decline -> bubble role 0, missed');
  assert.ok(uiD2.some(c=>c[0]==='closeIncoming'), 'decline closes incoming window');
  console.log('OK main-engine incoming-decline');
})().catch(e=>{ console.error(e); process.exit(1); });

// --- incoming remote cancel (caller hangs up while ringing) -> close incoming + callState free ---
(async () => {
  const outRC = []; const uiRC = []; const hRC = {};
  const engRC = createMainEngine({
    sendToRender:(m)=>outRC.push(m), MediaSession:FakeSession, ZAudio:FakeAudio, uiCloseDelay:5,
    ui:{ show:()=>{}, showIncoming:(p)=>uiRC.push(['showIncoming',p]), setState:(s,d)=>uiRC.push(['setState',s,d]), setDevices:()=>{}, on:(e,cb)=>{hRC[e]=cb;}, close:()=>uiRC.push(['close']), closeIncoming:()=>uiRC.push(['closeIncoming']) },
    os:{ networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'192.168.1.9'}]}) },
    randomCallId:()=>1,
  });
  engRC.handleSendToNative({ type:'control', data: JSON.parse(JSON.stringify(INC)) });
  await new Promise(r=>setTimeout(r,10));
  engRC.handleSendToNative({ type:'control', data:{ act:'cancel', data:{ callId:6001 } } });
  assert.ok(uiRC.some(c=>c[0]==='closeIncoming'), 'remote cancel closes incoming window');
  assert.ok(outRC.some(m=>m.command==='callState' && m.data.state==='free'), 'remote cancel -> callState free');
  console.log('OK main-engine incoming-remote-cancel');
})().catch(e=>{ console.error(e); process.exit(1); });
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`

- [ ] **Step 3: Thêm `declineIncoming` + sửa `teardown`**

```js
  function declineIncoming() {
    const c = current;
    if (!c || !c.incoming) return;
    zlog('decline incoming -> 402 status 3');
    emit('sendSignal', 402, { callerId: c.calleeId, callId: Number(c.callId), status: 3 });
    teardown(c.callId, 3);
  }
```

Trong `teardown`, sửa 2 chỗ: (a) role trong bubble; (b) đóng incoming window. Thay dòng `emit('update', 'bubble', {...})` bằng:

```js
    const role = c.incoming ? 0 : 1;
    emit('update', 'bubble', { role: role, duration: durationSec, partnerId: c.calleeId, reason: outReason, missed: !answered, calltype: 0 });
```

Và trong phần cleanup UI cuối `teardown`, đóng cả incoming:

```js
    uiSafe(() => { try { ui.closeIncoming && ui.closeIncoming(); } catch (_) {} ui.setState('ended', { name: c.partner && c.partner.name }); setTimeout(() => uiSafe(() => ui.close()), uiCloseDelay); });
```

Lưu ý: `role:0` cho incoming — bubble với `role` falsy (0) cần render hiểu là "cuộc gọi đến". `patch-call-log.js` hiện dùng `caller:n.role` + action `t.caller?"recommened.calling":"recommened.receivecall"` → role 0 tự ra `receivecall`. Đảm bảo `bub.data.role===0` truthy-check trong test cũ ("bubble role truthy (outgoing)") vẫn đúng cho outgoing (role 1).

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-engine/__tests__/main-engine.test.js`
Expected: `OK main-engine incoming-decline`, `OK main-engine incoming-remote-cancel`, các block cũ xanh.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-engine/main-engine.js tools/zcall-engine/__tests__/main-engine.test.js
git commit -m "zcall 4b P2: declineIncoming (402 status 3) + teardown role + close incoming on remote cancel"
```

---

### Task 2.4: Controller `call-ui.js` — incoming window + accept/decline routing

**Files:**
- Modify: `tools/zcall-ui/call-ui.js` (thêm `incomingWin`, `showIncoming`, `closeIncoming`, route action `accept`/`decline`)
- Create: `tools/zcall-ui/__tests__/call-ui.test.js`

**Interfaces:**
- Consumes: `BrowserWindow`, `ipcMain`, `incomingHtmlPath` (opt mới).
- Produces: controller thêm `showIncoming(partner)` (mở `incomingWin` load `incoming.html`, gửi `zcall-ui:partner`), `closeIncoming()` (destroy incomingWin). `onAction` route `msg.action==='accept'`→`handlers['accept']()`, `'decline'`→`handlers['decline']()`, `'incwin'`→điều khiển incomingWin. `setState` forward tới cả incomingWin (cho ringtone). `showIncoming` set `pendingPartner`.

- [ ] **Step 1: Viết failing test với fake BrowserWindow/ipcMain**

```js
// tools/zcall-ui/__tests__/call-ui.test.js
const assert = require('assert');
const { createCallUI } = require('../call-ui.js');

function fakeBW() {
  const wins = [];
  function BW() {
    const w = { _h:{}, sent:[], destroyed:false, wc:{ _h:{}, send(ch,p){ w.sent.push([ch,p]); }, once(ev,cb){ this._h[ev]=cb; }, } };
    w.webContents = w.wc;
    w.on = (ev,cb)=>{ w._h[ev]=cb; };
    w.loadFile = (f)=>{ w.file=f; if (w.wc._h['did-finish-load']) w.wc._h['did-finish-load'](); };
    w.isDestroyed = ()=>w.destroyed;
    w.destroy = ()=>{ w.destroyed=true; };
    w.focus = ()=>{}; w.close = ()=>{ if(w._h['closed']) w._h['closed'](); };
    wins.push(w); return w;
  }
  return { BW, wins };
}
function fakeIpc(){ const h={}; return { on:(ch,cb)=>{h[ch]=cb;}, emit:(ch,e,msg)=>{ if(h[ch]) h[ch](e,msg); }, _h:h }; }

const { BW, wins } = fakeBW();
const ipc = fakeIpc();
const ui = createCallUI({ BrowserWindow: BW, ipcMain: ipc, htmlPath:'call.html', preloadPath:'preload.js', devicesHtmlPath:'devices.html', incomingHtmlPath:'incoming.html' });
let accepted=false, declined=false;
ui.on('accept', ()=>{ accepted=true; });
ui.on('decline', ()=>{ declined=true; });

ui.showIncoming({ name:'Caller X', avatar:null });
const incWin = wins.find(w=>w.file==='incoming.html');
assert.ok(incWin, 'incoming window created');
assert.ok(incWin.sent.some(s=>s[0]==='zcall-ui:partner' && s[1].name==='Caller X'), 'partner sent to incoming');
ui.setState('ringing-incoming', { name:'Caller X' });
assert.ok(incWin.sent.some(s=>s[0]==='zcall-ui:state' && s[1].state==='ringing-incoming'), 'state forwarded to incoming');

ipc.emit('zcall-ui:action', {}, { action:'accept' });
assert.ok(accepted, 'accept routed');
ipc.emit('zcall-ui:action', {}, { action:'decline' });
assert.ok(declined, 'decline routed');

ui.closeIncoming();
assert.ok(incWin.destroyed, 'incoming window destroyed');
console.log('OK call-ui');
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node tools/zcall-ui/__tests__/call-ui.test.js`

- [ ] **Step 3: Sửa `call-ui.js`**

Thêm `var incomingHtmlPath = opts.incomingHtmlPath;` + `var incWin = null;`. Trong `onAction`, thêm route:
```js
    if (msg.action === 'incwin') { handleWin(incWin, msg.value); return; }
```
(`accept`/`decline` tự rơi vào nhánh `handlers[msg.action]` cuối — đã có.)

Thêm `sendTo(w, channel, payload)` helper + trong return object thêm:
```js
    showIncoming: function (partner) {
      pendingPartner = partner || {};
      if (incWin && !incWin.isDestroyed()) { try { incWin.webContents.send('zcall-ui:partner', pendingPartner); incWin.focus(); } catch (e) {} return; }
      if (!incomingHtmlPath || !BrowserWindow) return;
      incWin = new BrowserWindow({ width: 360, height: 560, resizable: false, frame: false, alwaysOnTop: true,
        title: 'Cuộc gọi đến', backgroundColor: '#1A1A1A',
        webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true } });
      incWin.on('closed', function () { incWin = null; });
      incWin.webContents.once('did-finish-load', function () {
        try { incWin.webContents.send('zcall-ui:partner', pendingPartner); } catch (e) {}
      });
      incWin.loadFile(incomingHtmlPath);
    },
    closeIncoming: function () { if (incWin && !incWin.isDestroyed()) { try { incWin.destroy(); } catch (e) {} incWin = null; } },
```
Sửa `setState` để forward tới incWin:
```js
    setState: function (state, data) {
      var payload = { state: state };
      if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
      send('zcall-ui:state', payload);
      if (incWin && !incWin.isDestroyed()) { try { incWin.webContents.send('zcall-ui:state', payload); } catch (e) {} }
    },
```
Trong `close()`, destroy incWin luôn.

- [ ] **Step 4: Chạy — PASS**

Run: `node tools/zcall-ui/__tests__/call-ui.test.js`
Expected: `OK call-ui`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/call-ui.js tools/zcall-ui/__tests__/call-ui.test.js
git commit -m "zcall 4b P2: call-ui incoming window + accept/decline routing"
```

---

### Task 2.5: Renderer `incoming.html/css/js` — màn cuộc gọi đến (native assets + ringtone)

**Files:**
- Create: `tools/zcall-ui/incoming.html`, `tools/zcall-ui/incoming.css`, `tools/zcall-ui/incoming.js`
- Test: `node --check` (UI verify live ở Task Final)

**Interfaces:**
- Consumes: `zcallUI.{onPartner,onState,action}` (preload có sẵn), `sounds.js`, asset native.
- Produces: màn incoming: avatar + tên caller + "Cuộc gọi thoại đến" + wave anim (`decor-call-wave`), nút **Trả lời** (`accept_audiocall.png`) → `action('accept')`, **Từ chối** (`endcall.png`) → `action('decline')`. Phát `zalo_ringtone` khi `state==='ringing-incoming'`, stop khi khác.

- [ ] **Step 1: `incoming.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; media-src 'self'" />
  <link rel="stylesheet" href="incoming.css" />
  <title>Cuộc gọi đến</title>
</head>
<body>
  <div id="wrap">
    <div id="wave"></div>
    <div id="avatar"></div>
    <div id="name">—</div>
    <div id="sub">Cuộc gọi thoại đến</div>
    <div id="actions">
      <button id="btn-decline" class="rbtn"><img src="assets/native/endcall.png" /></button>
      <button id="btn-accept" class="rbtn"><img src="assets/native/accept_audiocall.png" /></button>
    </div>
  </div>
  <script src="sounds.js"></script>
  <script src="incoming.js"></script>
</body>
</html>
```

- [ ] **Step 2: `incoming.css`** (nền tối + wave animation)

```css
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#1A1A1A; color:#fff; font-family:Roboto,'Segoe UI',sans-serif; height:100vh; -webkit-user-select:none; }
#wrap { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; -webkit-app-region:drag; }
#avatar { width:120px; height:120px; border-radius:50%; background:#0068ff center/cover no-repeat; z-index:1; }
#wave { position:absolute; top:calc(50% - 130px); width:200px; height:200px; border-radius:50%;
  background:url("assets/native/decor-call-wave@2x.png") center/contain no-repeat; animation:pulse 1.6s ease-out infinite; }
@keyframes pulse { 0%{transform:scale(.85);opacity:.7} 100%{transform:scale(1.25);opacity:0} }
#name { font-size:20px; font-weight:600; }
#sub { font-size:14px; color:#c7c7c7; }
#actions { display:flex; gap:64px; margin-top:24px; -webkit-app-region:no-drag; }
.rbtn { width:64px; height:64px; border:none; border-radius:50%; cursor:pointer; background:transparent; }
.rbtn img { width:64px; height:64px; }
</style>
```
(Bỏ dòng `</style>` thừa nếu copy — đây là file .css, không có tag.)

- [ ] **Step 3: `incoming.js`**

```js
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.zcallUI || { onPartner:function(){}, onState:function(){}, action:function(){} };
  var sounds = window.createSounds ? window.createSounds({ make:function(n){ return new Audio('assets/native/'+n); } }) : { apply:function(){}, stopAll:function(){} };
  api.onPartner(function (p) {
    p = p || {};
    $('name').textContent = p.name || '—';
    if (p.avatar) $('avatar').style.backgroundImage = 'url("' + p.avatar + '")';
  });
  api.onState(function (s) { sounds.apply(s && s.state, s && s.outcome); });
  $('btn-accept').addEventListener('click', function () { sounds.stopAll(); api.action('accept'); });
  $('btn-decline').addEventListener('click', function () { sounds.stopAll(); api.action('decline'); });
})();
```

- [ ] **Step 4: `--check` + verify HTML link đúng asset**

Run: `node --check tools/zcall-ui/incoming.js && test -f tools/zcall-ui/assets/native/accept_audiocall.png && echo OK-incoming-files`
Expected: `OK-incoming-files`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-ui/incoming.html tools/zcall-ui/incoming.css tools/zcall-ui/incoming.js
git commit -m "zcall 4b P2: incoming call window (native assets + wave + ringtone)"
```

---

### Task 2.6: Render patch — enrich caller name/avatar (`patch-call-incoming-enrich.js`)

**Files:**
- Create: `scripts/patches/patch-call-incoming-enrich.js`
- Create: `scripts/patches/__tests__/patch-call-incoming-enrich.test.js`
- Modify: `scripts/main.js` (wire sau `patch-call-log`)

**Interfaces:**
- Produces: patch tìm block `isIncomingCallEvent(e)` trong bundle active, chèn resolve `_caller={name,avatar}` từ contact store trước `_sendToNative`. Idempotent (MARKER) + fail-loud (anchor bắt buộc ở ≥1 bundle). Anchor cụ thể (từ RE): trong `handleControl`, đoạn `const t={type:"control",data:e}` (minified: `{type:"control",data:e}`) — chèn ngay trước nó: `try{if((e.act==="request")&&e.data){var _u=e.data.fromId||e.data.uidN;var _p=<selector>(_u);if(_p)e._caller={name:<dname(_p)>,avatar:<avatar(_p)>};}}catch(_){}`.

Spike #7: selector chính xác + cách lấy dname/avatar phải xác nhận trong bundle (`getProfileFriendByIdSync`/`getProfileByIdFromCache` + `DNameAndAvatar`). Task này viết patch dạng **anchor + injection template** với selector để trống được resolve bằng 1 bước RE nhỏ (Step 3).

- [ ] **Step 1: Viết failing test (patch thuần trên chuỗi giả)**

```js
// scripts/patches/__tests__/patch-call-incoming-enrich.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'patch-call-incoming-enrich.js');
const { applyPatch, MARKER } = require(MOD);

const SAMPLE = 'x();const t={type:"control",data:e};this._sendToNative(t);y();';
const out = applyPatch(SAMPLE);
assert.ok(out.includes(MARKER), 'marker injected');
assert.ok(out.indexOf(MARKER) < out.indexOf('const t={type:"control"'), 'enrich runs before building t');
// idempotent
assert.strictEqual(applyPatch(out), out, 'idempotent');
// fail-loud
let threw=false; try { applyPatch('no anchor here'); } catch(e){ threw=true; }
assert.ok(threw, 'fail-loud when anchor missing');
cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK patch-call-incoming-enrich');
```

- [ ] **Step 2: Chạy — FAIL**

Run: `node scripts/patches/__tests__/patch-call-incoming-enrich.test.js`

- [ ] **Step 3: RE selector (spike #7) + viết patch**

Trước khi viết injection, xác nhận selector bằng lệnh (chạy 1 lần, ghi kết quả vào comment patch):
```bash
B=$(find app/pc-dist/lazy -name 'default-login-main-startup-shared-worker-znotification*.js' | head -1)
grep -oE 'getProfileFriendByIdSync\([^)]*\)|getProfileByIdFromCache\([^)]*\)|[A-Za-z]+DNameAndAvatar\(' "$B" | head
```
Dùng selector rẻ nhất có sync + trả `{dName, avatar}`. Viết patch:

```js
// scripts/patches/patch-call-incoming-enrich.js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const REPO = path.join(__dirname, '..', '..');
const GLOB_DIRS = [path.join(REPO, 'app', 'pc-dist', 'lazy'), path.join(REPO, 'app', 'pc-dist')];
const MARKER = '__zcallEnrich';
const ANCHOR = 'const t={type:"control",data:e}';
// Resolve caller {name,avatar} from the contact store before forwarding the incoming event.
// Selector confirmed via RE (Step 3): getProfileByIdFromCache(uid) -> profile with dName/avatar.
const INJECT =
  'try{if(e&&e.act==="request"&&e.data){var __zcallEnrich=1;var _u=e.data.fromId||e.data.uidN;' +
  'var _p=_u&&this.getProfileByIdFromCache&&this.getProfileByIdFromCache(_u);' +
  'if(_p)e._caller={name:_p.dName||_p.displayName||String(_u),avatar:_p.avatar||_p.avt||null};}}catch(_e){}';

function applyPatch(src) {
  if (src.includes(MARKER)) return src;
  if (!src.includes(ANCHOR)) throw new Error('patch-call-incoming-enrich: anchor not found');
  return src.replace(ANCHOR, INJECT + ANCHOR);
}

async function main() {
  let patched = 0;
  for (const dir of GLOB_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.js$/.test(f)) continue;
      const p = path.join(dir, f);
      let s; try { s = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (!s.includes(ANCHOR) || s.includes(MARKER)) continue;
      fs.writeFileSync(p, applyPatch(s), 'utf8');
      patched++;
    }
  }
  if (patched === 0) throw new Error('patch-call-incoming-enrich: no bundle carried the incoming-control anchor');
  logger.success('call-incoming-enrich: enriched caller name/avatar in ' + patched + ' bundle(s)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyPatch, MARKER };
```
Ghi chú: `this.getProfileByIdFromCache` — trong `handleControl` scope `this` là CallController; nếu selector không phải method của `this` (mà là import module), Step 3 RE sẽ cho biết cách gọi đúng; chỉnh `INJECT` cho khớp. Nếu resolve fail → `_caller` không set → engine fallback uid (an toàn).

- [ ] **Step 4: Chạy — PASS**

Run: `node scripts/patches/__tests__/patch-call-incoming-enrich.test.js`
Expected: `OK patch-call-incoming-enrich`.

- [ ] **Step 5: Wire vào `scripts/main.js`** (sau dòng 77 `patch-call-log`)

```js
      await require('./patches/patch-call-incoming-enrich.js').main();
```

- [ ] **Step 6: Commit**

```bash
git add scripts/patches/patch-call-incoming-enrich.js scripts/patches/__tests__/patch-call-incoming-enrich.test.js scripts/main.js
git commit -m "zcall 4b P2: render patch enriches incoming caller name/avatar"
```

---

### Task 2.7: Patch `patch-zcall-main-engine.js` — copy assets/native + incoming files + wire incomingHtmlPath

**Files:**
- Modify: `scripts/patches/patch-zcall-main-engine.js`
- Test: `scripts/patches/__tests__/` (nếu có test cho patch này; nếu không, verify bằng `applyMainPatch` + kiểm tra copy logic)

**Interfaces:**
- Produces: `_mkUi()` trong REPLACEMENT truyền thêm `incomingHtmlPath:_P.join(_u,'incoming.html')`. Bước copy `tools/zcall-ui` → `app/native/zcall-ui` đã copy toàn thư mục (gồm `assets/native`, `incoming.*`, `sounds.js`) nhờ `fs.copySync(UI_SRC, UI_DIR, ...)` — chỉ cần đảm bảo không lọc nhầm.

- [ ] **Step 1: Sửa REPLACEMENT thêm incomingHtmlPath**

Trong chuỗi `_mkUi`, sau `devicesHtmlPath:_P.join(_u,'devices.html')` thêm `,incomingHtmlPath:_P.join(_u,'incoming.html')`.

- [ ] **Step 2: Đảm bảo copy assets/native** — `fs.copySync(UI_SRC, UI_DIR, {filter: (src)=>!src.split(path.sep).includes('__tests__')})` đã bao gồm `assets/native`. Thêm assertion sau copy:

```js
  if (!fs.existsSync(path.join(UI_DIR, 'assets', 'native', 'accept_audiocall.png'))) {
    throw new Error('patch-zcall-main-engine: native assets missing after copy');
  }
  if (!fs.existsSync(path.join(UI_DIR, 'incoming.html'))) {
    throw new Error('patch-zcall-main-engine: incoming.html missing after copy');
  }
```

- [ ] **Step 3: Test `applyMainPatch` vẫn idempotent + marker**

```bash
node -e "const {applyMainPatch}=require('./scripts/patches/patch-zcall-main-engine.js'); const s='globalThis.__x;((e,t)=>{t._optional?delete t._optional:W(),S(t)})'; const o=applyMainPatch(s); if(!o.includes('__zeng.handleSendToNative')) throw new Error('no marker'); if(applyMainPatch(o)!==o) throw new Error('not idempotent'); console.log('OK applyMainPatch');"
```
Expected: `OK applyMainPatch`.

- [ ] **Step 4: Commit**

```bash
git add scripts/patches/patch-zcall-main-engine.js
git commit -m "zcall 4b P2: wire incomingHtmlPath + verify native assets/incoming copied to app"
```

---

# PHASE 3 — Video-ready seam (không code pipeline)

### Task 3.1: `call-ui.js` — `show(partner, opts)` nhận callType (chừa chỗ video)

**Files:**
- Modify: `tools/zcall-ui/call-ui.js` (thêm tham số callType, giữ audio mặc định)
- Test: `tools/zcall-ui/__tests__/call-ui.test.js` (assert audio path không đổi)

**Interfaces:**
- Produces: `show(partner, opts)` chấp nhận `opts.callType` (0=audio default). Hiện chỉ mở `call.html` (audio). Ghi comment TODO seam cho videoHtmlPath tương lai. KHÔNG thêm window video.

- [ ] **Step 1: Thêm assert vào call-ui.test.js**

```js
ui.show({ name:'A' }, { callType:0 });
const callWin = wins.find(w=>w.file==='call.html');
assert.ok(callWin, 'audio callType still opens call.html');
console.log('OK call-ui callType');
```

- [ ] **Step 2: Sửa `show`** — signature `show: function (partner, opts)` + comment:

```js
      // callType seam: opts.callType 0=audio (only path today). A future video window would branch
      // here on opts.callType===1 to load a videoHtmlPath (separate window, mirrors native
      // ZCallMainWindowVideo_v2). Not implemented — audio only.
```
(Thân hàm giữ nguyên, chỉ nhận thêm `opts` không dùng.)

- [ ] **Step 3: Chạy — PASS**

Run: `node tools/zcall-ui/__tests__/call-ui.test.js`
Expected: `OK call-ui` + `OK call-ui callType`.

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-ui/call-ui.js tools/zcall-ui/__tests__/call-ui.test.js
git commit -m "zcall 4b P3: call-ui callType seam for future video window (no impl)"
```

---

# FINAL — Build, live validation, spike resolution

### Task F.1: Full offline test sweep + build

- [ ] **Step 1: Chạy toàn bộ unit test zcall**

```bash
cd /mnt/data/Work/zalo-linux
for t in tools/zcall-engine/__tests__/*.test.js tools/zcall-ui/__tests__/*.test.js tools/zcall-signaling/__tests__/*.test.js tools/zcall-media/__tests__/*.test.js scripts/patches/__tests__/patch-call-incoming-enrich.test.js; do
  echo "== $t =="; node "$t" || { echo FAIL; exit 1; }
done
echo "ALL OFFLINE TESTS PASS"
```
Expected: mỗi test in `OK ...`, cuối cùng `ALL OFFLINE TESTS PASS`.

- [ ] **Step 2: Build/patch app (áp mọi patch, gồm patch mới)**

```bash
# Theo pipeline hiện có (extract xong sẵn). Áp patch:
node -e "require('./scripts/patches/patch-zcall-main-engine.js').main()" && \
node -e "require('./scripts/patches/patch-call-log.js').main()" && \
node -e "require('./scripts/patches/patch-call-incoming-enrich.js').main()"
```
Expected: log `success` cho từng patch, không throw. Nếu `patch-call-incoming-enrich` throw "no bundle carried the incoming-control anchor" → anchor sai, RE lại (spike #7).

### Task F.2: Live validation (điện thoại của chính operator)

- [ ] **Outgoing (faithfulness):** gọi đi → nghe **ringback** khi đổ chuông + label "Đang đổ chuông"; nhấc máy → "Đang kết nối" + connecting.mp3 → connected + timer; audio 2 chiều; kết thúc → endcall.mp3 + call-log đúng. Thử **không nghe máy** → sau timeout tự cúp + log "Cuộc gọi thoại đi 0 giây". Thử **bận** → busy path.
- [ ] **Incoming (4b):** điện thoại gọi Linux → **cửa sổ incoming hiện** với tên+avatar đúng + **ringtone** loop + wave anim. **Trả lời** → audio 2 chiều + call window connected. **Từ chối** → máy gọi thấy từ chối + call-log role:0. Gọi khi đang bận → tự báo bận.
- [ ] **Spike resolution (ghi lại từ `~/zalo-call-diag.log` / `~/zalo-engine.log`):**
  1. Field names thật trong `control request` `data.data` — chỉnh `startIncoming` nếu khác (`fromId`/`toId`/`callId`/`sessId`/`servers`).
  2. Busy: đến qua signal riêng hay answer status — chỉnh P5 nếu cần.
  3. Giá trị `ringTimeoutMs` khớp native (đo).
  4. `selfId` cho ssrc: `toId` có mặt không; nếu không, inject `userId` (thêm vào render patch enrich `e._selfId`).
  5. Text state Vietnamese chính xác (chỉnh `call-format.js`).
  6. Loop-mode sound đúng chưa.

- [ ] **Step cuối: chạy lại offline sweep** (đảm bảo mọi chỉnh spike vẫn xanh) rồi báo hoàn thành. Commit các chỉnh spike (nếu có) với message `zcall 4b: live-verified fixes (fields/busy/timeout/labels)`.

### Task F.3: Hoàn tất nhánh

- [ ] Dùng **superpowers:finishing-a-development-branch**: verify test → present options (merge/PR/keep/discard). (Diagnostics patches `patch-call-diagnostics`/`patch-call-trace` + engine zlog **giữ** để debug; task gỡ trước release là việc riêng, ngoài 4b.)

---

## Self-Review notes (đã rà)

- **Spec coverage:** Phase 0 (assets §3 / setupMedia §2 / sounds §4) ✓; Phase 1 P1-P5 §5 (407 T1.1, connecting T1.2, timeout T1.3, labels T1.4, sounds+UI T1.5; P6 giữ nguyên — không có task, đúng chủ ý) ✓; Phase 2 incoming §6 (startIncoming T2.1, accept T2.2, decline/teardown T2.3, controller T2.4, window T2.5, enrich patch T2.6, copy T2.7) ✓; Phase 3 seam §7 (T3.1) ✓; testing §10 (F.1/F.2) ✓; spikes §9 (F.2) ✓.
- **Type consistency:** `setupMedia(c,cfg)` (T0.2) dùng `c.selfId/c.peerId` — set ở `startIncoming` (T2.1), consume ở `acceptIncoming` (T2.2). `markConnected(c)` định nghĩa T1.2, dùng lại T2.2. `ui.showIncoming/closeIncoming` (T2.4) khớp engine gọi (T2.1/2.2/2.3). `ui.on('accept'/'decline')` (T2.2) khớp controller route (T2.4) khớp renderer `action('accept'/'decline')` (T2.5). Bubble `role` 0/1 (T2.3) khớp `patch-call-log` `caller:n.role`. `createSounds({make})` (T0.3) dùng T1.5 + T2.5.
- **Placeholder scan:** không có TBD/TODO trừ seam video (chủ ý, §7). Spike đánh dấu rõ, có bước resolve (F.2).
- **P5 (busy mapping):** giữ nguyên `ANSWER_STATUS_REASON` hiện có + test busy-status cũ vẫn pass; chỉ resolve khi live capture (F.2 spike 2) — không đổi hành vi mù quáng.
