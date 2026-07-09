# zimage — Linux native RE (bit-identical output) — Design Spec

**Date:** 2026-07-08
**Status:** Draft (pending user spec review)
**Module:** `native/nativelibs/zimage` — image thumbnail / resize
**Goal:** Reimplement the macOS `zimage.node` N-API addon for Linux x64 so its **image output is bit-identical** to the original, by pinning the exact libvips release + codec-backend versions the mac bundle ships (built from source, statically linked into libvips like the mac dylib) and recovering the exact `thumbnail`/`thumbnailFs` parameters from the mac binary.

This follows the same methodology, build model, and tooling proven on **zjxl** (`docs/superpowers/specs/2026-07-07-zjxl-linux-re-design.md`).

---

## 1. Why this module

Zalo's renderer calls `zimage().Image.thumbnail(...)` / `resizeQA(...)` (via `utility-process-media.js`, e.g. its `resizeImage` helper) to produce **resized images / thumbnails** — for sending, previews, and storage. On Linux the module currently returns `{ error: NOT_SUPPORT }`, so these paths are dead. Unlike `zjxl` (whose display path Chromium preempts), `zimage.thumbnail` is invoked directly by the app's resize helper, so this module is more likely to be exercised in normal use. (A call-site reality check is the first RE step — §5 — to confirm before investing.)

## 2. What the original does (reverse-engineered from the mac binary)

`zimage.node` is a **node-addon-api (`Napi::`) N-API addon** wrapping the **libvips** C++ API (`vips::VImage`) — ABI-stable (one Linux build runs all Electron 22.x, like sqlite3/db-cross-v4/zjxl).

### 2.1 JS surface (`index.js`, must be preserved exactly)

`getLib()` requires the platform addon and returns `{ Image: { thumbnail, resizeQA } }`:

| JS method | native method | signature | notes |
|---|---|---|---|
| `thumbnail(buffer, width, height, format, quality)` | `thumbnail` | `thumbnail(buffer, width, height, format, quality, cb)` | buffer in → **buffer out** via callback |
| `resizeQA(inputPath, outputPath, width, height, quality, _, callback)` | `thumbnailFs` | `thumbnailFs(inputPath, outputPath, width, height, ..., cb)` | file path in → **writes file** at outputPath |

Native exports (from symbols): `thumbnail` (`ThumbnailAsyncWorker`, args `Buffer<char>, int, int, string, Function`) and `thumbnailFs` (`ThumbnailFsAsyncWorker`, args `string, string, int, int, Function`). Both async. **This surface is contractual** — do not rename.

### 2.2 Native pipeline

Both methods use libvips `VImage::thumbnail_image` / `thumbnail_buffer` (the smart shrink-on-load + high-quality reduce) then save to the requested format:
- `thumbnail`: `thumbnail_buffer(inputBuf, width, {height, ...options})` → `<format>save_buffer(...)` → return Buffer.
- `thumbnailFs`: `thumbnail(inputPath, width, {height, ...})` → `<format>save(outputPath, ...)`.
- The exact `VOption` set (target height, `size`/`crop`/`no_rotate`, `linear`, `intent`) and the save params (`Q`=quality, `strip`, subsampling, effort) are **runtime constants recovered by disassembly** (§5) — they drive byte-identical output.

## 3. Exact dependency versions to pin (match the mac libvips build)

Bit-identical output requires building the **same libvips release + the same codec backends, statically linked into libvips**, exactly as the mac ships (its `libvips-cpp.42.dylib` links only macOS frameworks + libiconv/libresolv — every codec is static inside it).

