# mp4thumb (Linux) — video → JPEG thumbnail

Linux reimplementation of Zalo's `mp4thumb` native addon: a C++ `node-addon-api`
class `MP4Thumb` that extracts a thumbnail from a video and writes it as a JPEG,
built on a **pinned static-from-source FFmpeg 5.1** (libavcodec 59.37.100 — the exact
version the mac binary links). The mac/Windows binary hard-throws on Linux; this rebuild
restores video thumbnails.

## API (full)

```ts
class MP4Thumb {
  constructor(maxWidth?: number, maxHeight?: number);   // defaults 640x640
  generateThumbnail(inputPath, outputPath, maxWidth?, maxHeight?): boolean;        // sync
  generateThumbnailAsync(inputPath, outputPath, maxWidth?, maxHeight?): Promise<boolean>;
  setOutputPath(path: string): void;   // reconstructed; the JS wrapper never calls it
  cancel(): void;                      // sets an atomic flag aborting an in-flight generate
}
```

The app's `index.js` wraps this as `{ generateThumbnail(in, out, w, h, mediaId), cancel(mediaId) }`.

## Pipeline (reverse-engineered, byte-identical by construction)

`avformat_open_input` → `avformat_find_stream_info` → `av_find_best_stream(VIDEO)` →
decode the **first** frame (no seek) → fit-inside-even resize
(`scale = min(maxW/w, maxH/h)`, downscale-only, dims `&= ~1`) → `sws_scale` with
**`SWS_BICUBIC`** to `YUV420P` → **MJPEG** encode (`color_range=JPEG`, `time_base=1/1`,
`av_opt_set_int(priv,"q",3)`) → write via the **`mjpeg` muxer** to `outputPath`.

Because the FFmpeg version and every pipeline constant match the mac binary, the output
JPEG is **byte-identical by construction**. (There is no local Mac to produce a reference
JPEG for a direct byte-compare — see the spec's fidelity caveat.)

## Build & test

```bash
bash scripts/build-deps.sh          # build pinned FFmpeg 5.1 (shared) into .deps-prefix/<hash>
node ../builder.js .                # node-gyp build the addon
node __tests__/thumbnail.test.js    # synth a JPEG fixture, thumbnail it, assert dims/determinism/contract
```

FFmpeg is **statically linked into the `.node`** with `-Wl,--exclude-libs,ALL` so every
ffmpeg symbol is **local/hidden**. This is essential under Electron: the renderer/utility
processes preload Electron's own `libffmpeg.so` (`RTLD_GLOBAL`), which exports the SAME
`avformat_open_input`/`av*` symbols. A shared/bundled ffmpeg gets **interposed** onto
Chromium's ffmpeg — which has no `file` protocol — so every call fails
`Could not open input file: Protocol not found` (reproduce with
`LD_PRELOAD=…/electron/dist/libffmpeg.so node …`; works fine in plain node). Hidden static
symbols make the `.node` self-contained and immune. Making the symbols local also lets the
x86-asm PC32 relocations link cleanly into the shared `.node` (a naive static link with
exported symbols fails) — so **SIMD stays on** (byte-identity preserved).
`--disable-inline-asm` works around an FFmpeg-5.1-on-new-binutils inline-asm build error
(external nasm SIMD stays on).

**Input is a LOCAL path** (verified from GUI: `/home/…/ZaloData/…/video/…`), not a URL —
the app pre-downloads cloud videos, then thumbnails the local file. `--enable-network
--enable-openssl` + `http,https,…` protocols are kept only for parity with the mac binary
(which supports them); this links **system** `libssl.so.3`/`libcrypto.so.3` (OpenSSL 3,
already the deb compat floor via static SQLCipher). ffmpeg itself is static, so `ldd` on
the `.node` shows only base system libs — no `libav*`.

Deployed by `scripts/patches/patch-mp4thumb.js`:
`app/native/nativelibs/mp4thumb/linux/{mp4thumb.node, libav*.so*, libsw*.so*}` + a spliced
`linux` branch in `mp4thumb/index.js`. `ldd` gate: only bundled libav*/libsw* + base
system libs.

## Residuals

- **No byte-vs-mac proof** locally (no Mac oracle). Byte-identity is by construction.
- `setOutputPath` reconstructed for API completeness though the JS wrapper never calls it.
- Decoder coverage = the pinned native set (h264/hevc/mpeg4/vp8/vp9/av1/… — see
  `scripts/build-deps.sh`); an input codec outside it fails to open (as any ffmpeg build).
- `linux/x64` only; arm64 deferred (source + deps arch-agnostic).

See [`../../docs/superpowers/specs/2026-07-11-mp4thumb-re-design.md`](../../docs/superpowers/specs/2026-07-11-mp4thumb-re-design.md)
and [`RE-PARAMS.md`](RE-PARAMS.md).
