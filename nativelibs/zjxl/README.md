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
- libjpeg-turbo 3.0.2
- OpenCV 4.12.0 (core + imgproc)

Flags: `x64-relwithdebinfo-cxx17-shared-jxl-static-hwy` (see `PINS` in
`scripts/deps-hash.js`).

## Exported methods

`build/Release/jxl.node` exports (via `Init()` in `src/zjxl.cc`, one `Register*` per
source file):

- `moduleReady` (`src/zjxl.cc`) — sanity check, returns `true`.
- `getJxlInfo` (`src/info.cc`)
- `jxlToJpeg`, `jxlToJpegFromLocalPath` (`src/decode.cc`)
- `bitmapToJxl` (`src/encode.cc`)
- `resizeJxl`, `resizeJxlLimit` (`src/resize.cc`)
- `jxlDecompressMulti` (`src/multi.cc`)

As of this task only `moduleReady` is wired up; the `Register*` functions in
`info.cc`/`decode.cc`/`encode.cc`/`resize.cc`/`multi.cc` are empty stubs that later
tasks fill in.

## Build

```bash
bash scripts/build-deps.sh                 # builds/caches the pinned deps prefix
node ../builder.js .                       # from nativelibs/zjxl: node ../builder.js .
# or from repo root:
node nativelibs/builder.js nativelibs/zjxl
```

Produces `build/Release/jxl.node`, linked with `-Wl,-rpath,'$ORIGIN'` so it can find
bundled `.so`s placed alongside it (wired up in a later bundling task).

## Test

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zjxl/__tests__/moduleReady.test.js
```
