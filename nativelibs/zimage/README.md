# zimage (native, Linux)

Native image-thumbnail addon for Zalo's `native/nativelibs/zimage`, reimplemented from
scratch for Linux x64 against the Electron 22.3.x ABI, using N-API (`node-addon-api`) so
the addon is ABI-stable across Electron point releases. It wraps libvips (via its C API,
not the C++ `VImage` wrappers — see below) to produce byte-identical thumbnails to the
shipped macOS addon.

**Attribution:** this is a clean-room reimplementation, not a copy of upstream Zalo
source (none was available for Linux). The only artifacts consulted were the shipped
macOS `zimage.node` binary and its bundled `libvips-cpp.42.dylib`
(`app/native/nativelibs/zimage/darwin_x64/`, x86_64 Mach-O, Zalo bundle 26.6.20),
disassembled with radare2 to recover the exact thumbnail/save parameters needed for
byte-for-byte compatible output — see `RE-PARAMS.md` for every constant traced to a
binary address + disassembly snippet, and `src/re_params.h` for the resulting single
source of truth. No Zalo source code was used or referenced.

## Pinned dependency versions

Built against the content-addressed prefix in `.deps-prefix/<hash>` (see
`scripts/deps-hash.js` / `scripts/build-deps.sh`, Task 1):

- libvips 8.14.2 (shared `libvips-cpp.so.42`, codecs statically linked in)
- glib 2.78.4 (**shared** — `libvips.so.42` dynamic-links `libglib-2.0.so.0`/
  `libgobject-2.0.so.0`/`libgio-2.0.so.0`; see "glib must be shared" below)
- expat 2.6.0, zlib 1.3.1, libpng 1.6.39, libspng 0.7.4, libjpeg-turbo 3.0.2,
  libwebp 1.3.2, giflib 5.2.1 (all static)

Backend set currently enabled: `jpeg+png+spng+webp+gif`. The full backend set
(jxl/heif/imagemagick/pdf) is added in Task 6, which will bump the deps-prefix hash.

Flags: `x64-relwithdebinfo-static-codecs-shared-glib-shared-vipscpp` (see `PINS` in
`scripts/deps-hash.js`).

### glib must be shared (not static) — Electron compatibility

glib/gobject/gio are built **shared**, not static. A static glib gets baked into
`libvips.so.42`; when the addon `dlopen()`s under Electron (which already links the
system glib/gobject for GTK), libvips's embedded `gobject_init_ctor` tries to
re-register the fundamental type `gchar` → `cannot register existing type 'gchar'`
→ SIGABRT. Building glib shared means a single glib copy is used at runtime (the
system glib under Electron, resolved by SONAME; the bundled one under plain Node),
so there is no double registration. glib is not a codec, so this has **no effect on
byte-identical image output**. The image codecs (jpeg/png/webp/gif) remain statically
linked into `libvips.so.42`. Verified: `readelf -d libvips.so.42` shows
`libglib-2.0.so.0` NEEDED, and `moduleReady()` loads cleanly under Electron.

Build dirs are per-prefix (`.deps-prefix/<hash>/.build/`) so a hash change always
configures against the correct prefix (avoids cmake/meson caching the old install
prefix).

These are the exact versions the macOS bundle ships (libvips 8.14.2 confirmed via the
dylib's version string); matching them is what makes the produced thumbnail bytes
identical to the original.

## Exported methods

`build/Release/zimage.node` exports (via `Init()` in `src/zimage.cc`):

- `moduleReady` (`src/zimage.cc`) — sanity check, returns `true`; also runs `VIPS_INIT`
  so a successful load proves libvips initialized correctly.
- `RegisterThumbnail` / `src/thumbnail.cc` — **stub** (Task 4 fills in the
  buffer-to-buffer thumbnail method, `vips_thumbnail_buffer`).
- `RegisterThumbnailFs` / `src/thumbnail_fs.cc` — **stub** (Task 5 fills in the
  file-to-file thumbnail method, `vips_thumbnail`).

Per `src/re_params.h`, the mac addon calls the libvips **C API** directly
(`vips_thumbnail_buffer` / `vips_thumbnail` / `vips_jpegsave_buffer` /
`vips_pngsave_buffer`), not the C++ `VImage` wrappers — Tasks 4/5 will follow that same
approach for bit-identical output.

## Build

```bash
bash scripts/build-deps.sh                 # builds/caches the pinned deps prefix (once)
node ../builder.js .                       # from nativelibs/zimage: node ../builder.js .
# or from repo root:
node nativelibs/builder.js nativelibs/zimage
```

Two-layer build:
- **Heavy deps** (glib, libvips, codecs, …) → built once from pinned source into the
  content-addressed cache `.deps-prefix/<hash>/` (`<hash>` = hash of the pins + flags in
  `scripts/deps-hash.js`). Reused on every later build; only a pin/flag change (new
  `<hash>`) triggers a from-source rebuild.
- **The addon** (`zimage.node`) → rebuilt from `src/*.cc` on every build (fast), linked
  against the prefix's `vips-cpp.pc` closure (via `pkg-config --libs vips-cpp`, computed
  dynamically in `binding.gyp` so it always matches the prefix exactly) with
  `-Wl,-rpath,'$ORIGIN'`.

C++ exceptions are enabled (`-fexceptions`, `NAPI_DISABLE_CPP_EXCEPTIONS` is **not**
defined) because libvips (via `vips::VError`) and future task code may throw.

## Test

Plain Node (bundled glib on the path):
```bash
P=$(node nativelibs/zimage/scripts/deps-hash.js)
LD_LIBRARY_PATH="$P/lib" ELECTRON_RUN_AS_NODE=1 \
  node_modules/.bin/electron nativelibs/zimage/__tests__/moduleReady.test.js
```

Under Electron, do NOT put the whole prefix `lib/` on `LD_LIBRARY_PATH` — that would
shadow Electron's newer system glib with our older bundled 2.78.4 (breaking Electron's
own GTK libs). Expose only the libvips `.so` so libvips resolves glib against the
system copy Electron already loaded (this is exactly what the `RPATH=$ORIGIN` bundle in
`patch-zimage.js` achieves at runtime):
```bash
P=$(node nativelibs/zimage/scripts/deps-hash.js); T=$(mktemp -d)
for so in "$P"/lib/libvips.so.42* "$P"/lib/libvips-cpp.so.42* "$P"/lib/libz.so*; do ln -sf "$so" "$T/"; done
LD_LIBRARY_PATH="$T" ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron nativelibs/zimage/__tests__/moduleReady.test.js
rm -rf "$T"
```

Expected (both): `OK moduleReady` (proves the addon links libvips + `vips_init`
succeeds + loads cleanly under the Electron ABI).

> The earlier "cannot register existing type 'gchar'" SIGABRT under Electron (from a
> static glib baked into `libvips.so.42`) is **resolved** — glib is now built shared
> (see "glib must be shared" above), so a single glib copy is used at runtime.
