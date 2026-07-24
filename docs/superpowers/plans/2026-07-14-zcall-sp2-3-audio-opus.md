# Full-duplex audio (opus, native) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hear the peer + speak on a real connected 1-1 call: decode inbound opus → speaker, capture mic → opus → the existing SRTP/RTP send path.

**Architecture:** One N-API addon `nativelibs/zaudio` (static libopus + vendored miniaudio). Opus encode/decode + mic/speaker via miniaudio (dlopen backends). Network/SRTP/RTP stay in the existing JS. Glue in `tools/zcall-media/live-audio.js`.

**Tech Stack:** node-addon-api (C++17), static libopus, miniaudio (single header), Node `dgram` (existing).

**Spec:** `docs/superpowers/specs/2026-07-14-zcall-sp2-3-audio-opus-design.md`

## Global Constraints

- **Boundary:** own account / machine / phone only. Commit only when asked; no AI-attribution.
- **Codec:** opus, 16 kHz mono, 20 ms frames (320 samples), RTP pt=112, VOIP mode.
- **Runtime:** `nativelibs/zaudio` = static libopus + vendored `miniaudio.h`; link `-l:libopus.a -ldl -lm -lpthread` + `-Wl,--exclude-libs,ALL`; miniaudio `dlopen`s ALSA/Pulse/PipeWire → **no new deb Depends**. Build vs local Node (Electron build = step 4). Follow the `nativelibs/zsrtp` pattern.

---

### Task 1: `nativelibs/zaudio` addon — opus encode/decode + round-trip test

**Files:**
- Create: `nativelibs/zaudio/package.json`, `nativelibs/zaudio/.gitignore`, `nativelibs/zaudio/binding.gyp`
- Create: `nativelibs/zaudio/scripts/build-deps.sh`
- Create: `nativelibs/zaudio/src/zaudio.cpp`
- Create: `nativelibs/zaudio/README.md`
- Test: `nativelibs/zaudio/__tests__/opus-roundtrip.test.js`

**Interfaces (this task, opus only):**
- `new ZAudio({ sampleRate=16000, channels=1, frameMs=20, bitrate=24000 })`
- `.encodeFrame(pcm: Buffer) → Buffer` — int16 PCM (320 samples) → opus bytes
- `.decodeFrame(opus: Buffer) → Buffer` — opus bytes → int16 PCM (320 samples)

- [ ] **Step 1: Scaffold files**

`nativelibs/zaudio/package.json`:
```json
{
  "name": "zaudio",
  "version": "1.0.0",
  "private": true,
  "gypfile": true,
  "dependencies": { "node-addon-api": "^8.0.0" },
  "scripts": { "build:deps": "bash scripts/build-deps.sh", "build": "node-gyp rebuild" }
}
```

`nativelibs/zaudio/.gitignore`:
```
node_modules/
build/
.deps/
src/miniaudio.h
```

`nativelibs/zaudio/binding.gyp`:
```python
{
  "targets": [{
    "target_name": "zaudio",
    "sources": ["src/zaudio.cpp", "src/miniaudio_impl.c"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<(module_root_dir)/.deps/include",
      "<(module_root_dir)/src"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_c": ["-O2"],
    "libraries": [
      "<(module_root_dir)/.deps/lib/libopus.a",
      "-Wl,--exclude-libs,ALL",
      "-ldl", "-lm", "-lpthread"
    ]
  }]
}
```

`nativelibs/zaudio/scripts/build-deps.sh`:
```bash
#!/usr/bin/env bash
# Build libopus static into .deps + vendor miniaudio.h into src/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$HERE/.deps"
OPUS_VER="1.5.2"
MA_VER="0.11.21"
# libopus (release tarball has ./configure — no autotools needed)
if [ ! -f "$PREFIX/lib/libopus.a" ]; then
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  cd "$WORK"
  curl -fsSL -o opus.tar.gz "https://downloads.xiph.org/releases/opus/opus-$OPUS_VER.tar.gz"
  tar xzf opus.tar.gz; cd "opus-$OPUS_VER"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-doc --disable-extra-programs
  make -j"$(nproc)"; make install
  echo "libopus $OPUS_VER -> $PREFIX"
fi
# miniaudio single header (vendored)
if [ ! -f "$HERE/src/miniaudio.h" ]; then
  curl -fsSL -o "$HERE/src/miniaudio.h" "https://raw.githubusercontent.com/mackron/miniaudio/$MA_VER/miniaudio.h"
  echo "miniaudio.h $MA_VER -> src/"
fi
```

