# zjxl — Linux Native RE (bit-identical) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reimplement the macOS `jxl.node` JPEG-XL codec addon for Linux x64 as an N-API (node-addon-api) module whose image output is bit-identical to the original, by pinning the exact upstream library versions the mac bundle ships and recovering the exact encode parameters from the mac binary.

**Architecture:** A C++ node-addon-api addon (`nativelibs/zjxl/`) exposing the same 8 native methods `index.js` calls (`jxlToJpeg`, `jxlToJpegFromLocalPath`, `bitmapToJxl`, `getJxlInfo`, `resizeJxl`, `resizeJxlLimit`, `moduleReady`, `jxlDecompressMulti`). Heavy third-party libs (libjxl 0.9.3, libhwy 1.0.7, brotli 1.0.9, libjpeg-turbo, OpenCV 4.12.0) are built from pinned source into a content-addressed cache `nativelibs/zjxl/.deps-prefix/<hash>/`; the addon links against that prefix and bundles the resulting `.so` set into `build/linux_x64/` with `RPATH=$ORIGIN`, mirroring the mac dylib layout. A `patch-zjxl.js` (modeled on `patch-db-cross-v4.js`) builds the addon every SETUP and splices a `linux` branch into the runtime `index.js`.

**Tech Stack:** C++17, node-addon-api, node-gyp (Electron 22.3.27 headers), libjxl 0.9.3, libjpeg-turbo, OpenCV 4.12.0 (core+imgproc), Highway 1.0.7, brotli 1.0.9, radare2/objdump for RE, Node test scripts for verification.

## Global Constraints

- **Electron target:** 22.3.27 (`ROOT_PKG.devDependencies.electron`); addon built via `nativelibs/builder.js` (`node-gyp rebuild --target=22.3.27 --arch=x64 --dist-url=https://electronjs.org/headers`). N-API ABI → one build runs all Electron 22.x.
- **Platform:** x64 Linux only. No ARM64.
- **Pinned dependency versions (verbatim, from mac `LC_ID_DYLIB`):** libjxl **0.9.3** (+ `libjxl_cms`/`libjxl_dec`/`libjxl_threads`), libhwy **1.0.7**, brotli **1.0.9**, libjpeg-turbo yielding SONAMEs libjpeg **62.4.0** / libturbojpeg **0.4.0** (tag `3.0.2` — verify SONAMEs in Task 1), OpenCV **4.12.0** (core+imgproc only).
- **Fidelity target:** bit-identical *image output* (not a byte-identical `.node`). Recovered params live in `nativelibs/zjxl/src/re_params.h` (Task 2) and are the single source of truth consumed by all encode/resize/decode tasks.
- **Faithful layout:** bundle the same dynamic `.so` set the mac ships as `.dylib`, into `app/native/nativelibs/zjxl/build/linux_x64/`, addon linked `RPATH=$ORIGIN`.
- **Patches are fail-loud + idempotent:** every splice throws if its anchor no longer matches; re-running a patch is a no-op.
- **JS surface is contractual:** native method names, input-object keys, and the `(error, data, status_code)` callback shape must not change.
- **Build model:** addon rebuilt every SETUP (like `db-cross-v4`); heavy deps built once into `.deps-prefix/<hash>/` and reused on cache hit.
- **Never touch the live Zalo profile:** all verification uses copies under `scratchpad/jxl-samples/` (22 real `.jxl` already collected) and XDG-isolated smoke boots.
- **Attribution:** no `Co-Authored-By`, no "Generated with Claude"/🤖 in any commit, file, or doc.
- **C++ exceptions ENABLED** (OpenCV throws `cv::Exception`; node-addon-api default exception mode). Do **not** define `NAPI_DISABLE_CPP_EXCEPTIONS` and do **not** strip `-fexceptions`.

---

## File Structure

**Create (source, committed):**
- `nativelibs/zjxl/package.json` — declares `node-addon-api` dep.
- `nativelibs/zjxl/binding.gyp` — addon build config, links `.deps-prefix`.
- `nativelibs/zjxl/scripts/build-deps.sh` — builds pinned libs into `.deps-prefix/<hash>/`.
- `nativelibs/zjxl/scripts/deps-hash.js` — computes the content hash + prints prefix path.
- `nativelibs/zjxl/src/common.h` — shared helpers (arg parsing, async worker base, buffer helpers).
- `nativelibs/zjxl/src/re_params.h` — recovered constants (Task 2).
- `nativelibs/zjxl/src/zjxl.cc` — N-API `Init`, registers all methods, `moduleReady`.
- `nativelibs/zjxl/src/info.cc` — `getJxlInfo`.
- `nativelibs/zjxl/src/decode.cc` — `jxlToJpeg`, `jxlToJpegFromLocalPath`.
- `nativelibs/zjxl/src/encode.cc` — `bitmapToJxl`.
- `nativelibs/zjxl/src/resize.cc` — `resizeJxl`, `resizeJxlLimit`.
- `nativelibs/zjxl/src/multi.cc` — `jxlDecompressMulti`.
- `nativelibs/zjxl/RE-PARAMS.md` — human-readable RE notes (Task 2).
- `nativelibs/zjxl/README.md` — attribution + build notes.
- `scripts/patches/patch-zjxl.js` — build + install + splice.
- `scripts/patches/__tests__/patch-zjxl.test.js` — splice/idempotency test.

**Modify:**
- `scripts/main.js` — register `patch-zjxl` after `patch-v8-profiles`.
- `.github/workflows/build.yml` — add build-time apt deps.
- `.gitignore` — ignore `nativelibs/zjxl/.deps-prefix/` and `nativelibs/zjxl/deps-src/`.

**Runtime (gitignored, produced each SETUP):**
- `app/native/nativelibs/zjxl/build/linux_x64/jxl.node` + bundled `.so`.
- `app/native/nativelibs/zjxl/index.js` — spliced with the `linux` branch.

---

## Task 1: Pinned dependency build into content-addressed prefix

**Files:**
- Create: `nativelibs/zjxl/scripts/deps-hash.js`
- Create: `nativelibs/zjxl/scripts/build-deps.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `node scripts/deps-hash.js` prints the absolute prefix path `nativelibs/zjxl/.deps-prefix/<hash>`; `<hash>` = sha256 (first 12 hex) of the pinned versions + build flags string. `bash scripts/build-deps.sh` populates `<prefix>/{include,lib}` with the pinned libs and writes `<prefix>/.done` on success. Later tasks read `<prefix>/include` and `<prefix>/lib`.

- [ ] **Step 1: Write the failing test**

Create `nativelibs/zjxl/scripts/__tests__/deps-hash.test.js`:

```js
const cp = require('child_process');
const path = require('path');
const assert = require('assert');
const out = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert(/\.deps-prefix[/\\][0-9a-f]{12}$/.test(out), 'prefix path shape: ' + out);
// Deterministic: two runs yield the same hash.
const out2 = cp.execSync('node ' + path.join(__dirname, '..', 'deps-hash.js'), { encoding: 'utf8' }).trim();
assert.strictEqual(out, out2, 'hash is deterministic');
console.log('OK deps-hash');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node nativelibs/zjxl/scripts/__tests__/deps-hash.test.js`
Expected: FAIL — `Cannot find module '../deps-hash.js'`.

- [ ] **Step 3: Write `deps-hash.js`**

```js
// Prints the content-addressed deps prefix path. The hash pins the exact
// upstream versions + build flags so a version bump invalidates the cache.
const crypto = require('crypto');
const path = require('path');

