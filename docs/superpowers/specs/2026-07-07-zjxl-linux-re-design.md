# zjxl — Linux native RE (bit-identical output) — Design Spec

**Date:** 2026-07-07
**Status:** Approved (pending user spec review)
**Module:** `native/nativelibs/zjxl` — JPEG-XL codec (decode/encode/resize)
**Goal:** Reimplement the macOS `jxl.node` N-API addon for Linux x64 so its **image output is bit-identical** to the original, by pinning the exact upstream library versions the mac bundle ships and recovering the exact encode parameters from the mac binary.

---

## 1. Why this module

Zalo stores/sends chat images as **JPEG-XL**. Without `zjxl`, `index.js` returns `{ error: 'not support' }` on Linux → images in chat **do not render** and outgoing images cannot be encoded. This is the highest-UX-impact native module remaining (roadmap P1).

## 2. What the original does (reverse-engineered from the mac binary)

`jxl.node` is a **node-addon-api (`Napi::`) N-API addon** — ABI-stable (napi v6), so one Linux build runs on all Electron 22.x (same model as `sqlite3`, `db-cross-v4`). This is confirmed by `napi_*` imports and demangled symbols in the Mach-O.

### 2.1 JS surface (`index.js`, must be preserved exactly)

`getLib()` requires the platform addon then wraps these native methods. Native method names and their input object shape / callback signature:

| JS wrapper | native method | input object | callback |
|---|---|---|---|
| `decodeToJpeg(buffer, quality, options)` | `jxlToJpeg` | `{ buffer, quality, outputWidth, outputHeight }` (defaults `outputWidth/Height = -1`) | `(error, data, status_code)` |
| `bitmapToJxl(buffer, width, height)` | `bitmapToJxl` | `{ buffer, width, height }` | `(error, data, status_code)` |
| `getJxlInfo(buffer)` | `getJxlInfo` | `{ buffer }` | `(error, data, status_code)` — `data` is an **object** merged into result |
| `resizeJxl(buffer, width, height)` | `resizeJxl` | `{ buffer, width, height }` | `(error, data, status_code)` |
| `resizeJxlLimit(buffer, width, height, limit)` | `resizeJxlLimit` | `{ buffer, width, height, limit }` | `(error, data, status_code)` |
| `moduleReady()` | `moduleReady` | — | sync, returns bool |
| `jxlDecompressMulti(options)` | `jxlDecompressMulti` | `options` (passed through) | `(error, data, status_code)` |

Resolved shape for buffer-returning methods: `{ data, status_code }`. On error: reject with `new Error(...)` whose `.code = status_code`. **This surface is contractual** — the renderer/main-dist calls these names; do not rename.

Also present as native exports (called internally / by `jxlToJpegFromLocalPath`): `jxlToJpegFromLocalPath`. Keep it exported for parity even if unused by current `index.js`.

### 2.2 Native pipeline per method (from demangled symbols)

- **`bitmapToJxl`** — raw RGBA/RGB bitmap → JXL. Uses `JxlEncoderSetBasicInfo`, `JxlEncoderSetColorEncoding`, `JxlEncoderSetFrameDistance`, `JxlEncoderSetFrameLossless`, `JxlEncoderFrameSettingsSetOption` (effort), `JxlEncoderSetParallelRunner`. **Distance / effort / lossless are runtime constants not present in the string table → must be recovered by disassembly (§5).**
- **`jxlToJpeg`** — JXL → pixels → **turbojpeg** encode at `libjpeg_quality`. No `JxlDecoderReconstructJPEG` symbol → it is a **re-encode**, not lossless JPEG reconstruction. Error string: `"%s:%d: JXL_FAILURE: please specify a 0-100 JPEG quality"`. Param names: `quality`, `jpeg_quality`, `libjpeg_quality`. Optional downscale to `outputWidth/outputHeight` when > 0.
- **`resizeJxl` / `resizeJxlLimit`** — decode JXL → `jxl::extras::PackedPixelFile` → **OpenCV resize** (`resizePPFWithOpenCV`, `resizeImage`, `shouldResize(int,int,int,int)`, `resizePPF`) → re-encode JXL. `resizeJxlLimit` adds a byte-size `limit` (iterative quality/distance reduction until under limit — semantics to confirm in §5). Interpolation flag (`INTER_*`) recovered by disassembly.
- **`getJxlInfo`** — parse JXL header → object (width/height/… — exact keys recovered in §5; internal `getJxlInfo(const uint8_t*, size_t, uint32_t*, uint32_t*, uint32_t*, int&)`).
- **`jxlDecompressMulti`** — batch decode; internal `jxlDecompressMultiHandler(JxlDecompressMultiInfo*, JxlOutput*, vector<JxlDecompressMultiOutput>)`. Semantics recovered in §5.
- **`moduleReady`** — returns readiness bool.