`nativelibs/zaudio/src/miniaudio_impl.c` (the single implementation TU — created here so Task 1 links; the device code lives in zaudio.cpp in Task 2):
```c
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_DECODING
#include "miniaudio.h"
```

`nativelibs/zaudio/README.md`:
````markdown
# zaudio — opus + miniaudio N-API addon (SP2 3)

Full-duplex audio for the Linux zcall engine: opus 16 kHz mono 20 ms, mic/speaker via miniaudio
(dlopen ALSA/Pulse/PipeWire). Static libopus; miniaudio vendored (git-ignored).

## Build (local Node)
```
cd nativelibs/zaudio
npm install --ignore-scripts
npm run build:deps      # libopus static + fetch miniaudio.h
npm run build           # -> build/Release/zaudio.node
node __tests__/opus-roundtrip.test.js
```
````

- [ ] **Step 2: Build deps + a stub addon to verify the toolchain links**

Create the initial `nativelibs/zaudio/src/zaudio.cpp` (opus only, no miniaudio yet):
```cpp
#include <napi.h>
#include <opus.h>
#include <cstring>
#include <vector>

class ZAudio : public Napi::ObjectWrap<ZAudio> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  ZAudio(const Napi::CallbackInfo& info);
  ~ZAudio();

 private:
  OpusEncoder* enc_ = nullptr;
  OpusDecoder* dec_ = nullptr;
  int sampleRate_ = 16000, channels_ = 1, frameSamples_ = 320;
  Napi::Value EncodeFrame(const Napi::CallbackInfo& info);
  Napi::Value DecodeFrame(const Napi::CallbackInfo& info);
};

Napi::Object ZAudio::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function f = DefineClass(env, "ZAudio", {
    InstanceMethod("encodeFrame", &ZAudio::EncodeFrame),
    InstanceMethod("decodeFrame", &ZAudio::DecodeFrame),
  });
  exports.Set("ZAudio", f);
  return exports;
}

ZAudio::ZAudio(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ZAudio>(info) {
  Napi::Env env = info.Env();
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object o = info[0].As<Napi::Object>();
    if (o.Has("sampleRate")) sampleRate_ = o.Get("sampleRate").As<Napi::Number>().Int32Value();
    if (o.Has("channels")) channels_ = o.Get("channels").As<Napi::Number>().Int32Value();
    if (o.Has("frameMs")) frameSamples_ = sampleRate_ * o.Get("frameMs").As<Napi::Number>().Int32Value() / 1000;
  }
  int err = 0;
  enc_ = opus_encoder_create(sampleRate_, channels_, OPUS_APPLICATION_VOIP, &err);
  if (err != OPUS_OK) { Napi::Error::New(env, "opus_encoder_create failed").ThrowAsJavaScriptException(); return; }
  int bitrate = 24000;
  if (info.Length() > 0 && info[0].IsObject() && info[0].As<Napi::Object>().Has("bitrate"))
    bitrate = info[0].As<Napi::Object>().Get("bitrate").As<Napi::Number>().Int32Value();
  opus_encoder_ctl(enc_, OPUS_SET_BITRATE(bitrate));
  dec_ = opus_decoder_create(sampleRate_, channels_, &err);
  if (err != OPUS_OK) { Napi::Error::New(env, "opus_decoder_create failed").ThrowAsJavaScriptException(); return; }
}

ZAudio::~ZAudio() {
  if (enc_) opus_encoder_destroy(enc_);
  if (dec_) opus_decoder_destroy(dec_);
}

Napi::Value ZAudio::EncodeFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "encodeFrame(pcm: Buffer)").ThrowAsJavaScriptException(); return env.Null(); }
  Napi::Buffer<uint8_t> pcm = info[0].As<Napi::Buffer<uint8_t>>();
  const opus_int16* samples = reinterpret_cast<const opus_int16*>(pcm.Data());
  std::vector<uint8_t> out(4000);
  int n = opus_encode(enc_, samples, frameSamples_, out.data(), (opus_int32)out.size());
  if (n < 0) { Napi::Error::New(env, std::string("opus_encode: ") + opus_strerror(n)).ThrowAsJavaScriptException(); return env.Null(); }
  return Napi::Buffer<uint8_t>::Copy(env, out.data(), n);
}

Napi::Value ZAudio::DecodeFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "decodeFrame(opus: Buffer)").ThrowAsJavaScriptException(); return env.Null(); }
  Napi::Buffer<uint8_t> op = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<opus_int16> pcm(frameSamples_ * channels_);
  int n = opus_decode(dec_, op.Data(), (opus_int32)op.Length(), pcm.data(), frameSamples_, 0);
  if (n < 0) { Napi::Error::New(env, std::string("opus_decode: ") + opus_strerror(n)).ThrowAsJavaScriptException(); return env.Null(); }
  return Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<uint8_t*>(pcm.data()), n * channels_ * 2);
}

static Napi::Object InitAll(Napi::Env env, Napi::Object exports) { return ZAudio::Init(env, exports); }
NODE_API_MODULE(zaudio, InitAll)
```