const PINS = {
  libjxl: '0.9.3',
  highway: '1.0.7',
  brotli: '1.0.9',
  libjpeg_turbo: '3.0.2',
  opencv: '4.12.0',
  flags: 'x64-relwithdebinfo-cxx17-shared-jxl-static-hwy',
  abi: 1, // bump to force a rebuild without changing a version
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node nativelibs/zjxl/scripts/__tests__/deps-hash.test.js`
Expected: `OK deps-hash`.

- [ ] **Step 5: Write `build-deps.sh`**

```bash
#!/usr/bin/env bash
# Builds the exact pinned libs the mac bundle ships, into a content-addressed
# prefix. Idempotent: exits early if <prefix>/.done exists. Everything is built
# from source; nothing prebuilt is checked in.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # nativelibs/zjxl
PREFIX="$(node "$HERE/scripts/deps-hash.js")"
SRC="$HERE/deps-src"
JOBS="$(nproc)"

if [ -f "$PREFIX/.done" ]; then
  echo "deps-prefix cache hit: $PREFIX"
  exit 0
fi

for tool in cmake nasm ninja git curl; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$PREFIX" "$SRC"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
CMAKE_COMMON=(-G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=ON)

clone() { # repo tag dir
  local repo="$1" tag="$2" dir="$3"
  [ -d "$SRC/$dir" ] || git clone --depth 1 --branch "$tag" --recurse-submodules "$repo" "$SRC/$dir"
}

# ---- Highway 1.0.7 (static; libjxl SIMD dep) ----
clone https://github.com/google/highway v1.0.7 highway
cmake -S "$SRC/highway" -B "$SRC/highway/b" "${CMAKE_COMMON[@]}" \
  -DBUILD_SHARED_LIBS=OFF -DHWY_ENABLE_TESTS=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_CONTRIB=OFF
cmake --build "$SRC/highway/b" -j"$JOBS"; cmake --install "$SRC/highway/b"

# ---- brotli 1.0.9 ----
clone https://github.com/google/brotli v1.0.9 brotli
cmake -S "$SRC/brotli" -B "$SRC/brotli/b" "${CMAKE_COMMON[@]}"
cmake --build "$SRC/brotli/b" -j"$JOBS"; cmake --install "$SRC/brotli/b"

# ---- libjpeg-turbo 3.0.2 (libjpeg.62 + libturbojpeg) ----
clone https://github.com/libjpeg-turbo/libjpeg-turbo 3.0.2 ljt
cmake -S "$SRC/ljt" -B "$SRC/ljt/b" "${CMAKE_COMMON[@]}" -DWITH_TURBOJPEG=ON
cmake --build "$SRC/ljt/b" -j"$JOBS"; cmake --install "$SRC/ljt/b"

# ---- libjxl 0.9.3 (shared; uses the highway/brotli/jpeg above) ----
clone https://github.com/libjxl/libjxl v0.9.3 libjxl
cmake -S "$SRC/libjxl" -B "$SRC/libjxl/b" "${CMAKE_COMMON[@]}" \
  -DJPEGXL_ENABLE_PLUGINS=OFF -DJPEGXL_ENABLE_TOOLS=ON -DJPEGXL_ENABLE_BENCHMARK=OFF \
  -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_MANPAGES=OFF -DJPEGXL_ENABLE_JNI=OFF \
  -DJPEGXL_FORCE_SYSTEM_HWY=ON -DJPEGXL_FORCE_SYSTEM_BROTLI=ON \
  -DHWY_ROOT="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX"
cmake --build "$SRC/libjxl/b" -j"$JOBS"; cmake --install "$SRC/libjxl/b"

# ---- OpenCV 4.12.0 (core + imgproc only) ----
clone https://github.com/opencv/opencv 4.12.0 opencv
cmake -S "$SRC/opencv" -B "$SRC/opencv/b" "${CMAKE_COMMON[@]}" \
  -DBUILD_LIST=core,imgproc -DBUILD_opencv_apps=OFF -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF \
  -DBUILD_EXAMPLES=OFF -DWITH_FFMPEG=OFF -DWITH_GTK=OFF -DWITH_QT=OFF -DWITH_IPP=OFF \
  -DWITH_PROTOBUF=OFF -DWITH_JASPER=OFF -DWITH_OPENEXR=OFF -DWITH_PNG=OFF -DWITH_TIFF=OFF \
  -DOPENCV_GENERATE_PKGCONFIG=ON
cmake --build "$SRC/opencv/b" -j"$JOBS"; cmake --install "$SRC/opencv/b"

# libjxl installs .so into lib/ ; opencv may use lib/ or lib64/ — normalize.
if [ -d "$PREFIX/lib64" ]; then cp -a "$PREFIX/lib64/." "$PREFIX/lib/"; fi
# opencv headers land under include/opencv4 — expose both.
touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
```

- [ ] **Step 6: Make executable and run the deps build (long — first run only)**

Run:
```bash
chmod +x nativelibs/zjxl/scripts/build-deps.sh
sudo apt-get install -y cmake nasm ninja-build git curl build-essential
bash nativelibs/zjxl/scripts/build-deps.sh
```
Expected: ends with `deps-prefix built: .../.deps-prefix/<hash>`; the SONAMEs match the pins:
```bash
PREFIX=$(node nativelibs/zjxl/scripts/deps-hash.js)
ls "$PREFIX/lib" | grep -E 'libjxl\.so|libturbojpeg\.so|libopencv_core\.so|libopencv_imgproc\.so'
readelf -d "$PREFIX/lib/libjxl.so" | grep SONAME    # -> libjxl.so.0.9
```
If `libjpeg`/`libturbojpeg` SONAMEs differ from `62.4.0`/`0.4.0`, adjust the libjpeg-turbo tag in `deps-hash.js` `PINS.libjpeg_turbo` and re-run, then record the correct tag.

- [ ] **Step 7: Ignore build artifacts**

Add to `.gitignore` (after the `*.node` block):
```
# zjxl heavy deps (built from pinned source into a content-addressed cache)
nativelibs/zjxl/.deps-prefix/
nativelibs/zjxl/deps-src/
```

- [ ] **Step 8: Commit**

```bash
git add nativelibs/zjxl/scripts/ .gitignore
git commit -m "zjxl: pinned deps build into content-addressed prefix (libjxl 0.9.3, opencv 4.12, hwy/brotli/turbojpeg)"
```

---

## Task 2: Recover exact parameters from the mac binary → `re_params.h`

**Files:**
- Create: `nativelibs/zjxl/src/re_params.h`
- Create: `nativelibs/zjxl/RE-PARAMS.md`

**Interfaces:**
- Produces: `re_params.h` with named `constexpr` constants consumed by encode/decode/resize tasks:
  `kEncodeDistance` (float), `kEncodeLossless` (bool), `kEncodeEffort` (int), `kEncodeBitsPerSample` (int), `kEncodeAlpha` (bool, and channel count logic), `kDefaultJpegQuality` (int), `kResizeInterp` (int, OpenCV `INTER_*` numeric), `kResizeReencodeDistance` (float), `kResizeReencodeEffort` (int). `RE-PARAMS.md` documents how each was derived (address + disassembly snippet).

- [ ] **Step 1: Disassemble the encode path and locate the constants**

Run (records the argument set for the encoder calls):
```bash
BIN=app/native/nativelibs/zjxl/build/darwin_x64/jxl.node
# Function boundaries (demangled):
rabin2 -qs "$BIN" | c++filt | grep -E 'bitmapToJxl|resizeJxl|jxlToJpeg|resizeImage|shouldResize|resizePPFWithOpenCV|getJxlInfo'
# Disassemble bitmapToJxl and read the immediates feeding the encoder setters:
r2 -q -c 'aa; s sym._Z11bitmapToJxlRKN4Napi12CallbackInfoE; pdf' "$BIN" 2>/dev/null \
  | grep -iE 'SetFrameDistance|SetFrameLossless|FrameSettingsSetOption|SetBasicInfo|movss|movsd|mov .*, 0x|cvtsi'
```
Read the immediate that is moved into `xmm0`/`edi`/`esi` immediately before each `call ... JxlEncoderSetFrameDistance` / `...SetFrameLossless` / `...FrameSettingsSetOption`. `FrameSettingsSetOption`'s first int arg is the `JxlEncoderFrameSettingId` (effort = `0`), the second is the effort value. `SetFrameDistance` takes a float (`0.0` = lossless-ish, `1.0` = visually lossless). Record each with its address.

- [ ] **Step 2: Disassemble the decode + resize paths**

Run:
```bash
r2 -q -c 'aa; s sym._Z9jxlToJpegRKN4Napi12CallbackInfoE; pdf' "$BIN" 2>/dev/null \
  | grep -iE 'jpeg_set_quality|mov .*0x|tjCompress|TJSAMP|JxlDecoderSetImageOutBuffer|JXL_TYPE'
r2 -q -c 'aa; s sym._Z11resizeImagePKhmiiRiS1_RNSt3__16vectorIhNS2_9allocatorIhEEEE; pdf' "$BIN" 2>/dev/null \
  | grep -iE 'cv|resize|INTER|mov .*0x'
```
Recover: default JPEG quality when caller passes none; turbojpeg subsampling constant (`TJSAMP_*`); the decoder pixel format (`JXL_TYPE_UINT8`, channel count); and the OpenCV interpolation flag numeric (`INTER_NEAREST=0, INTER_LINEAR=1, INTER_CUBIC=2, INTER_AREA=3, INTER_LANCZOS4=4`).

- [ ] **Step 3: Cross-check against a real sample's header**

Confirm the recovered bit-depth/channels/color match a real Zalo JXL header, using the pinned libjxl tools built in Task 1:
```bash
PREFIX=$(node nativelibs/zjxl/scripts/deps-hash.js)
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/jxlinfo" -v \
  scratchpad/jxl-samples/z7990378059385_ff15c6db0adb86c709042242378ca437.jxl
```
Expected: prints dimensions, `8-bit`, channel/alpha info consistent with the recovered `kEncodeBitsPerSample`/`kEncodeAlpha`. Note any mismatch in `RE-PARAMS.md`.

- [ ] **Step 4: Write `re_params.h`**

Fill each constant with the value recovered in Steps 1–3. Example shape (values are the recovered ones, not these placeholders — replace before committing):

```cpp
#pragma once
// Constants reverse-engineered from app/native/nativelibs/zjxl/build/darwin_x64/jxl.node
// (bundle 26.6.11). Derivation for each value is documented in RE-PARAMS.md with the
// binary address + disassembly it came from. These are the single source of truth for
// bit-identical output; do not change without re-deriving from the binary.
namespace zjxl_re {
// --- bitmapToJxl (encode) ---
constexpr float kEncodeDistance      = /*RE Step1*/ 1.0f;   // JxlEncoderSetFrameDistance
constexpr bool  kEncodeLossless      = /*RE Step1*/ false;  // JxlEncoderSetFrameLossless
constexpr int   kEncodeEffort        = /*RE Step1*/ 7;      // FrameSettingsSetOption(EFFORT, .)
constexpr int   kEncodeBitsPerSample = /*RE Step1*/ 8;      // JxlBasicInfo.bits_per_sample
constexpr bool  kEncodeAlpha         = /*RE Step1*/ true;   // alpha present -> 4 channels
// --- jxlToJpeg (decode -> jpeg) ---
constexpr int   kDefaultJpegQuality  = /*RE Step2*/ 90;     // when caller omits quality
constexpr int   kJpegSubsamp         = /*RE Step2*/ 2;      // TJSAMP_420
// --- resizeJxl / resizeJxlLimit ---
constexpr int   kResizeInterp        = /*RE Step2*/ 1;      // cv::INTER_LINEAR
constexpr float kResizeReencodeDist  = /*RE Step2*/ 1.0f;
constexpr int   kResizeReencodeEffort= /*RE Step2*/ 7;
}  // namespace zjxl_re
```

- [ ] **Step 5: Write `RE-PARAMS.md`**

Document, per constant: the mac binary address, the `r2 pdf` snippet, the recovered value, and (where checked) the sample-header cross-check. Include a "confidence" note per value (`certain` / `assumed — verified functionally in Task 6`).

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zjxl/src/re_params.h nativelibs/zjxl/RE-PARAMS.md
git commit -m "zjxl: recover encode/decode/resize params from mac binary (re_params.h + RE-PARAMS.md)"
```

---

## Task 3: Addon scaffold + `moduleReady` (builds against the prefix, loads under Electron)

**Files:**
- Create: `nativelibs/zjxl/package.json`, `nativelibs/zjxl/binding.gyp`, `nativelibs/zjxl/src/common.h`, `nativelibs/zjxl/src/zjxl.cc`, `nativelibs/zjxl/README.md`
- Test: `nativelibs/zjxl/__tests__/moduleReady.test.js`

**Interfaces:**
- Consumes: `.deps-prefix/<hash>` (Task 1); `re_params.h` (Task 2).
- Produces: `build/Release/jxl.node` exporting `moduleReady()` → `true`. The N-API `Init` in `zjxl.cc` is where later tasks register their exports via `void RegisterInfo/Decode/Encode/Resize/Multi(Napi::Env, Napi::Object)`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "zjxl-native",
  "version": "1.0.0",
  "private": true,
  "description": "Linux native JPEG-XL codec addon (RE of Zalo jxl.node)",
  "dependencies": { "node-addon-api": "^5.1.0" }
}
```

- [ ] **Step 2: Write `binding.gyp`**

```python
{
  "targets": [{
    "target_name": "jxl",
    "sources": [
      "src/zjxl.cc", "src/info.cc", "src/decode.cc",
      "src/encode.cc", "src/resize.cc", "src/multi.cc"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include')\")",
      "<!(node -e \"process.stdout.write(require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/include/opencv4')\")"
    ],
    "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
    "cflags_cc": ["-std=c++17", "-O2", "-fexceptions"],
    "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
    "libraries": [
      "<!(node -e \"process.stdout.write('-L'+require('child_process').execSync('node '+require('path').join(process.cwd(),'scripts','deps-hash.js')).toString()+'/lib')\")",
      "-ljxl", "-ljxl_threads", "-lturbojpeg", "-lopencv_core", "-lopencv_imgproc",
      "-Wl,-rpath,'$$ORIGIN'"
    ]
  }]
}
```

- [ ] **Step 3: Write `src/common.h`**

```cpp
#pragma once
#include <napi.h>
#include <cstdint>
#include <vector>
#include <string>