## 3. Exact dependency versions to pin (read from mac Mach-O `LC_ID_DYLIB`)

Bit-identical output requires the **same upstream versions** the mac bundle ships:

| Library | Pinned version | Notes |
|---|---|---|
| **libjxl** (+ `libjxl_cms`, `libjxl_dec`, `libjxl_threads`) | **0.9.3** | git tag `v0.9.3` |
| **libhwy** (Highway) | **1.0.7** | libjxl SIMD dep |
| **brotli** (common/dec/enc) | **1.0.9** | libjxl box/metadata dep |
| **libjpeg-turbo** | libjpeg **62.4.0** / turbojpeg **0.4.0** (≈ 3.1.x) | confirm exact tag that yields these SONAMEs |
| **OpenCV** (core + imgproc only) | **4.12.0** | git tag `4.12.0`, minimal build (no highgui/dnn/etc.) |

Layout mirrors mac: built `.so` bundled next to the addon in `build/linux_x64/`, addon linked with `RPATH=$ORIGIN` so it loads the bundled libs, not system ones.

## 4. Build strategy — "build each patch like db-cross-v4" + deps-prefix cache

Reconciles *build-from-source-every-patch* with the reality that OpenCV+libjxl from source is 20–40 min.

- **Addon `jxl.node`**: built **every patch** from `nativelibs/zjxl/src/*.cc` via `nativelibs/builder.js` (`node-gyp rebuild --target=<electron> --napi_build_version=6 --arch=x64`). Seconds. Same model as `db-cross-v4`.
- **Heavy third-party libs**: built from **pinned source** into a content-addressed cache `nativelibs/zjxl/.deps-prefix/<hash>/` where `<hash>` = hash of the pinned versions + build flags. First patch builds them once (slow); subsequent patches reuse the cached prefix and only rebuild the addon. Changing a pinned version changes the hash → automatic rebuild. Nothing is checked in as an opaque prebuilt binary — everything is built from source.
- `.deps-prefix/` is **gitignored** (build artifact), like `app/`, `*.node`.

The addon `binding.gyp` points `include_dirs`/`libraries` at `.deps-prefix/<hash>/{include,lib}` and copies the resolved `.so` set into `build/linux_x64/` in a post-build step.

## 5. Recovering exact parameters (the crux of "byte-for-byte")

Disassemble the mac `jxl.node` (x86_64 Mach-O; C++ symbols intact) to extract the runtime constants that never appear as strings:

- `bitmapToJxl`: `JxlEncoderSetFrameDistance` argument (float), `JxlEncoderSetFrameLossless` bool, `JxlEncoderFrameSettingsSetOption` (option id + value, i.e. **effort**), basic-info bits (bit depth, alpha, num channels), color encoding (sRGB?).
- `jxlToJpeg`: default `libjpeg_quality` when caller omits it; turbojpeg subsampling/flags; pixel format requested from the decoder.
- `resizeJxl*`: OpenCV `INTER_*` flag; the re-encode distance/effort; `shouldResize` thresholds; `resizeJxlLimit` iteration/limit algorithm.
- `getJxlInfo`: exact output object keys/types.
- `jxlDecompressMulti`: input option keys, output element shape.