Run:
```
cd nativelibs/zaudio
npm install --ignore-scripts --no-audit --no-fund
npm run build:deps
npm run build
```
Expected: `.deps/lib/libopus.a` + `src/miniaudio.h` exist; `build/Release/zaudio.node` produced.

- [ ] **Step 3: Write the round-trip test**

Create `nativelibs/zaudio/__tests__/opus-roundtrip.test.js`:
```js
const assert = require('assert');
const path = require('path');
const { ZAudio } = require(path.join(__dirname, '..', 'build', 'Release', 'zaudio.node'));

const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });

// 20 ms of a 440 Hz sine at 16 kHz mono, int16 (320 samples).
const N = 320;
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 8000), i * 2);

const opus = a.encodeFrame(pcm);
assert.ok(Buffer.isBuffer(opus) && opus.length > 0 && opus.length < 400, 'opus frame produced');

const back = a.decodeFrame(opus);
assert.strictEqual(back.length, N * 2, 'decoded PCM is one 20 ms frame');
// opus is lossy — check the decoded frame carries real signal energy (not silence).
let energy = 0;
for (let i = 0; i < N; i++) { const s = back.readInt16LE(i * 2); energy += s * s; }
const rms = Math.sqrt(energy / N);
assert.ok(rms > 500, 'decoded frame has audio energy (rms=' + rms.toFixed(0) + ')');
console.log('OK zaudio opus-roundtrip (opus ' + opus.length + 'B, rms ' + rms.toFixed(0) + ')');
```

- [ ] **Step 4: Run the round-trip test**

Run: `node nativelibs/zaudio/__tests__/opus-roundtrip.test.js`
Expected: `OK zaudio opus-roundtrip …`.

- [ ] **Step 5: Commit** (only if asked)

```bash
git add nativelibs/zaudio/package.json nativelibs/zaudio/.gitignore nativelibs/zaudio/binding.gyp \
        nativelibs/zaudio/scripts/build-deps.sh nativelibs/zaudio/src/zaudio.cpp \
        nativelibs/zaudio/src/miniaudio_impl.c nativelibs/zaudio/README.md \
        nativelibs/zaudio/__tests__/opus-roundtrip.test.js
git commit -m "zcall SP2 3: zaudio addon (static libopus) — opus encode/decode round-trip (16k mono 20ms)"
```

---

### Task 2: miniaudio capture + playback (start / play / stop)

**Files:**
- Modify: `nativelibs/zaudio/src/zaudio.cpp` (add miniaudio device + threadsafe onFrame + jitter buffer)

**Interfaces (added):**
- `.start(onFrame: (opus: Buffer) => void)` — opens a duplex 16 kHz device; emits one opus frame per 20 ms of mic input.
- `.play(opus: Buffer)` — decode + enqueue to the speaker jitter buffer.
- `.stop()` — stop device + release the threadsafe function.

- [ ] **Step 1: Add the miniaudio device to `zaudio.cpp`**

Add includes + members + methods (merge into the existing file):
```cpp
#include "miniaudio.h"
#include <deque>
#include <mutex>

// ... inside class ZAudio (add):
//   ma_device device_;  bool running_ = false;
//   Napi::ThreadSafeFunction tsfn_;
//   std::vector<opus_int16> capAccum_;              // accumulate mic PCM to 20 ms frames
//   std::deque<opus_int16> playBuf_; std::mutex playMtx_;   // speaker jitter buffer
//   void Start(const Napi::CallbackInfo&); void Play(const Napi::CallbackInfo&); void Stop(const Napi::CallbackInfo&);
//   static void DataCB(ma_device*, void*, const void*, ma_uint32);
```

