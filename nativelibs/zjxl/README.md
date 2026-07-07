# zjxl (native, Linux)

Native JPEG-XL codec addon for Zalo's `native/nativelibs/zjxl`, reimplemented from
scratch for Linux x64 against the Electron 22.3.x ABI, using N-API (`node-addon-api`)
so the addon is ABI-stable across Electron point releases.

**Attribution:** this is a clean-room reimplementation, not a copy of upstream Zalo
source (none was available for Linux). The only artifact consulted was the shipped
macOS `jxl.node` binary (`app/native/nativelibs/zjxl/build/darwin_x64/jxl.node`,
x86_64 Mach-O with C++ symbols intact), disassembled with radare2 to recover the exact
encode/decode/resize parameters needed for byte-for-byte compatible output — see
`RE-PARAMS.md` for every constant traced to a binary address + disassembly snippet,
and `src/re_params.h` for the resulting single source of truth. No Zalo source code
was used or referenced.

## Pinned dependency versions

Built against the content-addressed prefix in `.deps-prefix/<hash>` (see
`scripts/deps-hash.js` / `scripts/build-deps.sh`, Task 1):

- libjxl 0.9.3 (static Highway, shared libjxl/libjxl_threads)
- highway 1.0.7
- brotli 1.0.9
- libjpeg-turbo 3.1.1
- OpenCV 4.12.0 (core + imgproc)

Flags: `x64-relwithdebinfo-cxx17-shared-jxl-static-hwy` (see `PINS` in
`scripts/deps-hash.js`).

These are the **exact versions the macOS bundle ships** — matching them is what makes
the encoded/decoded image bytes identical to the original. `libjpeg-turbo 3.1.1` in
particular was pinned after discovering the macOS `libturbojpeg` reports its release
only in an embedded string (its Mach-O version field is the TurboJPEG *API* version
`0.4.0`, not `3.1.1`).

## Exported methods

`build/Release/jxl.node` exports (via `Init()` in `src/zjxl.cc`, one `Register*` per
source file):

- `moduleReady` (`src/zjxl.cc`) — sanity check, returns `true`.
- `getJxlInfo` (`src/info.cc`)
- `jxlToJpeg`, `jxlToJpegFromLocalPath` (`src/decode.cc`)
- `bitmapToJxl` (`src/encode.cc`)
- `resizeJxl`, `resizeJxlLimit` (`src/resize.cc`)
- `jxlDecompressMulti` (`src/multi.cc`)

All methods are implemented. The JS the app calls (`decodeToJpeg`, `bitmapToJxl`,
`getJxlInfo`, `resizeJxl`, `resizeJxlLimit`, `jxlDecompressMulti`, `moduleReady`) is
Zalo's own `index.js` wrapper, which `patch-zjxl.js` splices a `linux` branch into so it
loads `build/linux_x64/jxl.node` on Linux.

RE fidelity highlights (all traced in `RE-PARAMS.md`):
- **`jxlToJpeg`**: libjxl decode → turbojpeg **baseline + fast-DCT + 4:2:0**, embedding
  the source JXL's ICC profile; quality = JS `0..1` float ×100 truncated. Byte-identical
  to `djxl` on decode.
- **`bitmapToJxl`**: libjxl encode, distance 2.28 / effort 1 / decoding-speed 4 / sRGB /
  3-channel (no alpha).
- **`resizeJxl`**: hand-rolled single-pass **bilinear** + truncating `clampSize`
  (disassembled byte-for-byte) — **not** OpenCV.
- **`jxlDecompressMulti`**: batch decode → **OpenCV two-stage** resize (INTER_LINEAR to a
  1000px cap, then INTER_AREA) → JPEG. (`resizeJxlLimit` has no symbol in the macOS
  binary — implemented as a documented `assumed` faithful extension.)

## Build

```bash
bash scripts/build-deps.sh                 # builds/caches the pinned deps prefix (once, ~20–40 min)
node ../builder.js .                       # from nativelibs/zjxl: node ../builder.js .
# or from repo root:
node nativelibs/builder.js nativelibs/zjxl
```

Two-layer build:
- **Heavy deps** (libjxl, OpenCV, …) → built once from pinned source into the
  content-addressed cache `.deps-prefix/<hash>/` (`<hash>` = hash of the pins + flags in
  `scripts/deps-hash.js`). Reused on every later build; only a pin/flag change (new
  `<hash>`) triggers a from-source rebuild.
- **The addon** (`jxl.node`) → rebuilt from `src/*.cc` on every build (fast), linked with
  `-Wl,-rpath,'$ORIGIN'`.

`patch-zjxl.js` then bundles `jxl.node` + the recursive `.so` closure (9 libs:
libjxl/libjxl_threads/libjxl_cms.so.0.9, libturbojpeg.so.0, libopencv_core/imgproc.so.412,
libbrotli{dec,enc,common}.so.1 — Highway is static, inside libjxl) into
`app/native/nativelibs/zjxl/build/linux_x64/`, sets `RPATH=$ORIGIN` on all of them so the
bundle is self-contained (no system libjxl/OpenCV needed at runtime), and splices
`index.js`.

## Updating when the macOS build changes versions

Bit-identical output depends on building the **same** library versions Zalo ships. On a
new Zalo build, `npm run setup` runs the drift check (see `../README.md`); if it reports
that `zjxl` pins differ from the mac bundle:

1. Edit `PINS` in `scripts/deps-hash.js` to the versions from the drift report's MAC
   column (this changes `<hash>` → a fresh deps build).
2. If **libjxl** or **libjpeg-turbo** changed, re-verify `RE-PARAMS.md`: encoder params
   and enum ordinals can shift between versions (e.g. the FASTDCT/PROGRESSIVE ordinals,
   the tj3 API). Re-disassemble the new macOS `jxl.node` for any `certain` constant that
   could have moved.
3. `bash scripts/build-deps.sh` (rebuilds the pinned deps, ~20–40 min) then rebuild the
   addon (or just run `npm run setup`).
4. Run the test suite (below) and, once green, refresh the baseline:
   `node ../scripts/check-native-versions.js --update` and commit.

### When to rebuild

| Situation | What rebuilds | How |
|---|---|---|
| `npm run setup` | addon (`.node`) | automatic; deps from cache |
| Edited `src/*.cc` | addon only | `node nativelibs/builder.js nativelibs/zjxl` |
| Changed a `PIN` / build flag | deps prefix (new `<hash>`) + addon | `bash scripts/build-deps.sh` → rebuild addon |
| Electron bump | addon only (N-API is ABI-stable) | automatic on next SETUP |

## Test

```bash
P=$(node nativelibs/zjxl/scripts/deps-hash.js)
for t in moduleReady getJxlInfo decode encode resize multi; do
  LD_LIBRARY_PATH="$P/lib" ELECTRON_RUN_AS_NODE=1 \
    node_modules/.bin/electron nativelibs/zjxl/__tests__/$t.test.js
done
```

(Tests read real JXL samples from `scratchpad/jxl-samples/`, which is gitignored —
personal images, never committed.)
