# zimage — Linux Native RE (bit-identical, full libvips parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement the macOS `zimage.node` image-thumbnail addon for Linux x64 as an N-API (node-addon-api) module whose output is bit-identical to the original, by building the exact libvips release + the FULL mac backend set from pinned source (statically linked into one `libvips-cpp.so.42`) and recovering the exact `thumbnail`/`thumbnailFs` parameters from the mac binary.

**Architecture:** A C++ node-addon-api addon (`nativelibs/zimage/`) exposing `thumbnail` (buffer→buffer) and `thumbnailFs` (file→file) via `vips::VImage`. libvips 8.14.2 + all its backends (jpeg/png/webp/jxl/gif/heif/magick/pdf) are built from pinned source into a content-addressed cache `nativelibs/zimage/.deps-prefix/<hash>/`, statically linked into `libvips-cpp.so.42`; the addon links that one `.so`, bundled next to `zimage.node` with `RPATH=$ORIGIN`. A `patch-zimage.js` (mirroring `patch-zjxl.js`) builds the addon every SETUP and splices a `linux` branch into the runtime `index.js`. Same build model, tooling, and review discipline as the completed **zjxl** module.

**Tech Stack:** C++17, node-addon-api, node-gyp (Electron 22.3.27), **libvips 8.14.2** (+ glib/gobject/gio, expat, zlib, libpng 1.6.39, libspng, libjpeg-turbo, libwebp, giflib, libjxl, libheif+libde265/x265/aom/dav1d, ImageMagick, poppler/cairo for PDF), **meson**/ninja/cmake/autotools, radare2 for RE, Node test scripts.

## Global Constraints

- **Electron target:** 22.3.27; addon built via `nativelibs/builder.js`. N-API → one build runs all Electron 22.x.
- **Platform:** x64 Linux only.
- **Pinned libvips:** **8.14.2** (must produce SONAME `libvips-cpp.so.42`, current 59.2.0 — verify at build). **libpng 1.6.39** (confirmed from mac strings). Other codec versions pinned to what the mac libvips was built against (recover from the mac dylib in Task 2; where unrecoverable, pin a sensible release and record it `assumed`).
- **FULL backend parity (per spec §3.1):** libvips built with jpeg, png, webp, jxl, gif, heif, magick, pdf, dz — matching mac. No backend dropped without escalation.
- **Static-link maximally:** every codec + glib built static and linked into a single `libvips-cpp.so.42` (mirror the mac single-dylib footprint). Minimal bundled `.so`.
- **Fidelity target:** bit-identical *image output* (not a byte-identical `.node`). Recovered params live in `nativelibs/zimage/src/re_params.h` (Task 2), the single source of truth for all thumbnail/save calls.
- **Build model:** addon rebuilt every SETUP (like zjxl); heavy deps built once into `.deps-prefix/<hash>/` and reused.
- **Patches fail-loud + idempotent:** splice throws on anchor drift; re-running is a no-op.
- **JS surface is contractual:** `thumbnail(buffer,width,height,format,quality)` and `resizeQA(inputPath,outputPath,width,height,quality,_,cb)` → native `thumbnail`/`thumbnailFs`; must not change.
- **Never touch the live Zalo profile:** verification uses copies under `scratchpad/` (gitignored); XDG-isolated smoke.
- **Attribution:** no `Co-Authored-By`, no "Generated with Claude"/emoji in any commit/file/doc.
- **C++ exceptions ENABLED** (libvips C++ `VError` throws; node-addon-api default exception mode). Do not define `NAPI_DISABLE_CPP_EXCEPTIONS`.

---

## File Structure

**Create (source, committed):**
- `nativelibs/zimage/package.json` — declares `node-addon-api`.
- `nativelibs/zimage/binding.gyp` — addon build config, links `.deps-prefix`.
- `nativelibs/zimage/scripts/deps-hash.js` — content hash + prefix path.
- `nativelibs/zimage/scripts/build-deps.sh` — builds glib + all codecs + libvips into `.deps-prefix/<hash>/`.
- `nativelibs/zimage/scripts/__tests__/deps-hash.test.js` — hash determinism test.
- `nativelibs/zimage/src/common.h` — arg helpers, status codes.
- `nativelibs/zimage/src/re_params.h` — recovered constants (Task 2).
- `nativelibs/zimage/src/zimage.cc` — N-API `Init` (vips_init), registers methods.
- `nativelibs/zimage/src/thumbnail.cc` — `thumbnail` (buffer→buffer).
- `nativelibs/zimage/src/thumbnail_fs.cc` — `thumbnailFs` (file→file).
- `nativelibs/zimage/RE-PARAMS.md` — RE notes (Task 2).
- `nativelibs/zimage/README.md` — attribution + build/use/update/rebuild.
- `scripts/patches/patch-zimage.js` — build + bundle `.so` + splice.
- `scripts/patches/__tests__/patch-zimage.test.js` — splice/idempotency test.

**Modify:**
- `scripts/main.js` — register `patch-zimage` after `patch-zjxl`.
- `.github/workflows/build.yml` — add build-time deps (meson + backend toolchains).
- `.gitignore` — ignore `nativelibs/zimage/.deps-prefix/` and `nativelibs/zimage/deps-src/`.

**Runtime (gitignored, produced each SETUP):**
- `app/native/nativelibs/zimage/build/linux_x64/zimage.node` + bundled `.so`.
- `app/native/nativelibs/zimage/index.js` — spliced with the `linux` branch.

---

## Task 1: Pinned deps build — glib + common codecs + libvips (jpeg/png/webp/gif)

Stage 1 of the dependency build: a **working static libvips-cpp.so.42** with the common codecs. The heavy backends (jxl/heif/magick/pdf) are added in Task 6 so the addon (Tasks 3–5) can be developed against a buildable libvips first.

**Files:**
- Create: `nativelibs/zimage/scripts/deps-hash.js`, `nativelibs/zimage/scripts/build-deps.sh`, `nativelibs/zimage/scripts/__tests__/deps-hash.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `node scripts/deps-hash.js` prints `nativelibs/zimage/.deps-prefix/<hash>`; `bash scripts/build-deps.sh` populates `<prefix>/{include,lib,bin}` with a static-linked `libvips-cpp.so.42` (+ `vips` CLI) supporting jpeg/png/webp/gif, and writes `<prefix>/.done`. Later tasks read `<prefix>/include` and `<prefix>/lib`.

- [ ] **Step 1: Write the failing test**

Create `nativelibs/zimage/scripts/__tests__/deps-hash.test.js`:
```js
const cp = require('child_process'), path = require('path'), assert = require('assert');
const out = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert(/\.deps-prefix[/\\][0-9a-f]{12}$/.test(out), 'prefix path shape: ' + out);
assert.strictEqual(out, cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim(), 'deterministic');
console.log('OK deps-hash');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node nativelibs/zimage/scripts/__tests__/deps-hash.test.js`
Expected: FAIL — `Cannot find module '../deps-hash.js'`.

- [ ] **Step 3: Write `deps-hash.js`**

```js
// Content-addressed deps prefix for zimage's libvips stack. The hash pins the
// exact upstream versions + build flags so a version/backend change invalidates
// the cache. CLI-only stdout (require must not pollute stdout).
const crypto = require('crypto');
const path = require('path');