Register the methods in `Init` (add to `DefineClass`):
```cpp
    InstanceMethod("start", &ZAudio::Start),
    InstanceMethod("play", &ZAudio::Play),
    InstanceMethod("stop", &ZAudio::Stop),
```

Implement:
```cpp
void ZAudio::DataCB(ma_device* dev, void* out, const void* in, ma_uint32 frames) {
  ZAudio* self = static_cast<ZAudio*>(dev->pUserData);
  // capture: accumulate mic PCM, encode each full 20 ms frame, emit to JS
  if (in) {
    const opus_int16* mic = static_cast<const opus_int16*>(in);
    self->capAccum_.insert(self->capAccum_.end(), mic, mic + frames * self->channels_);
    const int fs = self->frameSamples_ * self->channels_;
    while ((int)self->capAccum_.size() >= fs) {
      unsigned char enc[4000];
      int n = opus_encode(self->enc_, self->capAccum_.data(), self->frameSamples_, enc, sizeof(enc));
      self->capAccum_.erase(self->capAccum_.begin(), self->capAccum_.begin() + fs);
      if (n > 0 && self->tsfn_) {
        auto* payload = new std::vector<uint8_t>(enc, enc + n);
        self->tsfn_.NonBlockingCall(payload, [](Napi::Env env, Napi::Function cb, std::vector<uint8_t>* d) {
          cb.Call({ Napi::Buffer<uint8_t>::Copy(env, d->data(), d->size()) });
          delete d;
        });
      }
    }
  }
  // playback: pull from the jitter buffer, silence on underrun
  if (out) {
    opus_int16* spk = static_cast<opus_int16*>(out);
    std::lock_guard<std::mutex> lk(self->playMtx_);
    ma_uint32 want = frames * self->channels_;
    for (ma_uint32 i = 0; i < want; i++) {
      if (!self->playBuf_.empty()) { spk[i] = self->playBuf_.front(); self->playBuf_.pop_front(); }
      else spk[i] = 0;
    }
  }
}

void ZAudio::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (running_) return;
  if (info.Length() < 1 || !info[0].IsFunction()) { Napi::TypeError::New(env, "start(onFrame)").ThrowAsJavaScriptException(); return; }
  tsfn_ = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "zaudio-onframe", 0, 1);
  ma_device_config cfg = ma_device_config_init(ma_device_type_duplex);
  cfg.sampleRate = sampleRate_;
  cfg.capture.format = ma_format_s16;  cfg.capture.channels = channels_;
  cfg.playback.format = ma_format_s16; cfg.playback.channels = channels_;
  cfg.periodSizeInFrames = frameSamples_;
  cfg.dataCallback = &ZAudio::DataCB;
  cfg.pUserData = this;
  if (ma_device_init(NULL, &cfg, &device_) != MA_SUCCESS) { tsfn_.Release(); Napi::Error::New(env, "ma_device_init failed").ThrowAsJavaScriptException(); return; }
  if (ma_device_start(&device_) != MA_SUCCESS) { ma_device_uninit(&device_); tsfn_.Release(); Napi::Error::New(env, "ma_device_start failed").ThrowAsJavaScriptException(); return; }
  running_ = true;
}

void ZAudio::Play(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) { Napi::TypeError::New(env, "play(opus: Buffer)").ThrowAsJavaScriptException(); return; }
  Napi::Buffer<uint8_t> op = info[0].As<Napi::Buffer<uint8_t>>();
  std::vector<opus_int16> pcm(frameSamples_ * channels_);
  int n = opus_decode(dec_, op.Data(), (opus_int32)op.Length(), pcm.data(), frameSamples_, 0);
  if (n < 0) return;
  std::lock_guard<std::mutex> lk(playMtx_);
  // cap the buffer (~400 ms) to bound latency on overrun
  if ((int)playBuf_.size() > sampleRate_ * channels_ * 4 / 10) playBuf_.clear();
  playBuf_.insert(playBuf_.end(), pcm.begin(), pcm.begin() + n * channels_);
}

void ZAudio::Stop(const Napi::CallbackInfo& info) {
  if (running_) { ma_device_uninit(&device_); running_ = false; }
  if (tsfn_) { tsfn_.Release(); }
}
```
Also change `src/miniaudio_impl.c` to keep only the implementation (already does); ensure `zaudio.cpp` includes `"miniaudio.h"` (declarations) after the opus includes.