namespace zjxl {
// Read a Buffer property from an options object; throws a JS TypeError if missing.
inline std::vector<uint8_t> GetBuffer(const Napi::Object& opts, const char* key) {
  Napi::Value v = opts.Get(key);
  if (!v.IsBuffer()) throw Napi::TypeError::New(opts.Env(), std::string(key) + " must be a Buffer");
  auto buf = v.As<Napi::Buffer<uint8_t>>();
  return std::vector<uint8_t>(buf.Data(), buf.Data() + buf.Length());
}
inline int GetInt(const Napi::Object& opts, const char* key, int dflt) {
  Napi::Value v = opts.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : dflt;
}
// Status codes returned to JS as the callback's 3rd arg.
enum StatusCode { OK = 0, ERR_INPUT = 1, ERR_DECODE = 2, ERR_ENCODE = 3, ERR_RESIZE = 4 };
}  // namespace zjxl
```

- [ ] **Step 4: Write `src/zjxl.cc`**

```cpp
#include <napi.h>
#include "common.h"

namespace zjxl {
void RegisterInfo(Napi::Env, Napi::Object);
void RegisterDecode(Napi::Env, Napi::Object);
void RegisterEncode(Napi::Env, Napi::Object);
void RegisterResize(Napi::Env, Napi::Object);
void RegisterMulti(Napi::Env, Napi::Object);

static Napi::Value ModuleReady(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}
}  // namespace zjxl

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("moduleReady", Napi::Function::New(env, zjxl::ModuleReady));
  zjxl::RegisterInfo(env, exports);
  zjxl::RegisterDecode(env, exports);
  zjxl::RegisterEncode(env, exports);
  zjxl::RegisterResize(env, exports);
  zjxl::RegisterMulti(env, exports);
  return exports;
}
NODE_API_MODULE(jxl, Init)
```

- [ ] **Step 5: Add empty registrars so the scaffold links**

Create `src/info.cc`, `src/decode.cc`, `src/encode.cc`, `src/resize.cc`, `src/multi.cc`, each initially:

```cpp
#include <napi.h>
#include "common.h"
namespace zjxl { void RegisterInfo(Napi::Env, Napi::Object) {} }
```
(with the matching function name per file: `RegisterInfo`, `RegisterDecode`, `RegisterEncode`, `RegisterResize`, `RegisterMulti`).

- [ ] **Step 6: Write the failing test**

Create `nativelibs/zjxl/__tests__/moduleReady.test.js`:

```js
// Runs the built addon under Electron's Node ABI (ELECTRON_RUN_AS_NODE) — no display.
const path = require('path');
const assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
assert.strictEqual(typeof addon.moduleReady, 'function', 'moduleReady exported');
assert.strictEqual(addon.moduleReady(), true, 'moduleReady() true');
for (const fn of ['jxlToJpeg', 'bitmapToJxl', 'getJxlInfo', 'resizeJxl', 'resizeJxlLimit', 'jxlDecompressMulti', 'jxlToJpegFromLocalPath']) {
  assert.strictEqual(typeof addon[fn], 'function', fn + ' exported');
}
console.log('OK moduleReady');
```

- [ ] **Step 7: Build and run test — verify it fails first, then passes**

Run:
```bash
bash nativelibs/zjxl/scripts/build-deps.sh                 # cache hit after Task 1
node nativelibs/builder.js nativelibs/zjxl                 # builds build/Release/jxl.node
ELECTRON=node_modules/.bin/electron
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" nativelibs/zjxl/__tests__/moduleReady.test.js
```
Expected first run: FAIL — the per-method assertions fail (registrars are empty, only `moduleReady` exists). Add the method exports as they are implemented in Tasks 4–8; until then, temporarily assert only `moduleReady`. Expected after this task: `moduleReady` assertion passes and the addon loads without an ABI/link error.

> Note: `moduleReady` proves the addon links against the bundled libjxl/opencv and loads under the Electron ABI. The per-method exports are added by Tasks 4–8; keep the loop but expand it as each lands.

- [ ] **Step 8: Write `README.md`** (attribution: reimplemented from the mac binary; lists pinned versions; no upstream Zalo source used).

- [ ] **Step 9: Commit**

```bash
git add nativelibs/zjxl/package.json nativelibs/zjxl/binding.gyp nativelibs/zjxl/src nativelibs/zjxl/__tests__ nativelibs/zjxl/README.md
git commit -m "zjxl: addon scaffold + moduleReady (links bundled libjxl/opencv, loads under Electron ABI)"
```

---

## Task 4: `getJxlInfo`

**Files:**
- Modify: `nativelibs/zjxl/src/info.cc`
- Test: `nativelibs/zjxl/__tests__/getJxlInfo.test.js`

**Interfaces:**
- Consumes: `common.h`; libjxl `jxl/decode.h`.
- Produces: `getJxlInfo({buffer}, cb)` → `cb(null, {width, height, ...}, 0)`; native export `getJxlInfo` registered on `exports`.

- [ ] **Step 1: Write the failing test**

```js
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const sample = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples',
  'z7990378059385_ff15c6db0adb86c709042242378ca437.jxl'); // adjust to an existing sample