Tools: `objdump -d --no-show-raw-insn` / `llvm-objdump` / Ghidra (headless) on `build/darwin_x64/jxl.node`. Record every recovered constant in a **params table** committed alongside the source (`nativelibs/zjxl/RE-PARAMS.md`) so the C++ is auditable against the original.

**Honesty on limits:** the `.node` binary itself cannot be byte-identical (no Zalo source). "Bit-identical" is scoped to the **image bytes** each method outputs, and is only guaranteed where we (a) match library versions exactly and (b) recover parameters exactly. Where a parameter cannot be pinned down from disasm, the spec records the assumption and verification falls back to functional/peer-decodable checks.

## 6. Verification (oracle = real Zalo JXL + mac `.node`)

Layered, strongest-first:

1. **decode (`jxlToJpeg`) bit-identical** — build the exact libjxl 0.9.3 + libjpeg-turbo, decode real Zalo `.jxl` samples, compare output JPEG bytes against the mac binary's output. Mac binary is x86_64 Mach-O; run it under an emulation layer (`darling`) if feasible, else compare pixel buffers from libjxl 0.9.3 directly (decode is deterministic) and treat the turbojpeg re-encode as version-pinned-identical.
2. **encode (`bitmapToJxl`) round-trip** — same raw bitmap → Linux `bitmapToJxl` and (if runnable) mac `bitmapToJxl`; compare JXL bytes. If mac binary is not runnable, verify (a) recovered distance/effort match the disasm, and (b) the produced JXL is **decodable by a real peer** (send a test image, confirm the other device renders it).
3. **resize** — resize a real JXL both ways; compare bytes / pixel PSNR.
4. **smoke boot** — under XDG-isolated profile, open a chat containing JXL images → they render; send an image → peer receives it.

Real `.jxl` samples come from the user's Zalo media cache (provided) — never touch the live profile in-place; copy samples into the scratchpad.

## 7. Patch integration

`scripts/patches/patch-zjxl.js` (modeled on `patch-db-cross-v4.js`):

1. Ensure `.deps-prefix/<hash>/` exists (build heavy deps from pinned source if cache miss).
2. Build addon via `builder.js`.
3. Copy `jxl.node` + bundled `.so` set → `app/native/nativelibs/zjxl/build/linux_x64/`.
4. Splice the `linux` branch into `app/native/nativelibs/zjxl/index.js` (fail-loud if the `else { return { error: 'not support' } }` anchor drifts).
5. Post-conditions (fail-loud): `.node` is ELF + non-empty, `.so` set present, `RPATH=$ORIGIN`, `linux_x64` require present in `index.js`.

Register in `scripts/main.js` after `patch-v8-profiles`. Add `scripts/patches/__tests__/patch-zjxl.test.js` mirroring the linux-guards test (splice idempotency + require-does-not-throw where ABI allows).

## 8. `.deb` packaging & CI

- Bundled `.so` ship inside the app (no runtime system dependency on libjxl 0.9 / OpenCV 4.12).
- Statically link where practical to minimize the bundled `.so` count; otherwise bundle and set RPATH.
- **CI build-time deps** (GitHub Actions apt list): `build-essential cmake nasm ninja-build` (+ whatever OpenCV/libjxl configure needs). No new runtime `build.deb.depends` unless a residual system lib is unavoidable.

## 9. Out of scope (v1)

- ARM64 (x64 only, per project scope).
- Byte-identical `.node` binary (impossible without Zalo source — output-bytes fidelity only).
- Any method not present in the current `index.js` surface beyond keeping `jxlToJpegFromLocalPath` exported for parity.

## 10. Success criteria

- Fresh SETUP builds `jxl.node` + bundled libs; `index.js` loads the linux addon (no `{error:'not support'}`).
- Real Zalo JXL images render in chat; sending an image is decodable by a peer.
- `decodeToJpeg` output bytes match the mac reference on the sample set (or documented pixel-identical + version-pinned re-encode where the mac binary can't be run).
- Recovered params documented in `RE-PARAMS.md` and reflected in the C++.
- Smoke boot passes under XDG isolation; `.deb` builds and bundles the zjxl `.so` set.
