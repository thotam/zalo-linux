# RE mp4thumb — Linux native addon (C++ node-addon-api + pinned FFmpeg 5.1)

**Date:** 2026-07-11
**Branch:** `re/mp4thumb`
**Goal:** Port the macOS/Windows-only `mp4thumb` native module to Linux (**x64 only**
for now) by faithfully rebuilding its C++ `node-addon-api` addon, linking a **pinned
static FFmpeg 5.1.x**, exposing the **full API**, with **byte-identical-by-construction**
JPEG output (exact FFmpeg version + exact reconstructed pipeline).

> **Fidelity caveat (important, differs from file-utils/file-utilities):** there is NO
> independent host-reproducible oracle for a video thumbnail (unlike `statvfs`). The
> output JPEG is byte-identical to the mac binary ONLY IF the FFmpeg version and the
> decode→scale→encode→mux logic match exactly — which we replicate. But we cannot *prove*
> byte-equality vs mac locally (no Mac to generate reference JPEGs; the mjpeg-muxer output
> can't be re-derived by an independent tool). Verification is therefore: valid JPEG,
> correct dimensions, re-decodable, deterministic across runs — plus **byte-identical by
> construction** (pinned FFmpeg 5.1.x + exact params). If a mac/Windows-produced reference
> thumbnail is later supplied, a direct byte-compare can be added.

---

## 1. Background

`app/native/nativelibs/mp4thumb/index.js` hard-throws on Linux
(`"mp4thumb: no Linux prebuilt (video thumbnails out of v1 scope)"`) and falls back to a
stub whose methods throw `{error:'LIB_ERR'}`. So video thumbnails silently fail on Linux.
Aggregator: `mp4thumb: () => require('./mp4thumb/index.js')` (4 call-sites app-wide).

The JS wrapper's public surface is `{ generateThumbnail(inputPath, outputPath, maxWidth,
maxHeight, mediaId), cancel(mediaId) }`, built over the **native class `MP4Thumb`**.

---

## 2. RE evidence (from `darwin-x64/mp4thumb.node`)

Mach-O x86_64, 2.7 MB, **node-addon-api** (`Napi::ObjectWrap<MP4Thumb>`). Links only
`libc++`/`libSystem` → the video stack is **statically baked in**. Strings identify it as
**FFmpeg 5.1** (`Lavc59.37.100`, `Lavf59.27.100`; libavcodec/avformat/swscale;
`libavcodec/h264dec.c`, `hevcdec.c`, `mjpegenc.c`, `libswscale/*`). Source
`../src/mp4thumb.cpp` (khatran / zalo-pc-app). Every step is a named method — the logic
was recovered by Capstone disassembly + Mach-O symbol/stub resolution (not guessed).

### 2.1 Native API surface (full)

| Symbol | Signature | Bound as |
|---|---|---|
| `MP4Thumb::Init` | registers the class | — |
| `MP4Thumb::GenerateThumbnail` | `(CallbackInfo) → Boolean` (sync) | `generateThumbnail` |
| `MP4Thumb::GenerateThumbnailAsync` | `(CallbackInfo) → Promise` (AsyncWorker) | `generateThumbnailAsync` |
| `MP4Thumb::setOutputPath` | `(CallbackInfo)` | `setOutputPath` **(exists, unused by JS wrapper — residual)** |
| `MP4Thumb::cancel` | `(CallbackInfo)` — sets an atomic cancel flag (`this+0x68`) | `cancel` |
| ctor `MP4Thumb::MP4Thumb(CallbackInfo)` | initializes default maxW/maxH members (`this+0x1c`, `this+0x20`) | — |

Arg validation (both generate methods): require `arg[0]` and `arg[1]` = **string**
(`inputPath`, `outputPath`); else throw `TypeError("Usage: generateThumbnail(inputPath,
outputPath [, maxWidth, maxHeight])")` (async variant: same with `generateThumbnailAsync`).

### 2.2 `GetDimensions(info, wIdx=2, hIdx=3, &outW, &outH)`

```
outW = this->defaultMaxW (member @0x1c)   // set in ctor / setOutputPath
outH = this->defaultMaxH (member @0x20)
if (arg[2] is Number) outW = arg[2].Uint32Value()
if (arg[3] is Number) outH = arg[3].Uint32Value()
```

### 2.3 `ProcessVideo(env, AVFormatContext*, outputPath, maxW, maxH)` — the pipeline

```
1. streamIdx = FindVideoStream(env, ctx, &codec)          // find_stream_info + best video stream
2. decCtx    = SetupDecoderContext(env, ctx, streamIdx, codec)  // alloc + params_to_ctx + open2
3. if (cancelFlag) abort
4. frame = DecodeFirstFrame(env, ctx, decCtx, streamIdx)  // read pkts of that stream, send/receive,
                                                          // return the FIRST decoded frame (no seek,
                                                          // no keyframe/thumbnail filter)
5. avcodec_free_context(decCtx)
6. srcW = frame.width (0x68), srcH = frame.height (0x6c)
   if (srcW <= maxW && srcH <= maxH) { newW=srcW; newH=srcH }   // never upscale
   else { scale = min(maxW/srcW, maxH/srcH);                    // fit-inside, preserve aspect
          newW = (int)(scale*srcW); newH = (int)(scale*srcH) }
   newW &= ~1; newH &= ~1;                                      // round down to even
7. scaled = ScaleAndConvertFrame(env, frame, srcPixFmt, newW, newH, AV_PIX_FMT_YUV420P)
8. av_frame_free(frame)
9. pkt = EncodeToJPEG(env, scaled, newW, newH, AV_PIX_FMT_YUV420P)
10. av_frame_free(scaled)
11. ok = WriteJPEGFile(env, outputPath, pkt, newW, newH, AV_PIX_FMT_YUV420P)
12. av_packet_free(pkt); return ok
```

### 2.4 The exact FFmpeg constants (byte-identical surface)

- **Decode:** native FFmpeg decoders (h264/hevc/…), deterministic per libavcodec version.
- **Scale (`ScaleAndConvertFrame`):**
  `sws_getContext(srcW, srcH, srcPixFmt, dstW, dstH, AV_PIX_FMT_YUV420P, **SWS_BICUBIC (4)**,
  NULL, NULL, NULL)` then `sws_scale`. dst frame `AV_PIX_FMT_YUV420P`.
- **Encode (`EncodeToJPEG`):** `avcodec_find_encoder(AV_CODEC_ID_MJPEG=7)`;
  `ctx->width=newW; ctx->height=newH; ctx->pix_fmt=YUV420P; ctx->time_base={1,1};
  ctx->color_range=AVCOL_RANGE_JPEG (2)`; `av_opt_set_int(ctx->priv_data, "q", 3, 0)`;
  `avcodec_open2`; `avcodec_send_frame`; `avcodec_receive_packet`.
- **Write (`WriteJPEGFile`):** re-mux via `avformat_alloc_output_context2(NULL, NULL,
  "mjpeg", ...)` → `avformat_new_stream` → fresh MJPEG encoder ctx (same `"q"` option) →
  `avcodec_open2` → `avcodec_parameters_from_context` → `avio_open(outputPath)` →
  write header + packet + trailer. (Output is a JFIF JPEG produced by the mjpeg muxer, not
  a raw fwrite.)

### 2.5 Error strings (exact)

`"Usage: generateThumbnail(inputPath, outputPath [, maxWidth, maxHeight])"`,
`"Usage: generateThumbnailAsync(inputPath, outputPath [, maxWidth, maxHeight])"`,
`"Could not open input file: <av_strerror>"`, `"Could not allocate packet/frame"`,
`"MJPEG encoder not found"`, `"Failed to generate thumbnail"`.

---

## 3. API contract (full, to expose on Linux)

```ts
class MP4Thumb {
  constructor();
  generateThumbnail(inputPath: string, outputPath: string, maxWidth?: number, maxHeight?: number): boolean;
  generateThumbnailAsync(inputPath: string, outputPath: string, maxWidth?: number, maxHeight?: number): Promise<boolean>;
  setOutputPath(...): void;   // reconstruct faithfully even though the JS wrapper never calls it
  cancel(): void;             // sets atomic cancel flag; aborts an in-flight generate
}
```

The JS wrapper (`index.js`) is unchanged except a spliced `linux` branch loading our
`.node`; its `{generateThumbnail, cancel}` facade + `mediaId` cache keeps working.

---

## 4. Build approach — pinned static FFmpeg 5.1.x

Chosen (user-confirmed): **pin FFmpeg 5.1.x, build static from source**, link into the
C++ addon. Rationale: matching `Lavc 59.37.100` is the necessary condition for
byte-identical output, AND static-linking keeps the `.node` self-contained + portable
(no system libav*, no distro-version drift) — same philosophy as zjxl pinning libjxl
(see memory `native-lib-portability-playbook`).

- **Deps infra** modeled on `nativelibs/zjxl/scripts/{deps-hash.js,build-deps.sh}`:
  content-addressed `.deps-prefix/<hash>`; hash pins the FFmpeg tag + configure flags so a
  bump invalidates the cache. `.deps-prefix/`, `deps-src/` are gitignored.
- **FFmpeg configure** (static, no external encoders — we only mjpeg-*encode*, and *decode*
  with native decoders → zero non-system deps):
  `--enable-static --disable-shared --enable-pic --disable-programs --disable-doc
   --disable-network --disable-everything` then re-enable: swscale/swresample; a broad set
  of native **decoders** (h264, hevc, mpeg4, mpeg2video, mpeg1video, vp8, vp9, av1, mjpeg,
  png, gif, …), **parsers** + **demuxers** (mov, matroska, webm, avi, flv, mpegts, …),
  **encoder** mjpeg, **muxers** mjpeg + image2, **protocol** file. Exact list pinned in
  `build-deps.sh`; hashed.
- **binding.gyp:** node-addon-api, C++17, `-fexceptions`; `include_dirs`/`libraries` from
  the deps prefix; link `-lavformat -lavcodec -lswscale -lswresample -lavutil` (+ `-lm
  -lpthread -lz` system). Static `.a` → the `.node` needs no bundled `.so`.

FFmpeg version note: the release whose `libavcodec==59.37.100` is **n5.1** (5.1.0/5.1.x
kept 59.37.100). `build-deps.sh` checks out the exact tag and the build asserts the
reported `Lavc`/`Lavf` version strings match §2 before proceeding.

---

## 5. File layout (new)

```
nativelibs/mp4thumb/
  binding.gyp
  package.json
  src/mp4thumb.cpp             # reconstructed pipeline + full API (ObjectWrap)
  scripts/
    deps-hash.js               # pins ffmpeg tag + flags -> .deps-prefix/<hash>
    build-deps.sh              # builds FFmpeg 5.1.x static into the prefix
  __tests__/
    load-addon.js
    thumbnail.test.js          # synth a tiny test video (ffmpeg-generated fixture),
                               # generate thumb, assert JPEG magic + dims + re-decode;
                               # determinism (two runs byte-equal); error contract; cancel
  README.md
  RE-PARAMS.md                 # this spec's §2, condensed (symbol/offset/const evidence)
scripts/patches/patch-mp4thumb.js   # build deps -> build addon -> deploy -> splice -> ldd gate
```

Deploy to `app/native/nativelibs/mp4thumb/linux/mp4thumb.node`, splice a `linux` branch
into `mp4thumb/index.js` (require our `.node` before the win32/darwin cases’ catch).

---

## 6. Verification plan

1. **Fixture:** generate a tiny deterministic test video with the *same pinned ffmpeg*
   (e.g. `testsrc`/`color` → H.264 mp4) at build/test time — no binary checked in.
2. **Functional:** `generateThumbnail(fixture, out.jpg, 320, 240)` returns `true`; `out.jpg`
   starts with `FF D8 FF` (JFIF); re-decode → dimensions == expected fit-inside-even math.
3. **Aspect/round math:** assert `newW=min-ratio*srcW & ~1`, never upscaled.
4. **Determinism:** two runs produce **byte-identical** JPEGs (proves the pipeline is
   deterministic → the byte-identical-by-construction claim).
5. **Async + cancel:** `generateThumbnailAsync` resolves `true`; `cancel()` mid-flight
   aborts (best-effort, race-tolerant test).
6. **Error contract:** missing args → the exact Usage string; bad input path → "Could not
   open input file: …".
7. **ldd gate (patch):** `.node` links only base system libs (libc, libstdc++, libgcc_s,
   libm, libz, libpthread, ld-linux) — ffmpeg is static, so no libav* appears.
8. **App-level:** after patch, `require(app .../mp4thumb/index.js).generateThumbnail(...)`
   produces a thumbnail.
9. **GUI (verify branch):** exercise a video receive/preview so the logging harness shows
   `mp4thumb LOAD → {MP4Thumb:fn}` + `NEW MP4Thumb` + `CALL generateThumbnail(Async) → RET/RESOLVE true`.

> **Byte-vs-mac:** documented as by-construction; add a direct compare only if a
> mac/Windows-produced reference thumbnail becomes available.

---

## 7. Residuals

1. **No byte-vs-mac proof** locally (no Mac oracle) — see caveat above.
2. `setOutputPath` reconstructed for completeness though the JS wrapper never calls it
   (verify its exact semantics from disassembly during impl).
3. Decoder coverage = the pinned native set; an exotic input codec outside the set would
   fail to open (same as any ffmpeg build) — the enabled list aims to cover Zalo's videos.
4. arm64 deferred (deps + source are arch-agnostic; build `--arch=arm64` later).
5. Windows/macOS branches untouched.

---

## 8. Integration

- Register `patch-mp4thumb` in `scripts/main.js` after `patch-file-utils`.
- CI (`.github/workflows/build.yml`): add the ffmpeg build tool deps (nasm already; ensure
  `nasm`, `pkg-config` present) and let `build-deps.sh` run in the setup step (cache the
  `.deps-prefix` if CI caching is available).
- Docs: `nativelibs/README.md` row, `docs/RE-ROADMAP.md` (mp4thumb → DONE),
  `docs/RE-VERIFY-E39.md` (row flip once GUI-verified), memory update.