const PINS = {
  libvips: '8.14.2',
  glib: '2.78.4',
  expat: '2.6.0',
  zlib: '1.3.1',
  libpng: '1.6.39',
  libspng: '0.7.4',
  libjpeg_turbo: '3.0.2',
  libwebp: '1.3.2',
  giflib: '5.2.1',
  // heavy backends added in Task 6 (jxl/heif/magick/pdf); listed here so enabling
  // them changes the hash:
  backends: 'jpeg+png+spng+webp+gif',   // Task 6 flips to full set
  flags: 'x64-relwithdebinfo-static-codecs-shared-vipscpp',
  abi: 1,
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
if (require.main === module) process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node nativelibs/zimage/scripts/__tests__/deps-hash.test.js`
Expected: `OK deps-hash`.

- [ ] **Step 5: Write `build-deps.sh` (stage-1 codecs + libvips)**

```bash
#!/usr/bin/env bash
# Builds glib + the common image codecs (static) and libvips 8.14.2 (shared
# libvips-cpp.so.42, codecs statically linked in) into a content-addressed prefix.
# Idempotent: exits early if <prefix>/.done exists. Everything from source.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # nativelibs/zimage
PREFIX="$(node "$HERE/scripts/deps-hash.js")"
SRC="$HERE/deps-src"
JOBS="$(nproc)"

if [ -f "$PREFIX/.done" ]; then echo "deps-prefix cache hit: $PREFIX"; exit 0; fi

for tool in meson ninja cmake pkg-config git curl nasm; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$PREFIX" "$SRC"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CMAKE_PREFIX_PATH="$PREFIX"
export PATH="$PREFIX/bin:$PATH"
CM=(-G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX="$PREFIX"
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF)   # static codecs

clone() { local repo="$1" tag="$2" dir="$3"; [ -d "$SRC/$dir" ] || git clone --depth 1 --branch "$tag" "$repo" "$SRC/$dir"; }
dl() { local url="$1" tar="$2" dir="$3"; [ -d "$SRC/$dir" ] || { curl -fsSL "$url" -o "$SRC/$tar"; tar -C "$SRC" -xf "$SRC/$tar"; }; }

# ---- zlib (static) ----
clone https://github.com/madler/zlib v1.3.1 zlib
cmake -S "$SRC/zlib" -B "$SRC/zlib/b" "${CM[@]}"; cmake --build "$SRC/zlib/b" -j"$JOBS"; cmake --install "$SRC/zlib/b"

# ---- libpng 1.6.39 (static) ----
clone https://github.com/glennrp/libpng v1.6.39 libpng
cmake -S "$SRC/libpng" -B "$SRC/libpng/b" "${CM[@]}" -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DZLIB_ROOT="$PREFIX"
cmake --build "$SRC/libpng/b" -j"$JOBS"; cmake --install "$SRC/libpng/b"

# ---- libspng (static) ----
clone https://github.com/randy408/libspng v0.7.4 libspng
cmake -S "$SRC/libspng" -B "$SRC/libspng/b" "${CM[@]}" -DSPNG_SHARED=OFF -DBUILD_EXAMPLES=OFF
cmake --build "$SRC/libspng/b" -j"$JOBS"; cmake --install "$SRC/libspng/b"

# ---- libjpeg-turbo (static) ----
clone https://github.com/libjpeg-turbo/libjpeg-turbo 3.0.2 ljt
cmake -S "$SRC/ljt" -B "$SRC/ljt/b" "${CM[@]}" -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_TURBOJPEG=ON
cmake --build "$SRC/ljt/b" -j"$JOBS"; cmake --install "$SRC/ljt/b"

# ---- libwebp (static) ----
clone https://github.com/webmproject/libwebp v1.3.2 webp
cmake -S "$SRC/webp" -B "$SRC/webp/b" "${CM[@]}" -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
  -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
  -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=ON -DWEBP_BUILD_EXTRAS=OFF
cmake --build "$SRC/webp/b" -j"$JOBS"; cmake --install "$SRC/webp/b"

# ---- giflib (static; Makefile-based) ----
dl https://downloads.sourceforge.net/project/giflib/giflib-5.2.1.tar.gz giflib-5.2.1.tar.gz giflib-5.2.1
make -C "$SRC/giflib-5.2.1" libgif.a
install -Dm644 "$SRC/giflib-5.2.1/libgif.a" "$PREFIX/lib/libgif.a"
install -Dm644 "$SRC/giflib-5.2.1/gif_lib.h" "$PREFIX/include/gif_lib.h"

# ---- expat (static) ----
clone https://github.com/libexpat/libexpat R_2_6_0 expat
cmake -S "$SRC/expat/expat" -B "$SRC/expat/b" "${CM[@]}" -DEXPAT_SHARED_LIBS=OFF -DEXPAT_BUILD_TESTS=OFF \
  -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TOOLS=OFF
cmake --build "$SRC/expat/b" -j"$JOBS"; cmake --install "$SRC/expat/b"

# ---- glib (meson, static) ----
clone https://gitlab.gnome.org/GNOME/glib.git 2.78.4 glib
meson setup "$SRC/glib/b" "$SRC/glib" --prefix="$PREFIX" --buildtype=release --default-library=static \
  -Dtests=false -Dnls=disabled -Dlibmount=disabled -Dselinux=disabled || meson setup --reconfigure "$SRC/glib/b" "$SRC/glib" --prefix="$PREFIX" --default-library=static
ninja -C "$SRC/glib/b" -j"$JOBS"; ninja -C "$SRC/glib/b" install

# ---- libvips 8.14.2 (meson; shared libvips-cpp, codecs static) ----
clone https://github.com/libvips/libvips v8.14.2 libvips
meson setup "$SRC/libvips/b" "$SRC/libvips" --prefix="$PREFIX" --buildtype=release \
  --default-library=shared -Ddeprecated=false -Dexamples=false -Dcplusplus=enabled \
  -Djpeg=enabled -Dpng=enabled -Dspng=enabled -Dwebp=enabled -Dgif=enabled \
  -Djpeg-xl=disabled -Dheif=disabled -Dmagick=disabled -Dpdfium=disabled -Dpoppler=disabled \
  || meson setup --reconfigure "$SRC/libvips/b" "$SRC/libvips" --prefix="$PREFIX"
ninja -C "$SRC/libvips/b" -j"$JOBS"; ninja -C "$SRC/libvips/b" install

if [ -d "$PREFIX/lib64" ]; then cp -a "$PREFIX/lib64/." "$PREFIX/lib/"; fi
touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
```

- [ ] **Step 6: Build + verify (long — first run only)**

Run:
```bash
sudo apt-get install -y meson ninja-build cmake pkg-config nasm build-essential git curl
chmod +x nativelibs/zimage/scripts/build-deps.sh
bash nativelibs/zimage/scripts/build-deps.sh
PREFIX=$(node nativelibs/zimage/scripts/deps-hash.js)
readelf -d "$PREFIX/lib/libvips-cpp.so.42" | grep SONAME     # -> libvips-cpp.so.42
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/vips" --vips-version   # -> vips-8.14.2
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/vips" -l | grep -iE 'jpegload|pngload|webpload|gifload' | head
```
Expected: `libvips-cpp.so.42` exists, `vips-8.14.2`, and the jpeg/png/webp/gif loaders are listed. If the SONAME isn't `.42`, adjust the libvips tag to the 8.14.x point release that yields SONAME 42 and record it. If a codec's cmake/meson option name differs in these releases, fix the flag and note it (the loader-presence check is the source of truth).

- [ ] **Step 7: Ignore build artifacts**

Add to `.gitignore`:
```
# zimage libvips deps (built from pinned source into a content-addressed cache)
nativelibs/zimage/.deps-prefix/
nativelibs/zimage/deps-src/
```

- [ ] **Step 8: Commit**

```bash
git add nativelibs/zimage/scripts/ .gitignore
git commit -m "zimage: pinned deps build (glib + jpeg/png/webp/gif codecs) + libvips 8.14.2 static-linked"
```

---

## Task 2: Recover exact parameters from the mac binary → `re_params.h`

**Files:**
- Create: `nativelibs/zimage/src/re_params.h`, `nativelibs/zimage/RE-PARAMS.md`

**Interfaces:**
- Produces: `re_params.h` with `constexpr` constants consumed by Tasks 4–5: the `VImage::thumbnail`/`thumbnail_buffer` VOption set (`kThumbSize` [VIPS_SIZE_*], `kThumbCrop`, `kThumbAutoRotate`, `kThumbLinear`, `kThumbIntent`) and per-format save params (`kJpegQ` default, `kJpegOptimizeCoding`, `kJpegSubsample`, `kJpegStrip`, `kWebpQ`, `kWebpEffort`, `kWebpLossless`, `kPngCompression`, `kPngStrip`, …), plus how the `quality`/`format` JS args map to save options. `RE-PARAMS.md` documents each with binary address + disassembly + confidence.

- [ ] **Step 1: Do the call-site reality check FIRST (spec §5 Step 0)**

Run:
```bash
grep -oE '.{40}zimage\(\).{0,80}' app/main-dist/utility-process-media.js | head
grep -oE '.{30}(thumbnail|resizeQA)[^;]{0,60}(canvas|createImageBitmap)' app/pc-dist/compact-app-pc.*.js | head
```
Confirm `zimage().Image.thumbnail`/`resizeQA` is reachable and note whether a Chromium/canvas path preempts it. Record the finding in `RE-PARAMS.md` (§ "call-site check"). If it is fully preempted, STOP and escalate before building the heavy backends.

- [ ] **Step 2: Disassemble the thumbnail workers**

Run (analysis may need `af` at the address first):
```bash
BIN=app/native/nativelibs/zimage/darwin_x64/zimage.node
r2 -q -c 'aaa; s sym._ZN20ThumbnailAsyncWorker7ExecuteEv; af; pdf' "$BIN" 2>/dev/null \
  | grep -iE 'thumbnail_buffer|save_buffer|vips_|set|str\.|mov .*0x|call'
r2 -q -c 'aaa; s sym._ZN22ThumbnailFsAsyncWorker7ExecuteEv; af; pdf' "$BIN" 2>/dev/null \
  | grep -iE 'thumbnail|save|vips_|set|str\.|call'
```
Recover: the `thumbnail_buffer(buf,len,width, VOption)` options set (height, `size`, `crop`, `no_rotate`/auto-rotate, `linear`, `intent`), the output-format dispatch (how `format` selects `jpegsave_buffer`/`webpsave_buffer`/`pngsave_buffer`/…), and each saver's VOptions (`Q`, `strip`, `optimize_coding`, `subsample_mode`, webp `effort`/`lossless`, png `compression`/`palette`). Also recover the codec versions the mac libvips embeds (grep the dylib) to confirm/adjust the Task 1/6 pins.

- [ ] **Step 3: Cross-check against a real image**

Run (pinned vips from Task 1):
```bash
PREFIX=$(node nativelibs/zimage/scripts/deps-hash.js)
S=scratchpad/img-samples/<a-real-jpeg-or-png>   # copy a real image first
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/vipsthumbnail" "$S" --size 256 -o /tmp/vt.jpg
```
Confirm the recovered thumbnail semantics (fit/crop, target dims) are plausible against the CLI behavior; note any deviation.

- [ ] **Step 4: Write `re_params.h`**

Fill each constant with the recovered value (replace the illustrative values below with the real ones; keep the citing comment):
```cpp
#pragma once
// Constants reverse-engineered from app/native/nativelibs/zimage/darwin_x64/zimage.node
// (bundle 26.6.11). Each value's derivation is in RE-PARAMS.md (binary address + disasm).
// Single source of truth for bit-identical thumbnail output.
namespace zimage_re {
// --- VImage::thumbnail(_buffer) options ---
constexpr int   kThumbSize        = /*RE*/ 2;      // VIPS_SIZE_DOWN (only shrink)
constexpr bool  kThumbCrop        = /*RE*/ false;  // VIPS_INTERESTING_NONE
constexpr bool  kThumbAutoRotate  = /*RE*/ true;
constexpr bool  kThumbLinear      = /*RE*/ false;
constexpr int   kThumbIntent      = /*RE*/ 2;      // VIPS_INTENT_RELATIVE
// --- save params (per format) ---
constexpr int   kJpegQ            = /*RE*/ 80;     // Q when caller omits quality
constexpr bool  kJpegOptimize     = /*RE*/ true;
constexpr int   kJpegSubsample    = /*RE*/ 0;      // VIPS_FOREIGN_SUBSAMPLE_AUTO
constexpr bool  kStripMetadata    = /*RE*/ true;
constexpr int   kWebpQ            = /*RE*/ 80;
constexpr int   kWebpEffort       = /*RE*/ 4;
constexpr bool  kWebpLossless     = /*RE*/ false;
constexpr int   kPngCompression   = /*RE*/ 6;
}  // namespace zimage_re
```

- [ ] **Step 5: Write `RE-PARAMS.md`**

Per constant: the mac binary address, the `r2 pdf` snippet, the value, and a confidence note (`certain`/`assumed`). Include the call-site finding (Step 1) and the recovered mac codec versions.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zimage/src/re_params.h nativelibs/zimage/RE-PARAMS.md
git commit -m "zimage: recover thumbnail/thumbnailFs params from mac binary (re_params.h + RE-PARAMS.md)"
```

---

## Task 3: Addon scaffold + `vips_init` + `moduleReady`

**Files:**
- Create: `nativelibs/zimage/package.json`, `binding.gyp`, `src/common.h`, `src/zimage.cc`, `src/thumbnail.cc`, `src/thumbnail_fs.cc`, `README.md`
- Test: `nativelibs/zimage/__tests__/moduleReady.test.js`

**Interfaces:**
- Consumes: `.deps-prefix/<hash>` (Task 1); `re_params.h` (Task 2).
- Produces: `build/Release/zimage.node` exporting `moduleReady()` → `true`, with `vips_init` called in `Init`. `zimage.cc` registers `RegisterThumbnail`/`RegisterThumbnailFs` (empty stubs now, filled in Tasks 4–5).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "zimage-native",
  "version": "1.0.0",
  "private": true,
  "description": "Linux native image thumbnail addon (RE of Zalo zimage.node)",
  "dependencies": { "node-addon-api": "^5.1.0" }
}
```

- [ ] **Step 2: Write `binding.gyp`**

```python
{
  "targets": [{
    "target_name": "zimage",
    "sources": ["src/zimage.cc", "src/thumbnail.cc", "src/thumbnail_fs.cc"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include/glib-2.0')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib/glib-2.0/include')\")"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
    "libraries": [
      "<!(node -e \"process.stdout.write('-L'+require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib')\")",
      "-lvips-cpp", "-lvips", "-lgobject-2.0", "-lglib-2.0",
      "-Wl,-rpath,'$$ORIGIN'"
    ]
  }]
}
```
(If `pkg-config --libs vips-cpp` from the prefix lists more `-l`, add them; the prefix's `.pc` files are the source of truth for the exact link line.)

- [ ] **Step 3: Write `src/common.h`**

```cpp
#pragma once
#include <napi.h>
#include <string>
#include <vector>
namespace zimage {
enum StatusCode { OK = 0, ERR_INPUT = 1, ERR_VIPS = 2 };
inline std::string GetString(const Napi::Value& v) {
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
}
}  // namespace zimage
```

- [ ] **Step 4: Write `src/zimage.cc`**

```cpp
#include <napi.h>
#include <vips/vips8>
#include "common.h"