| Component | Pinned version | Notes |
|---|---|---|
| **libvips** | **8.14.2** (SONAME `libvips-cpp.42`, current 59.2.0) | verify SONAME/version at build; adjust if 8.14.x point differs |
| **glib + gobject + gio** | (libvips 8.14.2's required GLib) | mandatory GObject base; **static** into libvips |
| **expat** | pinned | GLib/vips XML |
| **libjpeg-turbo** | pinned (determine exact release) | jpeg load/save |
| **libpng** | **1.6.39** (embedded string) | png load/save |
| **libspng**, **zlib** | pinned | png fast path + deflate |
| **libwebp** | pinned | webp load/save |
| **libjxl** | pinned (determine — may differ from zjxl's 0.9.3) | **JXL** load/save inside libvips |
| **libheif** (+ libde265, x265, aom, dav1d) | pinned | heif/avif load/save |
| **giflib** | pinned | gif load/save |
| **ImageMagick** (`magickload`) + its deps | pinned | magick load/save (fallback loader) |
| **poppler-glib** (or pdfium) + cairo | pinned | pdf load (`pdfload`) |

All built from source into a content-addressed cache `nativelibs/zimage/.deps-prefix/<hash>/`, **statically linked into a single `libvips-cpp.so.42`** (mirror mac). The addon links that one `.so`; the bundle set is minimal (ideally just `libvips-cpp.so.42` + any truly-unavoidable shared dep), `RPATH=$ORIGIN`.

### 3.1 Backend scope decision — **FULL parity with mac**

The mac libvips is full-featured. Confirmed loaders/savers in `libvips-cpp.42.dylib`: **jpeg, png, webp, jxl, gif, heif, magick, pdf, dz** (deepzoom). **Decision (per user): build the FULL backend set exactly matching mac** — including the heavy ones (`libheif`+codecs, `ImageMagick`, `poppler`/PDF). This maximizes parity and covers every input Zalo could feed.

**Cost/risk acknowledged:** this is a large, fragile dependency tree — `libheif` pulls `libde265`/`x265`/`aom`/`dav1d`; `ImageMagick` pulls delegates (freetype, fontconfig, lcms2, …); PDF pulls `poppler`+`cairo`+`glib`. Building all of these from source, statically, byte-identically is a multi-hour, many-moving-parts effort. The plan **stages the backend builds** (core+glib → common codecs → heavy codecs → magick/pdf) so each stage is independently buildable and the addon can be smoke-tested against the common formats before the heaviest backends land. If a specific heavy backend proves impractical to build byte-identically, that is escalated as a per-backend decision — the default target is full parity.

## 4. Build strategy — same as zjxl

- **Addon `zimage.node`**: built **every SETUP** from `nativelibs/zimage/src/*.cc` via `nativelibs/builder.js` (fast). Splice reused from the zjxl pattern.
- **libvips + backends**: built from **pinned source** into `nativelibs/zimage/.deps-prefix/<hash>/` (own `deps-hash.js`/`build-deps.sh`, mirroring zjxl). First build is long (glib + libvips + codecs); cached thereafter; a version/flag change (new `<hash>`) rebuilds. `.deps-prefix/`, `deps-src/` gitignored.
- **Static-link maximally**: build each codec + glib as **static** and link them into `libvips-cpp.so.42`, so the bundled `.so` set is minimal (mirror the mac single-dylib footprint). Any dep that cannot be static (rare) is bundled with `RPATH=$ORIGIN`.
- `patch-zimage.js` bundles the resulting `.so` closure (computed dynamically like `patch-zjxl.js`), sets `RPATH=$ORIGIN`, splices the `linux` branch into `app/native/nativelibs/zimage/index.js`.

## 5. Recovering exact parameters + call-site check (the crux)

**Step 0 — call-site reality check (do FIRST, before heavy work):** confirm the renderer actually reaches `zimage.thumbnail`/`resizeQA` in normal use (grep `utility-process-media.js` `resizeImage`, and check whether a Chromium/canvas path preempts it as with zjxl). If it is preempted everywhere, reassess scope before building libvips.

**RE (disassemble `app/native/nativelibs/zimage/darwin_x64/zimage.node`, C++ symbols intact):**
- `thumbnail` / `ThumbnailAsyncWorker::Execute` @…: the `VImage::thumbnail_buffer` VOption set — `height`, `size` (`VIPS_SIZE_*`), `crop`, `no_rotate`/`auto_rotate`, `linear`, `intent`, and the output branch per `format` (jpeg/webp/png/…) with its save VOptions (`Q`, `strip`, `optimize_coding`, `subsample_mode`, webp `effort`/`lossless`, etc.).
- `thumbnailFs` / `ThumbnailFsAsyncWorker::Execute`: same, file-based; recover the outputPath format inference and save params.
- Determine the codec versions **libvips 8.14.2 was actually built against** on mac (libpng 1.6.39 confirmed; recover libjpeg-turbo/libwebp/libjxl versions from the dylib strings) and pin those.

Record every constant in `nativelibs/zimage/src/re_params.h` + `nativelibs/zimage/RE-PARAMS.md`, each traced to a binary address + disassembly (per-value confidence `certain`/`assumed`), exactly like zjxl.

## 6. Verification (oracle = real images + mac `.node`)

1. **thumbnail bit-identical** — build the pinned libvips + backends; thumbnail real Zalo images (JXL/JPEG from `scratchpad/` copies) at the RE'd params; compare output bytes against the mac binary's output where runnable, else against libvips 8.14.2's own `vipsthumbnail` CLI (same source → same pixels/encode) with the recovered params.
2. **resizeQA (thumbnailFs)** — file→file round-trip; compare output file bytes.
3. **format coverage** — verify each format Zalo requests (jpeg/webp/…) round-trips and matches.
4. **smoke boot** — XDG-isolated; exercise `zimage().Image.thumbnail(...)` through the app barrel on a real image (like the zjxl barrel test), assert non-empty valid output; if a UI action reaches it, confirm live.

Samples copied read-only to `scratchpad/` (gitignored); never touch the live profile.

## 7. Patch integration

`scripts/patches/patch-zimage.js` (modeled on `patch-zjxl.js`): ensure deps-prefix → build addon → bundle `.so` closure + `RPATH=$ORIGIN` into `app/native/nativelibs/zimage/build/linux_x64/` → splice `index.js` `else { ... NOT_SUPPORT }` → linux branch (fail-loud on drift, idempotent) → post-conditions. Register in `scripts/main.js` after `patch-zjxl`. Add `scripts/patches/__tests__/patch-zimage.test.js`.

## 8. `.deb` packaging & CI

- Bundled `.so` (ideally just `libvips-cpp.so.42` + residuals) ship in the app; `RPATH=$ORIGIN`; no system libvips dependency.
- CI build-time deps: the zjxl set (`cmake nasm ninja-build patchelf git curl`) **plus** libvips/glib toolchain: **`meson`** (currently MISSING locally — install via apt/pip), `pkg-config`, `glib-compile-resources`, and whatever the heavy backends need (autotools for ImageMagick, etc.). glib and the codecs are built from source into the deps-prefix. Determine the full build-tool set during Task 1; add to `.github/workflows/build.yml`.
- Update `nativelibs/expected-versions.json` baseline once zimage's Linux build lands (the tracker already records mac `libvips 59.2.0`).

## 9. Out of scope (v1)

- ARM64 (x64 only).
- Byte-identical `.node` binary (output-bytes fidelity only).
- Any method beyond `thumbnail` + `thumbnailFs`.
- (Full backend parity is IN scope per §3.1 — jpeg/png/webp/jxl/gif/heif/magick/pdf/dz.)

## 10. Success criteria

- Fresh SETUP builds `zimage.node` + statically-linked `libvips-cpp.so.42`; `index.js` loads the linux addon (no `NOT_SUPPORT`).
- `thumbnail`/`resizeQA` produce valid resized images for Zalo's formats; output bytes match the mac reference (or documented pixel-identical + version-pinned encode where the mac binary can't be run) on the sample set.
- Recovered params documented in `RE-PARAMS.md` and reflected in the C++.
- Bundled `.so` footprint is minimal (static-linked, mirroring mac's single-dylib layout).
- Barrel test (`nativelibs.zimage().Image.thumbnail(...)`) works self-contained (no `LD_LIBRARY_PATH`); smoke boot passes; `.deb` bundles the zimage `.so` set.