const buf = fs.readFileSync(sample);
addon.getJxlInfo({ buffer: buf }, (err, data, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0);
  assert(Number.isInteger(data.width) && data.width > 0, 'width');
  assert(Number.isInteger(data.height) && data.height > 0, 'height');
  console.log('OK getJxlInfo', data.width + 'x' + data.height);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/getJxlInfo.test.js`
Expected: FAIL — `getJxlInfo is not a function`.

- [ ] **Step 3: Implement `getJxlInfo` in `src/info.cc`**

```cpp
#include <napi.h>
#include <jxl/decode.h>
#include "common.h"

namespace zjxl {

static Napi::Value GetJxlInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> in;
  try { in = GetBuffer(opts, "buffer"); }
  catch (const Napi::Error& e) { cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }

  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO);
  JxlDecoderSetInput(dec, in.data(), in.size());
  JxlDecoderCloseInput(dec);

  JxlBasicInfo bi;
  bool got = false;
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_ERROR) break;
    if (st == JXL_DEC_BASIC_INFO) { if (JxlDecoderGetBasicInfo(dec, &bi) == JXL_DEC_SUCCESS) got = true; break; }
    if (st == JXL_DEC_SUCCESS || st == JXL_DEC_NEED_MORE_INPUT) break;
  }
  JxlDecoderDestroy(dec);

  if (!got) { cb.Call({Napi::String::New(env, "getJxlInfo: parse failed"), env.Null(), Napi::Number::New(env, ERR_DECODE)}); return env.Undefined(); }
  Napi::Object out = Napi::Object::New(env);
  out.Set("width", Napi::Number::New(env, bi.xsize));
  out.Set("height", Napi::Number::New(env, bi.ysize));
  out.Set("hasAlpha", Napi::Boolean::New(env, bi.alpha_bits > 0));
  out.Set("bitsPerSample", Napi::Number::New(env, bi.bits_per_sample));
  cb.Call({env.Null(), out, Napi::Number::New(env, OK)});
  return env.Undefined();
}

void RegisterInfo(Napi::Env env, Napi::Object exports) {
  exports.Set("getJxlInfo", Napi::Function::New(env, GetJxlInfo));
}
}  // namespace zjxl
```

- [ ] **Step 4: Add `jxl/decode.h` availability + rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zjxl && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/getJxlInfo.test.js`
Expected: `OK getJxlInfo <W>x<H>`. Cross-check `<W>x<H>` against `jxlinfo` from Task 2 Step 3.

- [ ] **Step 5: Reconcile output keys with the mac binary**

If `RE-PARAMS.md` (Task 2) recorded different `getJxlInfo` object keys (e.g. the mac binary emits `w`/`h` or extra fields), update `out.Set(...)` to match exactly, and update the test assertions.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zjxl/src/info.cc nativelibs/zjxl/__tests__/getJxlInfo.test.js
git commit -m "zjxl: getJxlInfo (header parse via libjxl 0.9.3)"
```

---

## Task 5: `jxlToJpeg` + `jxlToJpegFromLocalPath` (decode → JPEG; the display path)

**Files:**
- Modify: `nativelibs/zjxl/src/decode.cc`
- Test: `nativelibs/zjxl/__tests__/decode.test.js`

**Interfaces:**
- Consumes: `common.h`, `re_params.h` (`kDefaultJpegQuality`, `kJpegSubsamp`); libjxl `jxl/decode.h`, `turbojpeg.h`.
- Produces: `jxlToJpeg({buffer, quality, outputWidth, outputHeight}, cb)` → `cb(null, Buffer(jpeg), 0)`; `jxlToJpegFromLocalPath({path, quality,...}, cb)` reads the file then delegates. Registered as `jxlToJpeg`, `jxlToJpegFromLocalPath`.

- [ ] **Step 1: Write the failing test**

```js
const path = require('path'), fs = require('fs'), assert = require('assert'), cp = require('child_process');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');
const sample = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.jxl')));
addon.jxlToJpeg({ buffer: fs.readFileSync(sample), quality: 90 }, (err, data, status) => {
  assert.ifError(err); assert.strictEqual(status, 0);
  assert(Buffer.isBuffer(data) && data.length > 2, 'jpeg buffer');
  assert.strictEqual(data[0], 0xFF, 'JPEG SOI'); assert.strictEqual(data[1], 0xD8, 'JPEG SOI');
  fs.writeFileSync('/tmp/zjxl-out.jpg', data);
  console.log('OK jxlToJpeg', data.length, 'bytes');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/decode.test.js`
Expected: FAIL — `jxlToJpeg is not a function`.

- [ ] **Step 3: Implement decode in `src/decode.cc`**

Use an `AsyncWorker` so it matches the mac binary's async callback behavior (the mac symbols show async workers).

```cpp
#include <napi.h>
#include <jxl/decode.h>
#include <jxl/resizable_parallel_runner.h>
#include <turbojpeg.h>
#include <fstream>
#include "common.h"
#include "re_params.h"

namespace zjxl {

// Decode a JXL codestream to interleaved RGB8. Returns false on failure.
static bool DecodeToRgb(const std::vector<uint8_t>& in, std::vector<uint8_t>& rgb,
                        uint32_t& w, uint32_t& h) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  void* runner = JxlResizableParallelRunnerCreate(nullptr);
  JxlDecoderSetParallelRunner(dec, JxlResizableParallelRunner, runner);
  JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE);
  JxlDecoderSetInput(dec, in.data(), in.size());
  JxlDecoderCloseInput(dec);
  JxlPixelFormat fmt{3, JXL_TYPE_UINT8, JXL_LITTLE_ENDIAN, 0};
  bool ok = false;
  for (;;) {
    JxlDecoderStatus st = JxlDecoderProcessInput(dec);
    if (st == JXL_DEC_ERROR) break;
    if (st == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo bi; if (JxlDecoderGetBasicInfo(dec, &bi) != JXL_DEC_SUCCESS) break;
      w = bi.xsize; h = bi.ysize; JxlResizableParallelRunnerSetThreads(runner, JxlResizableParallelRunnerSuggestThreads(w, h));
    } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t need = 0; if (JxlDecoderImageOutBufferSize(dec, &fmt, &need) != JXL_DEC_SUCCESS) break;
      rgb.resize(need);
      if (JxlDecoderSetImageOutBuffer(dec, &fmt, rgb.data(), rgb.size()) != JXL_DEC_SUCCESS) break;
    } else if (st == JXL_DEC_FULL_IMAGE) {
      ok = true; break;
    } else if (st == JXL_DEC_SUCCESS) { ok = true; break; }
    else if (st == JXL_DEC_NEED_MORE_INPUT) break;
  }
  JxlResizableParallelRunnerDestroy(runner);
  JxlDecoderDestroy(dec);
  return ok;
}

// RGB8 -> JPEG via turbojpeg at the given quality/subsampling.
static bool RgbToJpeg(const std::vector<uint8_t>& rgb, uint32_t w, uint32_t h,
                      int quality, std::vector<uint8_t>& jpeg) {
  tjhandle tj = tjInitCompress();
  unsigned char* out = nullptr; unsigned long outSize = 0;
  int rc = tjCompress2(tj, rgb.data(), (int)w, 0, (int)h, TJPF_RGB,
                       &out, &outSize, kJpegSubsamp, quality, TJFLAG_ACCURATEDCT);
  bool ok = rc == 0;
  if (ok) jpeg.assign(out, out + outSize);
  if (out) tjFree(out);
  tjDestroy(tj);
  return ok;
}

class DecodeWorker : public Napi::AsyncWorker {
 public:
  DecodeWorker(Napi::Function cb, std::vector<uint8_t> in, int quality)
      : Napi::AsyncWorker(cb), in_(std::move(in)), quality_(quality) {}
  void Execute() override {
    uint32_t w = 0, h = 0; std::vector<uint8_t> rgb;
    if (!DecodeToRgb(in_, rgb, w, h)) { status_ = ERR_DECODE; SetError("jxlToJpeg: decode failed"); return; }
    if (!RgbToJpeg(rgb, w, h, quality_, jpeg_)) { status_ = ERR_ENCODE; SetError("jxlToJpeg: jpeg encode failed"); return; }
  }
  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(), Napi::Buffer<uint8_t>::Copy(env, jpeg_.data(), jpeg_.size()), Napi::Number::New(env, OK)});
  }
  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call({e.Value(), env.Null(), Napi::Number::New(env, status_)});
  }
 private:
  std::vector<uint8_t> in_, jpeg_;
  int quality_; int status_ = ERR_DECODE;
};

static int ClampQuality(const Napi::Object& opts) {
  int q = GetInt(opts, "quality", kDefaultJpegQuality);
  if (q < 1 || q > 100) q = kDefaultJpegQuality;
  return q;
}

static Napi::Value JxlToJpeg(const Napi::CallbackInfo& info) {
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> in;
  try { in = GetBuffer(opts, "buffer"); }
  catch (const Napi::Error& e) { cb.Call({e.Value(), info.Env().Null(), Napi::Number::New(info.Env(), ERR_INPUT)}); return info.Env().Undefined(); }
  (new DecodeWorker(cb, std::move(in), ClampQuality(opts)))->Queue();
  return info.Env().Undefined();
}

