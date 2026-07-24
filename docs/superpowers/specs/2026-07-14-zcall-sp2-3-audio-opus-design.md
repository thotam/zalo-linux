# SP2 step 3 — Full-duplex audio (opus, native) — design

**Date:** 2026-07-14
**Parent decisions:**
- [Outgoing-call connect flow — media plane validated live](../decisions/2026-07-14-zcall-outgoing-call-connect-flow.md)
- [InitZRTP + SRTP profile](../decisions/2026-07-13-zcall-initzrtp-and-srtp-profile.md)

**Status:** approved (brainstorming) → ready for writing-plans.

## Goal

Add the audio layer so a Linux caller can **hear the peer and speak to them** on a real connected
1-1 call: decode the inbound opus (already SRTP-decrypted, `pt=112`, `opus/16000/1`) to the speaker,
and capture the mic → opus-encode → the existing SRTP/RTP send path (replacing the silent filler).
No protocol/crypto unknowns remain — this is codec + audio I/O only.

## Global Constraints

- **Boundary:** operator's own account / machine / phone only; own traffic only. No secrets change
  hands; nothing new to redact beyond existing rules. Commit only when asked; no AI-attribution.
- **Codec:** opus, **16 kHz mono, 20 ms frames**, RTP payload type **112** (matches the call's
  `opus/16000/1`). VOIP encoder mode.
- **Runtime:** one native N-API C++ addon `nativelibs/zaudio` (static **libopus** + vendored
  **miniaudio** single-header). miniaudio `dlopen`s the ALSA/PulseAudio/PipeWire backend at runtime
  → link only `-ldl -lm -lpthread`; **no new deb Depends**. Build on ubuntu-22.04, `node-gyp`, the
  `nativelibs/zsrtp` pattern. Network/SRTP/RTP stay in the existing tested JS (`tools/zcall-media`).

## Architecture

### 1. `nativelibs/zaudio/` — N-API addon (libopus + miniaudio)
Mirrors `nativelibs/zsrtp` layout (`binding.gyp`, `src/zaudio.cpp`, `scripts/build-deps.sh`,
`package.json`, `__tests__/`, `.gitignore`, `README.md`).

JS API:
```
class ZAudio {
  constructor({ sampleRate = 16000, channels = 1, frameMs = 20, bitrate = 24000 })
  start(onFrame: (opus: Buffer) => void): void   // opens mic; emits one opus frame per 20 ms
  play(opus: Buffer): void                        // decode + enqueue to the speaker jitter buffer
  stop(): void
}
```
Internals (C++):
- **opus**: `opus_encoder_create(16000,1,OPUS_APPLICATION_VOIP)` + `opus_decoder_create`. Encode
  each 20 ms PCM frame (320 samples) → `onFrame`; decode inbound → PCM.
- **miniaudio**: a duplex (or two) device at 16 kHz mono. The **capture** callback fills a lock-free
  ring buffer; a worker drains 320-sample frames, opus-encodes, and calls `onFrame` via a **napi
  threadsafe function** (audio runs off the JS thread). The **playback** callback pulls PCM from a
  **jitter buffer** (~40–60 ms prebuffer) fed by `play()` (opus-decoded on the JS→C++ call).
- Thread-safety: ring buffers between the audio thread and JS; `play()` decodes + enqueues under a
  mutex; `onFrame` marshalled via the threadsafe function.

### 2. Glue in JS — `tools/zcall-media/live-audio.js` (or extend `live-call.js`)
Reuses the connected-call flow (requestCall → open/InitZRTP → ring-with-extendData → MediaSession):
- `audio = new ZAudio(); audio.start((opus) => session.send(opus));` — mic opus → the existing
  `MediaSession.send` (RTP pt112 → `srtp_protect` → 0x03 wrap → relay), replacing the filler.
- `session.on('media', (m) => audio.play(m.payload));` — inbound opus (post-SRTP-decrypt) → speaker.
- `audio.stop()` + `endCall` on exit.

## Data flow
```
MIC → miniaudio capture → opus.encode(20ms) → onFrame → MediaSession.send → RTP/SRTP/0x03 → relay
relay → MediaSession 'media' (SRTP decrypt) → opus payload → ZAudio.play → opus.decode → jitter → SPEAKER
```

## Testing
- **Offline (suite, needs the addon built locally):** opus **round-trip** — encode a generated
  16 kHz/20 ms PCM sine → decode → assert output length == frame size and non-trivial energy
  (correlation/RMS within tolerance). No audio device touched (uses the encoder/decoder directly via
  a test-only `encodeFrame`/`decodeFrame` export). Mirrors `zsrtp`'s offline round-trip.
- **Live (operator, manual):** a real call — the operator **hears the peer and is heard** (two-way
  audio). Audio-device paths (mic/speaker) can't be unit-tested in CI; validated live like the call.

## Build / portability
- `build-deps.sh`: fetch + build **libopus** (latest stable) static → `.deps/lib/libopus.a` +
  headers; **miniaudio.h** vendored in `src/` (single header, no build). `binding.gyp` links
  `<(module_root_dir)/.deps/lib/libopus.a -Wl,--exclude-libs,ALL -ldl -lm -lpthread`,
  `-std=c++17 -fexceptions`, node-addon-api. Built against local Node for tools tests; Electron
  build is step 4.

## Open items (resolved during impl / live)
- **RTP timestamp increment:** currently `+960` (20 ms @ 48 kHz per RFC 7587). For `opus/16000/1`
  it may be `+320` (16 kHz clock). Confirm from the Windows outbound capture; a wrong value only
  affects the send direction (one-line fix in `MediaSession.send`).
- **Echo:** the mic captures speaker output → echo. Prototype uses headphones or accepts it; real
  AEC is out of scope for step 3.
- **Jitter / clock drift:** tune the prebuffer size; handle under/overrun by resizing/dropping.

## What this explicitly does NOT cover
- Acoustic echo cancellation, noise suppression, AGC; video; wiring into `$zcall` + building the
  addons against Electron headers + shipping in the `.deb` (step 4).

## Success criteria
1. `nativelibs/zaudio` builds locally and its opus round-trip test passes.
2. On a real connected call, the operator **hears the peer and the peer hears the operator**
   (full-duplex audio) on Linux.