- [ ] **Step 2: Rebuild**

Run: `cd nativelibs/zaudio && npm run build`
Expected: `build/Release/zaudio.node` rebuilt with no errors. (Fix any compile errors — typically missing include order or a ma_* signature; miniaudio version pinned in build-deps.)

- [ ] **Step 3: Manual loopback verify (operator, needs mic + speaker)**

Create `nativelibs/zaudio/loopback.js` (not a CI test — echoes your mic to your speaker via encode→decode):
```js
const path = require('path');
const { ZAudio } = require(path.join(__dirname, 'build', 'Release', 'zaudio.node'));
const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });
let n = 0;
a.start((opus) => { a.play(opus); if (++n % 50 === 0) process.stdout.write('.'); });
console.log('loopback: speak — you should hear yourself (~40ms delay). Ctrl+C to stop.');
setTimeout(() => { a.stop(); process.exit(0); }, 15000);
```
Run: `node nativelibs/zaudio/loopback.js` — speak; you should hear your own voice looped back. Confirms mic capture + encode + decode + playback all work. (Use headphones to avoid feedback.)

- [ ] **Step 4: Commit** (only if asked)

```bash
git add nativelibs/zaudio/src/zaudio.cpp nativelibs/zaudio/loopback.js
git commit -m "zcall SP2 3: zaudio miniaudio duplex device — mic->opus onFrame + play->decode->speaker (jitter buffer)"
```

---

### Task 3: Wire audio into the connected call (`live-audio.js`) + live duplex

**Files:**
- Create: `tools/zcall-media/zaudio.js` (addon loader, like `zsrtp.js`)
- Create: `tools/zcall-media/live-audio.js`
- Modify: `tools/zcall-media/README.md` (append a "Full-duplex audio (SP2 3)" section)

**Interfaces:**
- Consumes: `ZAudio` (Task 1/2), and the connected-call flow from `live-call.js` (requestCall → open → ring-with-extendData → answerAck → MediaSession).

- [ ] **Step 1: Addon loader**

Create `tools/zcall-media/zaudio.js`:
```js
'use strict';
const path = require('path');
const ADDON = path.join(__dirname, '..', '..', 'nativelibs', 'zaudio', 'build', 'Release', 'zaudio.node');
let addon;
try { addon = require(ADDON); }
catch (e) { throw new Error('zaudio addon not built — run:\n  cd nativelibs/zaudio && npm install --ignore-scripts && npm run build:deps && npm run build\nOriginal: ' + e.message); }
module.exports = addon; // { ZAudio }
```

- [ ] **Step 2: `live-audio.js` — the duplex call**