static Napi::Value JxlToJpegFromLocalPath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::string p = opts.Get("path").As<Napi::String>();
  std::ifstream f(p, std::ios::binary);
  if (!f) { cb.Call({Napi::String::New(env, "open failed"), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  std::vector<uint8_t> in((std::istreambuf_iterator<char>(f)), {});
  (new DecodeWorker(cb, std::move(in), ClampQuality(opts)))->Queue();
  return env.Undefined();
}

void RegisterDecode(Napi::Env env, Napi::Object exports) {
  exports.Set("jxlToJpeg", Napi::Function::New(env, JxlToJpeg));
  exports.Set("jxlToJpegFromLocalPath", Napi::Function::New(env, JxlToJpegFromLocalPath));
}
}  // namespace zjxl
```

- [ ] **Step 4: Add `-ljxl_threads`/turbojpeg already in binding.gyp; rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zjxl && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/decode.test.js`
Expected: `OK jxlToJpeg <N> bytes`; `/tmp/zjxl-out.jpg` opens as a valid image.

- [ ] **Step 5: Bit-identical / pixel-identical verification against the pinned oracle**

Since the mac Mach-O can't run natively, verify decode determinism against libjxl 0.9.3's own `djxl` (same source we build → same pixels):
```bash
PREFIX=$(node nativelibs/zjxl/scripts/deps-hash.js)
S=scratchpad/jxl-samples/<sample>.jxl
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/djxl" "$S" /tmp/ref.ppm
# Compare our decoded RGB against djxl's PPM pixels (write a tiny compare in the test or use ImageMagick if present).
```
Expected: our decoded RGB equals `djxl`'s pixels byte-for-byte. Document in `RE-PARAMS.md` that the JPEG re-encode is then deterministic given `kJpegSubsamp` + quality + the pinned libjpeg-turbo, so the JPEG output matches the mac binary for the same quality.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zjxl/src/decode.cc nativelibs/zjxl/__tests__/decode.test.js
git commit -m "zjxl: jxlToJpeg + jxlToJpegFromLocalPath (libjxl 0.9.3 decode -> turbojpeg)"
```

---

## Task 6: `bitmapToJxl` (encode — outgoing images must be peer-decodable)

**Files:**
- Modify: `nativelibs/zjxl/src/encode.cc`
- Test: `nativelibs/zjxl/__tests__/encode.test.js`

**Interfaces:**
- Consumes: `common.h`, `re_params.h` (`kEncodeDistance`, `kEncodeLossless`, `kEncodeEffort`, `kEncodeBitsPerSample`, `kEncodeAlpha`); libjxl `jxl/encode.h`.
- Produces: `bitmapToJxl({buffer, width, height}, cb)` → `cb(null, Buffer(jxl), 0)`; registered as `bitmapToJxl`. Input `buffer` is raw interleaved pixels; channel count derived from `buffer.length / (width*height)` (3=RGB, 4=RGBA), consistent with `kEncodeAlpha`.

- [ ] **Step 1: Write the failing test (round-trip: encode then decode back)**

```js
const path = require('path'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const W = 4, H = 4, ch = 4;                 // RGBA gradient
const bmp = Buffer.alloc(W * H * ch);
for (let i = 0; i < W * H; i++) { bmp[i*4]=i*10; bmp[i*4+1]=i*5; bmp[i*4+2]=255-i*10; bmp[i*4+3]=255; }
addon.bitmapToJxl({ buffer: bmp, width: W, height: H }, (err, jxl, status) => {
  assert.ifError(err); assert.strictEqual(status, 0);
  assert(Buffer.isBuffer(jxl) && jxl[0] === 0xFF && jxl[1] === 0x0A, 'JXL codestream signature');
  addon.getJxlInfo({ buffer: jxl }, (e2, info) => {
    assert.ifError(e2); assert.strictEqual(info.width, W); assert.strictEqual(info.height, H);
    console.log('OK bitmapToJxl', jxl.length, 'bytes');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/encode.test.js`
Expected: FAIL — `bitmapToJxl is not a function`.

- [ ] **Step 3: Implement encode in `src/encode.cc`**

```cpp
#include <napi.h>
#include <jxl/encode.h>
#include <jxl/resizable_parallel_runner.h>
#include "common.h"
#include "re_params.h"

namespace zjxl {

static bool EncodeJxl(const std::vector<uint8_t>& px, uint32_t w, uint32_t h, uint32_t channels,
                      std::vector<uint8_t>& out) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  void* runner = JxlResizableParallelRunnerCreate(nullptr);
  JxlResizableParallelRunnerSetThreads(runner, JxlResizableParallelRunnerSuggestThreads(w, h));
  JxlEncoderSetParallelRunner(enc, JxlResizableParallelRunner, runner);

  JxlBasicInfo bi; JxlEncoderInitBasicInfo(&bi);
  bi.xsize = w; bi.ysize = h;
  bi.bits_per_sample = zjxl_re::kEncodeBitsPerSample;
  bi.num_color_channels = 3;
  bool alpha = channels == 4;
  bi.num_extra_channels = alpha ? 1 : 0;
  bi.alpha_bits = alpha ? zjxl_re::kEncodeBitsPerSample : 0;
  bi.uses_original_profile = zjxl_re::kEncodeLossless ? JXL_TRUE : JXL_FALSE;
  bool ok = JxlEncoderSetBasicInfo(enc, &bi) == JXL_ENC_SUCCESS;

  JxlColorEncoding color; JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  ok = ok && JxlEncoderSetColorEncoding(enc, &color) == JXL_ENC_SUCCESS;

  JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, nullptr);
  JxlEncoderSetFrameLossless(fs, zjxl_re::kEncodeLossless ? JXL_TRUE : JXL_FALSE);
  JxlEncoderSetFrameDistance(fs, zjxl_re::kEncodeDistance);
  JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT, zjxl_re::kEncodeEffort);

  JxlPixelFormat fmt{channels, JXL_TYPE_UINT8, JXL_LITTLE_ENDIAN, 0};
  ok = ok && JxlEncoderAddImageFrame(fs, &fmt, px.data(), px.size()) == JXL_ENC_SUCCESS;
  JxlEncoderCloseInput(enc);

  if (ok) {
    out.clear(); out.resize(64 * 1024);
    uint8_t* next = out.data(); size_t avail = out.size();
    JxlEncoderStatus st = JXL_ENC_NEED_MORE_OUTPUT;
    while (st == JXL_ENC_NEED_MORE_OUTPUT) {
      st = JxlEncoderProcessOutput(enc, &next, &avail);
      if (st == JXL_ENC_NEED_MORE_OUTPUT) {
        size_t used = out.size() - avail;
        out.resize(out.size() * 2);
        next = out.data() + used; avail = out.size() - used;
      }
    }
    ok = st == JXL_ENC_SUCCESS;
    if (ok) out.resize(out.size() - avail);
  }
  JxlResizableParallelRunnerDestroy(runner);
  JxlEncoderDestroy(enc);
  return ok;
}

class EncodeWorker : public Napi::AsyncWorker {
 public:
  EncodeWorker(Napi::Function cb, std::vector<uint8_t> px, uint32_t w, uint32_t h, uint32_t ch)
      : Napi::AsyncWorker(cb), px_(std::move(px)), w_(w), h_(h), ch_(ch) {}
  void Execute() override { if (!EncodeJxl(px_, w_, h_, ch_, out_)) { SetError("bitmapToJxl: encode failed"); } }
  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(), Napi::Buffer<uint8_t>::Copy(env, out_.data(), out_.size()), Napi::Number::New(env, OK)});
  }
  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_ENCODE)});
  }
 private:
  std::vector<uint8_t> px_, out_; uint32_t w_, h_, ch_;
};

static Napi::Value BitmapToJxl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> px;
  try { px = GetBuffer(opts, "buffer"); }
  catch (const Napi::Error& e) { cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  uint32_t w = (uint32_t)GetInt(opts, "width", 0), h = (uint32_t)GetInt(opts, "height", 0);
  if (!w || !h || px.size() % ((size_t)w * h) != 0) {
    cb.Call({Napi::String::New(env, "bitmapToJxl: bad dimensions"), env.Null(), Napi::Number::New(env, ERR_INPUT)});
    return env.Undefined();
  }
  uint32_t ch = (uint32_t)(px.size() / ((size_t)w * h));   // 3 or 4
  (new EncodeWorker(cb, std::move(px), w, h, ch))->Queue();
  return env.Undefined();
}