namespace zimage {
void RegisterThumbnail(Napi::Env, Napi::Object);
void RegisterThumbnailFs(Napi::Env, Napi::Object);
static Napi::Value ModuleReady(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
}  // namespace zimage

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  if (VIPS_INIT("zimage")) {
    Napi::Error::New(env, "vips_init failed").ThrowAsJavaScriptException();
    return exports;
  }
  exports.Set("moduleReady", Napi::Function::New(env, zimage::ModuleReady));
  zimage::RegisterThumbnail(env, exports);
  zimage::RegisterThumbnailFs(env, exports);
  return exports;
}
NODE_API_MODULE(zimage, Init)
```

- [ ] **Step 5: Add empty registrars**

`src/thumbnail.cc`:
```cpp
#include <napi.h>
#include "common.h"
namespace zimage { void RegisterThumbnail(Napi::Env, Napi::Object) {} }
```
`src/thumbnail_fs.cc`:
```cpp
#include <napi.h>
#include "common.h"
namespace zimage { void RegisterThumbnailFs(Napi::Env, Napi::Object) {} }
```

- [ ] **Step 6: Write the failing test**

`nativelibs/zimage/__tests__/moduleReady.test.js`:
```js
const path = require('path'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
assert.strictEqual(typeof addon.moduleReady, 'function', 'moduleReady exported');
assert.strictEqual(addon.moduleReady(), true, 'moduleReady() true');
console.log('OK moduleReady');
```

- [ ] **Step 7: Build + run**

Run:
```bash
bash nativelibs/zimage/scripts/build-deps.sh            # cache hit
node nativelibs/builder.js nativelibs/zimage
LD_LIBRARY_PATH="$(node nativelibs/zimage/scripts/deps-hash.js)/lib" \
  ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/moduleReady.test.js
```
Expected: `OK moduleReady` (proves the addon links libvips + loads under Electron ABI; `vips_init` succeeds). If the link fails, reconcile `binding.gyp` `libraries` against `pkg-config --static --libs vips-cpp` from the prefix.

- [ ] **Step 8: Write `README.md`** (attribution: reimplemented from the mac binary; pinned libvips 8.14.2 + full backend set; build/use/update/rebuild sections mirroring `nativelibs/zjxl/README.md`).

- [ ] **Step 9: Commit**

```bash
git add nativelibs/zimage/package.json nativelibs/zimage/binding.gyp nativelibs/zimage/src nativelibs/zimage/__tests__ nativelibs/zimage/README.md
git commit -m "zimage: addon scaffold + vips_init + moduleReady (links libvips, loads under Electron ABI)"
```

---

## Task 4: `thumbnail` (buffer → buffer)

**Files:**
- Modify: `nativelibs/zimage/src/thumbnail.cc`
- Test: `nativelibs/zimage/__tests__/thumbnail.test.js`

**Interfaces:**
- Consumes: `common.h`, `re_params.h`; libvips `vips/vips8`.
- Produces: `thumbnail(buffer, width, height, format, quality, cb)` → `cb(null, Buffer(out))`. Registered as `thumbnail`.

- [ ] **Step 1: Write the failing test**

```js
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'img-samples');
const f = path.join(dir, fs.readdirSync(dir).find(x => /\.(jpe?g|png)$/i.test(x)));
addon.thumbnail(fs.readFileSync(f), 128, 128, 'jpg', 80, (err, data) => {
  assert.ifError(err);
  assert(Buffer.isBuffer(data) && data.length > 2, 'buffer out');
  assert.strictEqual(data[0], 0xFF); assert.strictEqual(data[1], 0xD8, 'JPEG SOI');
  fs.writeFileSync('/tmp/zimage-thumb.jpg', data);
  console.log('OK thumbnail', data.length, 'bytes');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `LD_LIBRARY_PATH="$(node nativelibs/zimage/scripts/deps-hash.js)/lib" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/thumbnail.test.js`
Expected: FAIL — `thumbnail is not a function`.

- [ ] **Step 3: Implement `thumbnail` in `src/thumbnail.cc`**

```cpp
#include <napi.h>
#include <vips/vips8>
#include <cstring>
#include "common.h"
#include "re_params.h"

using vips::VImage;
using vips::VOption;
using vips::VError;

namespace zimage {

// Apply the RE'd thumbnail options and save to `format` with the RE'd save params.
// Returns the encoded bytes. Throws vips::VError on failure.
static std::vector<uint8_t> DoThumbnail(const uint8_t* in, size_t inLen,
                                        int width, int height,
                                        const std::string& format, int quality) {
  VOption* topt = VImage::option()
      ->set("height", height > 0 ? height : width)
      ->set("size", static_cast<VipsSize>(zimage_re::kThumbSize))
      ->set("no_rotate", !zimage_re::kThumbAutoRotate)
      ->set("linear", zimage_re::kThumbLinear)
      ->set("intent", static_cast<VipsIntent>(zimage_re::kThumbIntent));
  VImage img = VImage::thumbnail_buffer(const_cast<uint8_t*>(in), inLen, width, topt);

  void* buf = nullptr; size_t len = 0;
  const std::string f = format;
  if (f == "jpg" || f == "jpeg") {
    img.jpegsave_buffer(&buf, &len, VImage::option()
        ->set("Q", quality > 0 ? quality : zimage_re::kJpegQ)
        ->set("optimize_coding", zimage_re::kJpegOptimize)
        ->set("subsample_mode", static_cast<VipsForeignSubsample>(zimage_re::kJpegSubsample))
        ->set("strip", zimage_re::kStripMetadata));
  } else if (f == "webp") {
    img.webpsave_buffer(&buf, &len, VImage::option()
        ->set("Q", quality > 0 ? quality : zimage_re::kWebpQ)
        ->set("effort", zimage_re::kWebpEffort)
        ->set("lossless", zimage_re::kWebpLossless)
        ->set("strip", zimage_re::kStripMetadata));
  } else if (f == "png") {
    img.pngsave_buffer(&buf, &len, VImage::option()
        ->set("compression", zimage_re::kPngCompression)
        ->set("strip", zimage_re::kStripMetadata));
  } else {
    throw VError("zimage: unsupported format '" + f + "'");
  }
  std::vector<uint8_t> out(static_cast<uint8_t*>(buf), static_cast<uint8_t*>(buf) + len);
  g_free(buf);
  return out;
}

class ThumbWorker : public Napi::AsyncWorker {
 public:
  ThumbWorker(Napi::Function cb, std::vector<uint8_t> in, int w, int h, std::string fmt, int q)
      : Napi::AsyncWorker(cb), in_(std::move(in)), w_(w), h_(h), fmt_(std::move(fmt)), q_(q) {}
  void Execute() override {
    try { out_ = DoThumbnail(in_.data(), in_.size(), w_, h_, fmt_, q_); }
    catch (const VError& e) { SetError(std::string("thumbnail: ") + e.what()); }
    catch (const std::exception& e) { SetError(std::string("thumbnail: ") + e.what()); }
  }
  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(), Napi::Buffer<uint8_t>::Copy(env, out_.data(), out_.size())});
  }
  void OnError(const Napi::Error& e) override {
    Callback().Call({e.Value(), Env().Null()});
  }
 private:
  std::vector<uint8_t> in_, out_; int w_, h_; std::string fmt_; int q_;
};

static Napi::Value Thumbnail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int w = info[1].As<Napi::Number>().Int32Value();
  int h = info[2].As<Napi::Number>().Int32Value();
  std::string fmt = GetString(info[3]);
  int q = info[4].IsNumber() ? info[4].As<Napi::Number>().Int32Value() : 0;
  Napi::Function cb = info[5].As<Napi::Function>();
  std::vector<uint8_t> in(buf.Data(), buf.Data() + buf.Length());
  (new ThumbWorker(cb, std::move(in), w, h, fmt, q))->Queue();
  return env.Undefined();
}

void RegisterThumbnail(Napi::Env env, Napi::Object exports) {
  exports.Set("thumbnail", Napi::Function::New(env, Thumbnail));
}
}  // namespace zimage
```

- [ ] **Step 4: Rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zimage && LD_LIBRARY_PATH="$(node nativelibs/zimage/scripts/deps-hash.js)/lib" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/thumbnail.test.js`
Expected: `OK thumbnail <N> bytes`; `/tmp/zimage-thumb.jpg` opens as a valid resized image.

- [ ] **Step 5: Reconcile with RE-PARAMS.md**

If Task 2 recovered a different option set (e.g. `crop` used, different `size` mode, extra save options, or a different `format`→saver mapping incl. webp/png/gif), update `DoThumbnail` to match exactly and extend the test to the formats Zalo actually requests. Bit-identical check: compare `/tmp/zimage-thumb.jpg` against the mac binary's output for the same input+params (or `vipsthumbnail` from the pinned prefix with the RE'd options).

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zimage/src/thumbnail.cc nativelibs/zimage/__tests__/thumbnail.test.js
git commit -m "zimage: thumbnail (libvips thumbnail_buffer -> RE'd save params)"
```

---

## Task 5: `thumbnailFs` (file → file)

**Files:**
- Modify: `nativelibs/zimage/src/thumbnail_fs.cc`
- Test: `nativelibs/zimage/__tests__/thumbnailFs.test.js`

**Interfaces:**
- Consumes: `common.h`, `re_params.h`; libvips.
- Produces: `thumbnailFs(inputPath, outputPath, width, height, quality, cb)` → writes `outputPath`, `cb(null)`. Registered as `thumbnailFs`. (The JS `resizeQA(inputPath, outputPath, width, height, quality, _, callback)` forwards to this — confirm the arg order/positions against the RE'd native signature and match exactly.)

- [ ] **Step 1: Write the failing test**

```js
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'img-samples');
const f = path.join(dir, fs.readdirSync(dir).find(x => /\.(jpe?g|png)$/i.test(x)));
const out = '/tmp/zimage-fs-out.jpg';
addon.thumbnailFs(f, out, 200, 200, 80, (err) => {
  assert.ifError(err);
  const b = fs.readFileSync(out);
  assert(b.length > 2 && b[0] === 0xFF && b[1] === 0xD8, 'valid jpeg written');
  console.log('OK thumbnailFs', b.length, 'bytes');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `LD_LIBRARY_PATH="$(node nativelibs/zimage/scripts/deps-hash.js)/lib" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/thumbnailFs.test.js`
Expected: FAIL — `thumbnailFs is not a function`.

- [ ] **Step 3: Implement `thumbnailFs` in `src/thumbnail_fs.cc`**

```cpp
#include <napi.h>
#include <vips/vips8>
#include "common.h"
#include "re_params.h"

using vips::VImage;
using vips::VError;

namespace zimage {

// Determine the saver from the output path extension (matches the mac thumbnailFs,
// which infers format from outputPath). Applies the RE'd save params.
static void DoThumbnailFs(const std::string& inPath, const std::string& outPath,
                          int width, int height, int quality) {
  VImage img = VImage::thumbnail(inPath.c_str(), width, VImage::option()
      ->set("height", height > 0 ? height : width)
      ->set("size", static_cast<VipsSize>(zimage_re::kThumbSize))
      ->set("no_rotate", !zimage_re::kThumbAutoRotate)
      ->set("linear", zimage_re::kThumbLinear)
      ->set("intent", static_cast<VipsIntent>(zimage_re::kThumbIntent)));
  auto ends = [&](const char* s){ size_t n = strlen(s); return outPath.size() >= n && outPath.compare(outPath.size()-n, n, s) == 0; };
  if (ends(".webp")) {
    img.webpsave(outPath.c_str(), VImage::option()->set("Q", quality > 0 ? quality : zimage_re::kWebpQ)
        ->set("effort", zimage_re::kWebpEffort)->set("lossless", zimage_re::kWebpLossless)->set("strip", zimage_re::kStripMetadata));
  } else if (ends(".png")) {
    img.pngsave(outPath.c_str(), VImage::option()->set("compression", zimage_re::kPngCompression)->set("strip", zimage_re::kStripMetadata));
  } else { // default jpeg
    img.jpegsave(outPath.c_str(), VImage::option()->set("Q", quality > 0 ? quality : zimage_re::kJpegQ)
        ->set("optimize_coding", zimage_re::kJpegOptimize)
        ->set("subsample_mode", static_cast<VipsForeignSubsample>(zimage_re::kJpegSubsample))->set("strip", zimage_re::kStripMetadata));
  }
}

class ThumbFsWorker : public Napi::AsyncWorker {
 public:
  ThumbFsWorker(Napi::Function cb, std::string in, std::string out, int w, int h, int q)
      : Napi::AsyncWorker(cb), in_(std::move(in)), out_(std::move(out)), w_(w), h_(h), q_(q) {}
  void Execute() override {
    try { DoThumbnailFs(in_, out_, w_, h_, q_); }
    catch (const VError& e) { SetError(std::string("thumbnailFs: ") + e.what()); }
    catch (const std::exception& e) { SetError(std::string("thumbnailFs: ") + e.what()); }
  }
  void OnOK() override { Callback().Call({Env().Null()}); }
  void OnError(const Napi::Error& e) override { Callback().Call({e.Value()}); }
 private:
  std::string in_, out_; int w_, h_, q_;
};

static Napi::Value ThumbnailFs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string in = GetString(info[0]);
  std::string out = GetString(info[1]);
  int w = info[2].As<Napi::Number>().Int32Value();
  int h = info[3].As<Napi::Number>().Int32Value();
  int q = info[4].IsNumber() ? info[4].As<Napi::Number>().Int32Value() : 0;
  Napi::Function cb = info[info.Length() - 1].As<Napi::Function>();
  (new ThumbFsWorker(cb, std::move(in), std::move(out), w, h, q))->Queue();
  return env.Undefined();
}

void RegisterThumbnailFs(Napi::Env env, Napi::Object exports) {
  exports.Set("thumbnailFs", Napi::Function::New(env, ThumbnailFs));
}
}  // namespace zimage
```

- [ ] **Step 4: Rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zimage && LD_LIBRARY_PATH="$(node nativelibs/zimage/scripts/deps-hash.js)/lib" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/thumbnailFs.test.js`
Expected: `OK thumbnailFs <N> bytes`.

- [ ] **Step 5: Reconcile the native signature with RE + the JS wrapper**

The JS `resizeQA(inputPath, outputPath, width, height, quality, _, callback)` passes args to `zimage.thumbnailFs.apply(null, args)`. Confirm (from RE Task 2 + `index.js`) the exact native arg positions (there is a `_` placeholder before the callback) and that `ThumbnailFs` reads `width`/`height`/`quality` from the right indices and the callback from the last arg. Fix indices to match and re-test.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zimage/src/thumbnail_fs.cc nativelibs/zimage/__tests__/thumbnailFs.test.js
git commit -m "zimage: thumbnailFs (file->file, format from output extension)"
```

---

## Task 6: Full backend parity — add jxl / heif / magick / pdf to libvips

**Files:**
- Modify: `nativelibs/zimage/scripts/deps-hash.js` (PINS.backends → full), `nativelibs/zimage/scripts/build-deps.sh` (add heavy codecs + enable in libvips)

**Interfaces:**
- Consumes: Task 1 build-deps.
- Produces: a rebuilt `.deps-prefix/<new-hash>/lib/libvips-cpp.so.42` whose `vips -l` lists **jxl, heif, magick, pdf** loaders/savers in addition to the Task-1 set.

- [ ] **Step 1: Flip the backend pin (changes the hash → fresh prefix)**

Edit `deps-hash.js`: set `PINS.backends = 'full-jpeg+png+spng+webp+gif+jxl+heif+magick+pdf'` and add the new lib versions to `PINS` (`libjxl`, `libhwy`, `brotli`, `libheif`, `libde265`, `x265`, `aom`, `dav1d`, `imagemagick`, `poppler`, `cairo`, `pixman`, `freetype`, `fontconfig`, `lcms2`, `libtiff`), pinned to the versions the mac libvips embeds (from Task 2 / the mac dylib strings).

- [ ] **Step 2: Extend `build-deps.sh` with the heavy codecs (before the libvips step)**

Insert build blocks (static where possible) for: **libjxl** (+ highway, brotli) — reuse the exact cmake invocation from `nativelibs/zjxl/scripts/build-deps.sh`; **libde265**, **x265**, **aom**, **dav1d**, then **libheif** (cmake, enabling those); **lcms2**, **freetype**, **fontconfig**, **libtiff**, then **ImageMagick** (autotools `./configure --disable-shared --enable-static --with-modules=no` + delegates); **pixman**, **cairo**, then **poppler** (cmake, `-DENABLE_GLIB=ON -DBUILD_SHARED_LIBS=OFF`). Then change the libvips meson flags to:
```
-Djpeg-xl=enabled -Dheif=enabled -Dmagick=enabled -Dpoppler=enabled -Dtiff=enabled -Dlcms=enabled
```
Build in dependency order; each `cmake --install`/`make install` into `$PREFIX`.

- [ ] **Step 3: Rebuild + verify full backend set**

Run:
```bash
bash nativelibs/zimage/scripts/build-deps.sh   # long — full stack from source
PREFIX=$(node nativelibs/zimage/scripts/deps-hash.js)
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/vips" -l | grep -iE 'jxlload|heifload|magickload|pdfload|webpload|gifload|jpegload|pngload'
```
Expected: all of `jxlload`, `heifload`, `magickload`, `pdfload` (+ the Task-1 loaders) are present. Rebuild the addon (`node nativelibs/builder.js nativelibs/zimage`) and re-run the Task 4/5 tests — they must still pass (the addon code is unchanged; only libvips gained loaders). If a heavy backend genuinely cannot build byte-identically, escalate that backend per spec §3.1 rather than silently dropping it.

- [ ] **Step 4: Verify a JXL input thumbnails (the format Zalo uses most)**

Run:
```bash
LD_LIBRARY_PATH="$PREFIX/lib" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e '
  const a=require("./nativelibs/zimage/build/Release/zimage.node"), fs=require("fs"), p=require("path");
  const d="scratchpad/jxl-samples"; const f=p.join(d, fs.readdirSync(d).find(x=>x.endsWith(".jxl")));
  a.thumbnail(fs.readFileSync(f),128,128,"jpg",80,(e,b)=>{ if(e){console.error(e);process.exit(1)} console.log("jxl->thumb",b.length); process.exit(0); });'
```
Expected: prints `jxl->thumb <N>` (proves libvips decodes a real Zalo JXL and thumbnails it).

- [ ] **Step 5: Commit**

```bash
git add nativelibs/zimage/scripts/deps-hash.js nativelibs/zimage/scripts/build-deps.sh
git commit -m "zimage: full libvips backend parity (jxl/heif/magick/pdf) built from pinned source"
```

---

## Task 7: `patch-zimage.js` — build, bundle `.so`, splice `index.js`

**Files:**
- Create: `scripts/patches/patch-zimage.js`, `scripts/patches/__tests__/patch-zimage.test.js`

**Interfaces:**
- Consumes: `builder.js`, `build-deps.sh`, `deps-hash.js`; runtime `app/native/nativelibs/zimage/index.js`.
- Produces: `require('./patch-zimage.js').main()` builds the addon, copies `zimage.node` + the recursive `.so` closure into `app/native/nativelibs/zimage/build/linux_x64/`, sets `RPATH=$ORIGIN`, splices the `linux` branch into `index.js`. Fail-loud + idempotent. Exports `spliceLinuxBranch`.

- [ ] **Step 1: Write the failing splice test**

`scripts/patches/__tests__/patch-zimage.test.js`:
```js
const fs = require('fs-extra'), path = require('path'), os = require('os'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zimg-'));
const idx = path.join(tmp, 'index.js');
// Minimal replica of the real getLib() os-dispatch we splice into.
fs.writeFileSync(idx,
  "function getLib(options){ function getOS(){ if(process.platform==='win32'){return 'win64';}\n" +
  "  else if(process.platform==='darwin'){return 'darwin_x64';}\n" +
  "  return null; }\n const os=getOS();\n if(os===null){ reject({ error: NOT_SUPPORT }); }\n" +
  " else { const zimage=require(`${__dirname}/${os}/zimage.node`); } }\nmodule.exports=getLib;");
const { spliceLinuxBranch } = require('../patch-zimage.js');
spliceLinuxBranch(idx);
let c = fs.readFileSync(idx, 'utf8');
assert(c.includes("process.platform === 'linux'"), 'linux branch inserted');
assert(c.includes("'linux_x64/zimage.node'") || c.includes('linux_x64/zimage.node'), 'linux path inserted');
spliceLinuxBranch(idx);
assert.strictEqual(fs.readFileSync(idx, 'utf8'), c, 'idempotent');
fs.removeSync(tmp);
console.log('OK patch-zimage splice');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/patches/__tests__/patch-zimage.test.js`
Expected: FAIL — `Cannot find module '../patch-zimage.js'`.

- [ ] **Step 3: Write `patch-zimage.js`** (mirror `scripts/patches/patch-zjxl.js`)

Adapt `patch-zjxl.js` verbatim with these substitutions: `LIB_DIR = nativelibs/zimage`; `DEST_DIR = app/native/nativelibs/zimage/build/linux_x64`; `INDEX_JS = app/native/nativelibs/zimage/index.js`; built node is `zimage.node`; `MIN_BUNDLED_LIBS = 1` (the static-linked `libvips-cpp.so.42` may be the only bundled lib — assert `>= 1` and log the actual set). The `resolvePinnedClosure` + RPATH loop + ELF/post-condition checks are identical. The splice targets the zimage `getOS()`/`NOT_SUPPORT` structure — determine the exact anchor from the real `app/native/nativelibs/zimage/index.js`:

```js
// Splice a linux branch into the getOS() dispatch so Linux returns 'linux_x64'
// and the require resolves our built addon. Determine the exact anchor from the
// real index.js: the darwin branch `else if (process.platform === 'darwin') { return 'darwin_x64'; }`.
const ANCHOR_RE = /else if\s*\(\s*process\.platform === 'darwin'\s*\)\s*\{\s*return '([^']+)';\s*\}/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("'linux_x64'")) return; // idempotent
  if (!ANCHOR_RE.test(c)) throw new Error("patch-zimage: darwin getOS anchor not found — bundle format changed, update the splice");
  c = c.replace(ANCHOR_RE, (m) => m + " else if (process.platform === 'linux') { return 'linux_x64'; }");
  fs.writeFileSync(indexPath, c, 'utf8');
}
```
(Verify against the real `index.js` `getOS()` — if it returns `darwin_x64`/`darwin_arm64` via `process.arch`, match that exact shape. The addon then loads via the existing `require(`${__dirname}/${os}/zimage.node`)`; ensure the patch copies `zimage.node` to a `linux_x64/` dir the require resolves, i.e. `DEST_DIR = app/native/nativelibs/zimage/linux_x64` if that's what `getOS()` produces — reconcile DEST_DIR with the getOS() return value.)

- [ ] **Step 4: Run the splice test**

Run: `node scripts/patches/__tests__/patch-zimage.test.js`
Expected: `OK patch-zimage splice`.

- [ ] **Step 5: Full patch run + standalone-load proof**

Run:
```bash
node scripts/patches/patch-zimage.js
DEST=app/native/nativelibs/zimage/linux_x64   # or build/linux_x64 — whatever getOS() resolves
readelf -d "$DEST/zimage.node" | grep -E 'RUNPATH|RPATH'   # -> $ORIGIN
unset LD_LIBRARY_PATH
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "console.log(require('./app/native/nativelibs/zimage/index.js'))" # loads w/o LD_LIBRARY_PATH
```
Expected: RPATH `$ORIGIN`; the module loads and returns `{ Image: { thumbnail, resizeQA } }` (not `NOT_SUPPORT`) with no `LD_LIBRARY_PATH`.

- [ ] **Step 6: Commit**

```bash
git add scripts/patches/patch-zimage.js scripts/patches/__tests__/patch-zimage.test.js
git commit -m "zimage: patch-zimage.js (build + bundle .so + RPATH + splice index.js)"
```

---

## Task 8: Register in orchestrator + fresh SETUP + smoke + barrel test

**Files:**
- Modify: `scripts/main.js`

**Interfaces:**
- Consumes: `patch-zimage.main` (Task 7).
- Produces: SETUP runs `patch-zimage` after `patch-zjxl`; a fresh `app/` where `zimage().Image.thumbnail(...)` works.

- [ ] **Step 1: Register the patch in `scripts/main.js`**

After `await require('./patches/patch-zjxl.js').main();`, add:
```js
      await require('./patches/patch-zimage.js').main();
```
Extend the patch-order comment block with a one-line zimage note (native libvips thumbnail addon, full backend parity).

- [ ] **Step 2: Full fresh SETUP**

Run:
```bash
rm -rf app
ZALO_DMG=/mnt/data/Work/zalo-linux/ZaloSetup-universal-26.6.11.dmg npm run setup
```
Expected: SETUP exit 0; log shows `zimage installed`; the native-version check is clean; `app/native/nativelibs/zimage/<os>/zimage.node` + bundled `.so` present with RPATH.

- [ ] **Step 3: Barrel test through the app loader (self-contained)**

Run:
```bash
unset LD_LIBRARY_PATH
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e '
  const nl = require("./app/native/nativelibs"); const fs=require("fs"),p=require("path");
  (async () => {
    const z = (await nl.zimage()).Image;
    const d="scratchpad/img-samples"; const f=p.join(d, fs.readdirSync(d).find(x=>/\.(jpe?g|png)$/i.test(x)));
    const t = await new Promise((res,rej)=>z.thumbnail(fs.readFileSync(f),128,128,"jpg",80,(e,b)=>e?rej(e):res(b)));
    console.log("barrel thumbnail ok", t.length, "bytes, jpeg=", t[0]===0xFF&&t[1]===0xD8);
    process.exit(0);
  })().catch(e=>{console.error("FAIL",e);process.exit(1);});'
```
Expected: `barrel thumbnail ok <N> bytes, jpeg= true` with NO `LD_LIBRARY_PATH` (proves the whole path works self-contained through the app barrel).

- [ ] **Step 4: XDG-isolated smoke boot**

Run the existing smoke harness (`scripts/_smoke-boot.sh`) — XDG_* → temp dir, never the real `~/.config/ZaloData`. Assert `SMOKE_OK` and no `zimage`/`NOT_SUPPORT` errors in the captured log.

- [ ] **Step 5: Commit**

```bash
git add scripts/main.js
git commit -m "zimage: register patch-zimage in SETUP orchestrator (after zjxl)"
```

---

## Task 9: `.deb` packaging + CI build-time deps

**Files:**
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Consumes: the full SETUP (Task 8).
- Produces: CI installs `meson` (+ existing build tools); `npm run main` builds the `.deb` bundling the zimage `.so` set.

- [ ] **Step 1: Add build-time deps to CI**

In `.github/workflows/build.yml`, extend the `apt-get install` list with the libvips toolchain (append to the zjxl set): `meson pkg-config libglib2.0-dev-bin gettext autoconf automake libtool` (and any autotools needed by ImageMagick). Keep existing packages.

- [ ] **Step 2: Confirm no missing runtime deps**

Run (after a local SETUP):
```bash
DEST=app/native/nativelibs/zimage/linux_x64
ldd "$DEST/zimage.node" 2>&1 | grep -iE 'not found' || echo "no missing deps"
ldd "$DEST"/*.so 2>/dev/null | grep '=>' | grep -viE '\$ORIGIN|linux_x64|libc\.|libm\.|libpthread|libdl|librt|ld-linux|libgcc_s|libstdc\+\+|libz\.|libglib|libgobject' | awk '{print $1}' | sort -u
```
Any residual versioned system lib (e.g. a glib/gobject shared, or an ImageMagick delegate that couldn't be static) → either bundle it into `linux_x64/` (extend the closure) or add its package to `build.deb.depends` in package.json; justify in the report.

- [ ] **Step 3: Build the `.deb` and verify the bundle**

Run:
```bash
rm -rf app dist
ZALO_DMG=/mnt/data/Work/zalo-linux/ZaloSetup-universal-26.6.11.dmg npm run main
DEB=$(ls dist/*.deb | head -1)
dpkg-deb -c "$DEB" | grep -E 'zimage/(linux_x64|build/linux_x64)/(zimage\.node|libvips-cpp\.so)'
```
Expected: the `.deb` includes `zimage.node` + the bundled `libvips-cpp.so.42` (+ any residual `.so`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "zimage: CI build-time deps (meson + libvips toolchain) + .deb bundles zimage .so set"
```

---

## Self-Review

**Spec coverage:**
- §2 JS surface (thumbnail/thumbnailFs) → Tasks 4–5 + Task 3 scaffold. ✓
- §3 pinned libvips 8.14.2 + static codecs → Task 1 (common) + Task 6 (full parity). ✓
- §3.1 FULL backend parity → Task 6 (jxl/heif/magick/pdf). ✓
- §4 build model (addon each patch + deps-prefix cache, static-link) → Task 1/6 + Task 7. ✓
- §5 param recovery + call-site check → Task 2 (Step 1 call-site, Steps 2–5 params). ✓
- §6 verification → Task 4 Step 5, Task 6 Step 4, Task 8 Steps 3–4. ✓
- §7 patch integration → Task 7 + Task 8. ✓
- §8 `.deb`/CI + minimal `.so` bundle → Task 7 + Task 9. ✓
- §9 out of scope (x64, no byte-identical binary) → Global Constraints. ✓
- §10 success criteria → Task 8 Steps 3–4 + Task 9 Step 3. ✓

**Placeholder scan:** the `/*RE*/` values in `re_params.h` (Task 2) are a produced interface (named constants) consumed by Tasks 4–5, resolved in Task 2 — not unresolved plan placeholders. `<a-real-jpeg-or-png>`/`<os>` resolved by `fs.readdirSync`/the getOS() value at execution.

**Type consistency:** `DoThumbnail(in,inLen,width,height,format,quality)` (Task 4) and `DoThumbnailFs(inPath,outPath,width,height,quality)` (Task 5) are self-contained per file. Registrars `RegisterThumbnail`/`RegisterThumbnailFs` match `zimage.cc` (Task 3). `spliceLinuxBranch` exported and consumed by its test (Task 7). `zimage_re::kThumb*`/`kJpeg*`/`kWebp*`/`kPng*` constants (Task 2) match their uses in Tasks 4–5.

**Known risk flagged in-plan:** Task 6 is the heavy one (heif/magick/pdf from source); the plan stages it after a working common-codec libvips (Task 1) and the addon (Tasks 3–5) so partial progress is testable, and requires escalation rather than silent backend drop.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-08-zimage-linux-native-re.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