Create `tools/zcall-media/live-audio.js` by copying `live-call.js`'s connected-call setup (requestCall → open → extendData ring → answerAck loop → endCall) and replacing the filler stream + adding playback:
```js
'use strict';
// Operator-run full-duplex audio call on Linux (own account / own phone). Same connect flow as
// live-call.js, but the mic drives outbound opus and inbound opus plays to the speaker.
const os = require('os');
const path = require('path');
const { invokeRequestCall } = require('../zcall-signaling/cdp-invoke.js');
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { ring, endCall, answerAck, buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');
const { readAnswer } = require('../zcall-signaling/read-answer.js');
const { MediaSession } = require('./media-session.js');
const { ZAudio } = require('./zaudio.js');

function flag(n, d) { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-media/live-audio.js <calleeId> [--wait 40000] [--talk 30000]');
  const waitMs = Number(flag('--wait', '40000'));
  const talkMs = Number(flag('--talk', '30000'));
  const logPath = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');

  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));
  const key = srtpMasterKey(config.sessId);

  const s = new MediaSession({ key, ssrc: config.fromId });
  const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });
  let inOk = 0;
  s.on('media', (m) => { inOk++; try { audio.play(m.payload); } catch (_) {} });   // inbound opus -> speaker

  const selHost = config.rtpIP ? parseAddr(config.rtpIP).host : null;
  const servers = config.servers.slice();
  if (config.rtpIP) servers.push({ rtpaddr: config.rtpIP });
  const opened = await s.open({ servers, fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, preferHost: selHost });
  if (!opened) throw new Error('no relay replied to InitZRTP');

  const sport = s.sock.address().port;
  const p2p = [];
  const nets = os.networkInterfaces();
  for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
  const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });

  try { await ring({ calleeId, callId, config, rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData }); } catch (e) { throw new Error('ring failed: ' + e.message); }
  console.log('[live-audio] ringing — ANSWER on your phone and talk…');

  // Mic -> opus -> outbound media (replaces the silent filler).
  audio.start((opus) => { try { s.send(opus); } catch (_) {} });

  // answerAck on first answer.
  let ackSent = false; const deadline = Date.now() + waitMs + talkMs;
  const poll = setInterval(async () => {
    const a = readAnswer(logPath, callId);
    if (a && a.rtpSerIp && !ackSent) { ackSent = true; try { await answerAck({ calleeId, callId }); } catch (_) {} console.log('[live-audio] answer (status ' + a.status + ') -> answerAck'); }
  }, 500);

  await sleep(waitMs + talkMs > 0 ? Math.min(waitMs + talkMs, waitMs + talkMs) : talkMs);
  await sleep(0);
  await new Promise((r) => setTimeout(r, talkMs));
  clearInterval(poll);
  audio.stop(); s.close();
  try { await endCall({ uidTo: config.toId, callId }); } catch (_) {}
  console.log('[live-audio] done — inbound audio frames played: ' + inOk);
  process.exit(inOk ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('[live-audio] FAILED:', e.message); process.exit(1); });
module.exports = { main };
```
(Timing note: keep it simple — ring, start mic, poll+answerAck, run for `talkMs`, then stop. Trim the redundant sleeps above to a single `await sleep(talkMs)` after ring if preferred.)

- [ ] **Step 3: Verify syntax + the addon loader**

Run: `node --check tools/zcall-media/live-audio.js && node -e "require('./tools/zcall-media/zaudio.js'); console.log('zaudio loads')"`
Expected: `zaudio loads` (addon built in Task 1/2).

- [ ] **Step 4: Append the README section**

Append to `tools/zcall-media/README.md`:
````markdown
## Full-duplex audio (SP2 3)

Hear the peer + speak, on a real connected call. Build the addons first (`nativelibs/zsrtp` and
`nativelibs/zaudio` — see their READMEs).

- `zaudio.js` — loads the `nativelibs/zaudio` opus+miniaudio addon.
- `live-audio.js` — operator CLI: the connected-call flow (like `live-call.js`) with the mic driving
  outbound opus and inbound opus playing to the speaker.

### Run live (own call)
1. Build: `cd nativelibs/zaudio && npm i --ignore-scripts && npm run build:deps && npm run build`
2. `ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux &`
3. `node tools/zcall-media/live-audio.js <yourCalleeId>` — answer on your phone and talk.
   Use headphones to avoid echo.
````

- [ ] **Step 5: Manual live validation (operator)**

Not a CI step. On a real call: `node tools/zcall-media/live-audio.js <ownCalleeId>` → answer on the
phone → **you hear the peer and the peer hears you** (full-duplex). Record the redacted result in
the §I decision doc / spec success criteria.

- [ ] **Step 6: Commit** (only if asked)

```bash
git add tools/zcall-media/zaudio.js tools/zcall-media/live-audio.js tools/zcall-media/README.md \
        docs/superpowers/specs/2026-07-14-zcall-sp2-3-audio-opus-design.md \
        docs/superpowers/plans/2026-07-14-zcall-sp2-3-audio-opus.md
git commit -m "zcall SP2 3: full-duplex audio CLI (mic->opus->send, recv->opus->speaker)"
```

---

## Manual live validation (operator, after Task 3)

On the operator's own account/phone, after building `nativelibs/zaudio`:
`node tools/zcall-media/live-audio.js <ownCalleeId>` → answer → confirm **two-way audio**. Note the
RTP timestamp increment (open item): if outbound sounds wrong-pitched/fast, switch
`MediaSession.send`'s ts increment (960 ↔ 320) to match `opus/16000/1`.