void RegisterEncode(Napi::Env env, Napi::Object exports) {
  exports.Set("bitmapToJxl", Napi::Function::New(env, BitmapToJxl));
}
}  // namespace zjxl
```

- [ ] **Step 4: Rebuild + run round-trip test**

Run: `node nativelibs/builder.js nativelibs/zjxl && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/encode.test.js`
Expected: `OK bitmapToJxl <N> bytes`.

- [ ] **Step 5: Verify encode params match the mac binary**

Decode the encoded JXL with the pinned `jxlinfo` and confirm the header fields (bit depth, alpha, color) match a real Zalo JXL of the same kind, and that the frame distance/effort we set equal the values in `RE-PARAMS.md`. Peer-decodability check: the produced JXL must decode cleanly with `djxl`:
```bash
PREFIX=$(node nativelibs/zjxl/scripts/deps-hash.js)
node -e "const a=require('./nativelibs/zjxl/build/Release/jxl.node');/* encode a known bitmap, write /tmp/enc.jxl */" # or reuse test output
LD_LIBRARY_PATH="$PREFIX/lib" "$PREFIX/bin/djxl" /tmp/enc.jxl /tmp/enc.png && echo "peer-decodable"
```
Expected: `peer-decodable`. If distance/effort recovery in Task 2 was marked `assumed`, tighten it here by comparing byte size/PSNR against a real Zalo JXL encoded from the same source pixels.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zjxl/src/encode.cc nativelibs/zjxl/__tests__/encode.test.js
git commit -m "zjxl: bitmapToJxl (libjxl 0.9.3 encode with RE'd distance/effort/lossless)"
```

---

## Task 7: `resizeJxl` + `resizeJxlLimit` (decode → OpenCV resize → re-encode)

**Files:**
- Modify: `nativelibs/zjxl/src/resize.cc`
- Test: `nativelibs/zjxl/__tests__/resize.test.js`

**Interfaces:**
- Consumes: `common.h`, `re_params.h` (`kResizeInterp`, `kResizeReencodeDist`, `kResizeReencodeEffort`); the decode helper `DecodeToRgb` and encode helper `EncodeJxl`. To reuse them, declare them in `common.h` and give them external linkage (move the two static helpers to non-static, declared in `common.h`).
- Produces: `resizeJxl({buffer, width, height}, cb)` → `cb(null, Buffer(jxl), 0)`; `resizeJxlLimit({buffer, width, height, limit}, cb)` — same but iteratively raises distance until output ≤ `limit` bytes. Registered as `resizeJxl`, `resizeJxlLimit`.

- [ ] **Step 1: Promote shared helpers to external linkage**

In `common.h` add declarations:
```cpp
namespace zjxl {
bool DecodeToRgb(const std::vector<uint8_t>& in, std::vector<uint8_t>& rgb, uint32_t& w, uint32_t& h);
bool EncodeJxl(const std::vector<uint8_t>& px, uint32_t w, uint32_t h, uint32_t channels,
               std::vector<uint8_t>& out, float distance, int effort, bool lossless,
               int bitsPerSample);
}
```
Refactor `decode.cc`/`encode.cc`: remove `static` from `DecodeToRgb`/`EncodeJxl`, and change `EncodeJxl` to take `(distance, effort, lossless, bitsPerSample)` params (the callers in Tasks 6/7 pass their own constants). Update `EncodeWorker` in `encode.cc` to pass `zjxl_re::kEncodeDistance, kEncodeEffort, kEncodeLossless, kEncodeBitsPerSample`. Re-run Tasks 5 & 6 tests to confirm no regression.

- [ ] **Step 2: Write the failing test**

```js
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');
const jxl = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.jxl'))));
addon.resizeJxl({ buffer: jxl, width: 64, height: 64 }, (err, data, status) => {
  assert.ifError(err); assert.strictEqual(status, 0);
  assert(Buffer.isBuffer(data) && data[0] === 0xFF && data[1] === 0x0A, 'JXL out');
  addon.getJxlInfo({ buffer: data }, (e2, info) => {
    assert.ifError(e2); assert(info.width <= 64 && info.height <= 64, 'resized down');
    console.log('OK resizeJxl ->', info.width + 'x' + info.height);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/resize.test.js`
Expected: FAIL — `resizeJxl is not a function`.

- [ ] **Step 4: Implement resize in `src/resize.cc`**

```cpp
#include <napi.h>
#include <opencv2/imgproc.hpp>
#include <opencv2/core.hpp>
#include "common.h"
#include "re_params.h"

namespace zjxl {

// Decode -> OpenCV resize (preserving aspect within target box) -> re-encode.
static bool ResizeCore(const std::vector<uint8_t>& in, int targetW, int targetH,
                       std::vector<uint8_t>& out, float distance) {
  std::vector<uint8_t> rgb; uint32_t w = 0, h = 0;
  if (!DecodeToRgb(in, rgb, w, h)) return false;
  // Fit within the target box, preserving aspect (matches Zalo's shouldResize semantics;
  // confirm exact rounding in RE-PARAMS.md Task 2).
  double scale = std::min((double)targetW / w, (double)targetH / h);
  if (scale >= 1.0) scale = 1.0;
  int nw = std::max(1, (int)std::lround(w * scale));
  int nh = std::max(1, (int)std::lround(h * scale));
  cv::Mat src((int)h, (int)w, CV_8UC3, rgb.data());
  cv::Mat dst;
  cv::resize(src, dst, cv::Size(nw, nh), 0, 0, zjxl_re::kResizeInterp);
  std::vector<uint8_t> px(dst.data, dst.data + (size_t)dst.total() * dst.elemSize());
  return EncodeJxl(px, (uint32_t)nw, (uint32_t)nh, 3, out, distance,
                   zjxl_re::kResizeReencodeEffort, false, zjxl_re::kEncodeBitsPerSample);
}

class ResizeWorker : public Napi::AsyncWorker {
 public:
  ResizeWorker(Napi::Function cb, std::vector<uint8_t> in, int w, int h, long limit)
      : Napi::AsyncWorker(cb), in_(std::move(in)), w_(w), h_(h), limit_(limit) {}
  void Execute() override {
    float dist = zjxl_re::kResizeReencodeDist;
    if (!ResizeCore(in_, w_, h_, out_, dist)) { SetError("resizeJxl: failed"); return; }
    // resizeJxlLimit: raise distance until under the byte limit (bounded iterations).
    for (int i = 0; limit_ > 0 && (long)out_.size() > limit_ && dist < 15.0f && i < 8; i++) {
      dist += 1.0f; std::vector<uint8_t> next;
      if (!ResizeCore(in_, w_, h_, next, dist)) break;
      out_.swap(next);
    }
  }
  void OnOK() override {
    Napi::Env env = Env();
    Callback().Call({env.Null(), Napi::Buffer<uint8_t>::Copy(env, out_.data(), out_.size()), Napi::Number::New(env, OK)});
  }
  void OnError(const Napi::Error& e) override {
    Napi::Env env = Env();
    Callback().Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_RESIZE)});
  }
 private:
  std::vector<uint8_t> in_, out_; int w_, h_; long limit_;
};

static Napi::Value ResizeImpl(const Napi::CallbackInfo& info, bool withLimit) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  std::vector<uint8_t> in;
  try { in = GetBuffer(opts, "buffer"); }
  catch (const Napi::Error& e) { cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  int w = GetInt(opts, "width", 0), h = GetInt(opts, "height", 0);
  long limit = withLimit ? (long)GetInt(opts, "limit", 0) : 0;
  if (w <= 0 || h <= 0) { cb.Call({Napi::String::New(env, "resizeJxl: bad size"), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  (new ResizeWorker(cb, std::move(in), w, h, limit))->Queue();
  return env.Undefined();
}

void RegisterResize(Napi::Env env, Napi::Object exports) {
  exports.Set("resizeJxl", Napi::Function::New(env, [](const Napi::CallbackInfo& i){ return ResizeImpl(i, false); }));
  exports.Set("resizeJxlLimit", Napi::Function::New(env, [](const Napi::CallbackInfo& i){ return ResizeImpl(i, true); }));
}
}  // namespace zjxl
```

- [ ] **Step 5: Rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zjxl && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/resize.test.js`
Expected: `OK resizeJxl -> <=64x<=64`. Add a `resizeJxlLimit` case asserting `data.length <= limit` for a generous limit.

- [ ] **Step 6: Reconcile resize semantics with RE-PARAMS.md**

If Task 2 recovered a specific `shouldResize` rule (e.g. only resize when both dims exceed target, or a different rounding) or a different `INTER_*`, adjust `ResizeCore` and re-test.

- [ ] **Step 7: Commit**

```bash
git add nativelibs/zjxl/src/resize.cc nativelibs/zjxl/src/common.h nativelibs/zjxl/src/decode.cc nativelibs/zjxl/src/encode.cc nativelibs/zjxl/__tests__/resize.test.js
git commit -m "zjxl: resizeJxl + resizeJxlLimit (libjxl decode -> OpenCV resize -> re-encode)"
```

---

## Task 8: `jxlDecompressMulti` (batch decode)

**Files:**
- Modify: `nativelibs/zjxl/src/multi.cc`
- Test: `nativelibs/zjxl/__tests__/multi.test.js`

**Interfaces:**
- Consumes: `common.h`, `DecodeToRgb`, `RgbToJpeg` (promote `RgbToJpeg` to external linkage in `common.h` like `DecodeToRgb`); the exact `options`/output shape from `RE-PARAMS.md` Task 2 (`jxlDecompressMultiHandler` / `JxlDecompressMultiInfo` / `JxlDecompressMultiOutput`).
- Produces: `jxlDecompressMulti(options, cb)` → `cb(null, resultArray, 0)` where each element mirrors the mac output element shape. Registered as `jxlDecompressMulti`.

- [ ] **Step 1: Nail the contract from RE + call sites**

Run:
```bash
grep -rn "jxlDecompressMulti" app/main-dist app/pc-dist 2>/dev/null | head
r2 -q -c 'aa; s sym._Z18jxlDecompressMultiRKN4Napi12CallbackInfoE; pdf' \
  app/native/nativelibs/zjxl/build/darwin_x64/jxl.node 2>/dev/null | grep -iE 'Get |String|Array|buffer|path|width|height'
```
Record in `RE-PARAMS.md`: the input `options` keys (likely `{ items: [{buffer|path, ...}], ... }`) and each output element's keys. If there are **zero** renderer/main-dist call sites, implement a minimal faithful version (decode each item → jpeg) and note it is untested against live usage.

- [ ] **Step 2: Write the failing test** (shape per Step 1; example assuming `{ items:[{buffer}] }` → array of `{data,status_code}`):

```js
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');
const b = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.jxl'))));
addon.jxlDecompressMulti({ items: [{ buffer: b }, { buffer: b }] }, (err, data, status) => {
  assert.ifError(err); assert.strictEqual(status, 0);
  assert(Array.isArray(data) && data.length === 2, 'two results');
  assert(Buffer.isBuffer(data[0].data), 'element has jpeg buffer');
  console.log('OK jxlDecompressMulti');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/multi.test.js`
Expected: FAIL — `jxlDecompressMulti is not a function`.

- [ ] **Step 4: Implement in `src/multi.cc`** (adjust keys to the Step 1 contract):

```cpp
#include <napi.h>
#include "common.h"

namespace zjxl {

class MultiWorker : public Napi::AsyncWorker {
 public:
  MultiWorker(Napi::Function cb, std::vector<std::vector<uint8_t>> items, int quality)
      : Napi::AsyncWorker(cb), items_(std::move(items)), quality_(quality) {}
  void Execute() override {
    for (auto& in : items_) {
      std::vector<uint8_t> rgb, jpeg; uint32_t w = 0, h = 0;
      if (DecodeToRgb(in, rgb, w, h) && RgbToJpeg(rgb, w, h, quality_, jpeg)) results_.push_back(std::move(jpeg));
      else results_.emplace_back();  // empty marks a per-item failure
    }
  }
  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array arr = Napi::Array::New(env, results_.size());
    for (size_t i = 0; i < results_.size(); i++) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("data", Napi::Buffer<uint8_t>::Copy(env, results_[i].data(), results_[i].size()));
      o.Set("status_code", Napi::Number::New(env, results_[i].empty() ? ERR_DECODE : OK));
      arr.Set(i, o);
    }
    Callback().Call({env.Null(), arr, Napi::Number::New(env, OK)});
  }
 private:
  std::vector<std::vector<uint8_t>> items_, results_;
  int quality_;
};

static Napi::Value JxlDecompressMulti(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function cb = info[1].As<Napi::Function>();
  Napi::Value itemsV = opts.Get("items");
  if (!itemsV.IsArray()) { cb.Call({Napi::String::New(env, "jxlDecompressMulti: items must be an array"), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  Napi::Array items = itemsV.As<Napi::Array>();
  std::vector<std::vector<uint8_t>> in;
  for (uint32_t i = 0; i < items.Length(); i++) {
    Napi::Object it = items.Get(i).As<Napi::Object>();
    try { in.push_back(GetBuffer(it, "buffer")); }
    catch (const Napi::Error& e) { cb.Call({e.Value(), env.Null(), Napi::Number::New(env, ERR_INPUT)}); return env.Undefined(); }
  }
  int quality = GetInt(opts, "quality", 90);
  (new MultiWorker(cb, std::move(in), quality))->Queue();
  return env.Undefined();
}

void RegisterMulti(Napi::Env env, Napi::Object exports) {
  exports.Set("jxlDecompressMulti", Napi::Function::New(env, JxlDecompressMulti));
}
}  // namespace zjxl
```
(Also promote `RgbToJpeg` to external linkage: remove `static` in `decode.cc`, declare it in `common.h`.)

- [ ] **Step 5: Rebuild + run**

Run: `node nativelibs/builder.js nativelibs/zjxl && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/multi.test.js`
Expected: `OK jxlDecompressMulti`.

- [ ] **Step 6: Commit**

```bash
git add nativelibs/zjxl/src/multi.cc nativelibs/zjxl/src/common.h nativelibs/zjxl/src/decode.cc nativelibs/zjxl/__tests__/multi.test.js
git commit -m "zjxl: jxlDecompressMulti (batch decode -> jpeg)"
```

---

## Task 9: `patch-zjxl.js` — build, bundle `.so`, splice `index.js`

**Files:**
- Create: `scripts/patches/patch-zjxl.js`
- Test: `scripts/patches/__tests__/patch-zjxl.test.js`

**Interfaces:**
- Consumes: `nativelibs/builder.js`, `build-deps.sh`, `deps-hash.js`; the runtime `app/native/nativelibs/zjxl/index.js` (extracted by SETUP).
- Produces: `require('./patch-zjxl.js').main()` builds the addon, copies `jxl.node` + the bundled `.so` set into `app/native/nativelibs/zjxl/build/linux_x64/`, sets `RPATH=$ORIGIN`, and splices a `linux` branch into `index.js`. Fail-loud on anchor drift; idempotent.

- [ ] **Step 1: Write the failing test** (splice + idempotency, using a stub `index.js`):

Create `scripts/patches/__tests__/patch-zjxl.test.js`:
```js
const fs = require('fs-extra'), path = require('path'), os = require('os'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zjxl-'));
const idx = path.join(tmp, 'index.js');
// Minimal replica of the real getLib() branch we splice into.
fs.writeFileSync(idx,
  "function getLib(){let nodeAddon=null;\n" +
  "  if(process.platform==='win32'){nodeAddon=require('./build/win32_ia32/jxl.node');}\n" +
  "  else if(process.platform==='darwin'){nodeAddon=require('./build/darwin_x64/jxl.node');}\n" +
  "  else {\n    return { error: 'not support' };\n  }\n return {};}\nmodule.exports=getLib();");
const { spliceLinuxBranch } = require('../patch-zjxl.js');
spliceLinuxBranch(idx);
let c = fs.readFileSync(idx, 'utf8');
assert(c.includes("process.platform === 'linux'"), 'linux branch inserted');
assert(c.includes("require('./build/linux_x64/jxl.node')"), 'linux require inserted');
spliceLinuxBranch(idx);            // idempotent
assert.strictEqual(fs.readFileSync(idx, 'utf8'), c, 'second splice is a no-op');
fs.removeSync(tmp);
console.log('OK patch-zjxl splice');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/patches/__tests__/patch-zjxl.test.js`
Expected: FAIL — `Cannot find module '../patch-zjxl.js'`.

- [ ] **Step 3: Write `patch-zjxl.js`**

```js
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'zjxl');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'build', 'linux_x64');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'index.js');

// The mac bundle ships these dylibs; we bundle the Linux .so equivalents next to
// the addon so RPATH=$ORIGIN loads the pinned builds, not system libs.
const BUNDLE_SONAMES = [
  'libjxl.so.0.9', 'libjxl_threads.so.0.9', 'libjxl_cms.so.0.9', 'libjxl_dec.so.0.9',
  'libturbojpeg.so.0', 'libjpeg.so.62', 'libhwy.so.1', 'libbrotlicommon.so.1',
  'libbrotlidec.so.1', 'libbrotlienc.so.1', 'libopencv_core.so.412', 'libopencv_imgproc.so.412',
];

// Splice the linux branch into the `else { return { error: 'not support' } }` block.
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("require('./build/linux_x64/jxl.node')")) return; // idempotent
  const anchor = "} else {\n    return { error: 'not support' };\n  }";
  if (!c.includes(anchor)) {
    throw new Error("patch-zjxl: 'not support' anchor not found in index.js — bundle format changed, update the splice");
  }
  const replacement =
    "} else if (process.platform === 'linux') {\n" +
    "    nodeAddon = require('./build/linux_x64/jxl.node');\n" +
    "  } else {\n    return { error: 'not support' };\n  }";
  fs.writeFileSync(indexPath, c.replace(anchor, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) throw new Error(`zjxl source missing at ${LIB_DIR}`);

  // 1. Heavy deps (cache hit after first build).
  logger.info('Ensuring zjxl deps-prefix...');
  execSync(`bash "${path.join(LIB_DIR, 'scripts', 'build-deps.sh')}"`, { cwd: LIB_DIR, stdio: 'inherit' });
  const prefix = execSync(`node "${path.join(LIB_DIR, 'scripts', 'deps-hash.js')}"`, { cwd: LIB_DIR }).toString().trim();

  // 2. Addon (rebuilt every patch, like db-cross-v4).
  logger.info('Building zjxl addon...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  const releaseNode = path.join(LIB_DIR, 'build', 'Release', 'jxl.node');
  if (!fs.existsSync(releaseNode)) throw new Error('zjxl build produced no jxl.node');

  // 3. Bundle .node + .so into linux_x64/ (mirror mac layout).
  fs.ensureDirSync(DEST_DIR);
  fs.copyFileSync(releaseNode, path.join(DEST_DIR, 'jxl.node'));
  const libDir = path.join(prefix, 'lib');
  for (const soname of BUNDLE_SONAMES) {
    const src = path.join(libDir, soname);
    if (!fs.existsSync(src)) throw new Error(`patch-zjxl: expected bundled lib missing: ${src}`);
    fs.copyFileSync(src, path.join(DEST_DIR, soname));
  }
  // Ensure the addon resolves siblings first.
  execSync(`patchelf --set-rpath '$ORIGIN' "${path.join(DEST_DIR, 'jxl.node')}"`, { stdio: 'inherit' });

  // 4. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error(`zjxl/index.js not found — did extraction overlay app.asar.unpacked?`);
  spliceLinuxBranch(INDEX_JS);

  // 5. Post-conditions (fail loud).
  const outNode = path.join(DEST_DIR, 'jxl.node');
  if (!fs.existsSync(outNode) || fs.statSync(outNode).size === 0) throw new Error('patch-zjxl: jxl.node missing/empty');
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("require('./build/linux_x64/jxl.node')")) {
    throw new Error('patch-zjxl: linux require not present in index.js after splice');
  }
  logger.success('zjxl installed');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
```

- [ ] **Step 4: Run the splice test — verify it passes**

Run: `node scripts/patches/__tests__/patch-zjxl.test.js`
Expected: `OK patch-zjxl splice`.

- [ ] **Step 5: Verify `patchelf` is available (add to deps if missing)**

Run: `command -v patchelf || sudo apt-get install -y patchelf`
Expected: a path. (CI apt list updated in Task 11.)

- [ ] **Step 6: Commit**

```bash
git add scripts/patches/patch-zjxl.js scripts/patches/__tests__/patch-zjxl.test.js
git commit -m "zjxl: patch-zjxl.js (build + bundle .so + RPATH + splice index.js)"
```

---

## Task 10: Register in orchestrator + full fresh SETUP + smoke (images render)

**Files:**
- Modify: `scripts/main.js`
- Test: fresh SETUP + XDG-isolated smoke boot (manual/scripted verification)

**Interfaces:**
- Consumes: `patch-zjxl.main` (Task 9).
- Produces: SETUP runs `patch-zjxl` after `patch-v8-profiles`; a fresh `app/` where `zjxl/index.js` loads the linux addon and chat JXL images render.

- [ ] **Step 1: Register the patch in `scripts/main.js`**

After the `patch-v8-profiles` line, add:
```js
      await require('./patches/patch-zjxl.js').main();
```
And extend the patch-order comment block:
```js
      //      zjxl          : build native JPEG-XL addon (pinned libjxl 0.9.3 + OpenCV
      //                      4.12) + bundle .so + splice linux branch (images render)
```

- [ ] **Step 2: Clean and run a full fresh SETUP**

Run:
```bash
rm -rf app
ZALO_DMG=/mnt/data/Work/zalo-linux/ZaloSetup-universal-26.6.11.dmg npm run setup
```
Expected: SETUP completes; log shows `zjxl installed`; the following all pass:
```bash
ls app/native/nativelibs/zjxl/build/linux_x64/jxl.node
readelf -d app/native/nativelibs/zjxl/build/linux_x64/jxl.node | grep -E 'RUNPATH|RPATH'   # -> $ORIGIN
grep -c "require('./build/linux_x64/jxl.node')" app/native/nativelibs/zjxl/index.js         # -> 1
```

- [ ] **Step 3: Verify the addon loads inside the real app tree**

Run:
```bash
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e "const z=require('./app/native/nativelibs/zjxl/index.js'); console.log('has decodeToJpeg:', typeof z.decodeToJpeg==='function'); z.getJxlInfo(require('fs').readFileSync(process.argv[1])).then(i=>{console.log('info',i);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});" scratchpad/jxl-samples/$(ls scratchpad/jxl-samples | head -1)
```
Expected: `has decodeToJpeg: true` and a printed `{width,height,...}` — proving `index.js` no longer returns `{error:'not support'}` on Linux.

- [ ] **Step 4: Smoke boot under XDG isolation — confirm images render**

Run the project's isolated smoke (XDG_* → temp dir, durable status file), open a conversation containing JXL images, and confirm they display (not broken-image). Reuse the existing smoke harness; assert `SMOKE_OK` and no `zjxl`/`decodeToJpeg` errors in the captured log.
Expected: `SMOKE_OK`; a real chat image renders.

- [ ] **Step 5: Commit**

```bash
git add scripts/main.js
git commit -m "zjxl: register patch-zjxl in SETUP orchestrator (after v8-profiles)"
```

---

## Task 11: `.deb` packaging + CI build-time deps

**Files:**
- Modify: `.github/workflows/build.yml`
- Test: `.deb` build bundles the zjxl `.so` set

**Interfaces:**
- Consumes: the full SETUP (Task 10).
- Produces: CI installs `cmake nasm ninja-build patchelf` (+ existing deps); `npm run main` builds the `.deb` with the zjxl `.so` set bundled under `resources/app/native/nativelibs/zjxl/build/linux_x64/`.

- [ ] **Step 1: Add build-time deps to CI**

In `.github/workflows/build.yml`, extend the `apt-get install` list:
```yaml
            p7zip-full build-essential libssl-dev liblzma-dev libsqlcipher-dev \
            dpkg fakeroot cmake nasm ninja-build patchelf git curl
```

- [ ] **Step 2: Confirm no new runtime `.deb` Depends is required**

Run (after a local SETUP):
```bash
ldd app/native/nativelibs/zjxl/build/linux_x64/jxl.node | grep -iE 'not found'
```
Expected: no `not found` lines — all libjxl/opencv deps resolve to the bundled `$ORIGIN` `.so`. If a residual system lib appears (e.g. `libstdc++`, `libgomp`), confirm it is already covered by the base Electron/`.deb` Depends; only add to `build.deb.depends` if genuinely missing on a clean Ubuntu.

- [ ] **Step 3: Build the `.deb` and verify the bundle**

Run:
```bash
rm -rf app dist
ZALO_DMG=/mnt/data/Work/zalo-linux/ZaloSetup-universal-26.6.11.dmg npm run main
DEB=$(ls dist/*.deb | head -1)
dpkg-deb -c "$DEB" | grep -E 'zjxl/build/linux_x64/(jxl\.node|libjxl\.so|libopencv_core\.so)'
```
Expected: the `.deb` listing includes `jxl.node` and the bundled `.so` set under the zjxl `linux_x64` path.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "zjxl: CI build-time deps (cmake/nasm/ninja/patchelf) for pinned libjxl/opencv build"
```

---

## Self-Review

**Spec coverage:**
- §2 JS surface + native methods → Tasks 4–8 (all 8 methods) + Task 3 (scaffold). ✓
- §3 pinned versions → Task 1 (`deps-hash.js` PINS + `build-deps.sh`), Global Constraints. ✓
- §4 build model (addon each patch + deps-prefix cache) → Task 1 + Task 9. ✓
- §5 param recovery → Task 2 (`re_params.h` + `RE-PARAMS.md`), consumed by Tasks 5–8. ✓
- §6 verification (real JXL + oracle) → Task 5 Step 5 (decode vs `djxl`), Task 6 Step 5 (peer-decodable), Task 10 Step 4 (smoke images render). ✓
- §7 patch integration → Task 9 + Task 10. ✓
- §8 `.deb`/CI + dynamic `.so` bundle mirroring mac → Task 9 (`BUNDLE_SONAMES`, RPATH) + Task 11. ✓
- §9 out of scope (x64, no byte-identical binary) → Global Constraints. ✓
- §10 success criteria → Task 10 Steps 2–4 + Task 11 Step 3. ✓

**Placeholder scan:** the only intentional "fill from RE" values live in `re_params.h` (Task 2), which is a *produced interface* consumed by later tasks via named constants — not an unresolved plan placeholder. `<sample>` in shell snippets is resolved by `ls scratchpad/jxl-samples | head -1`.

**Type consistency:** `DecodeToRgb(in, rgb, w, h)`, `RgbToJpeg(rgb, w, h, quality, jpeg)`, `EncodeJxl(px, w, h, channels, out, distance, effort, lossless, bitsPerSample)` are declared in `common.h` (Task 7 Step 1, Task 8 Step 4) and used identically in Tasks 5–8. Registrar names `RegisterInfo/Decode/Encode/Resize/Multi` match `zjxl.cc` (Task 3). `spliceLinuxBranch` exported and consumed by its test (Task 9). Constant names in `re_params.h` (Task 2) match their uses in Tasks 5–7.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-zjxl-linux-native-re.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
