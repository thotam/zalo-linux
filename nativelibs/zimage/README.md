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
- glib 2.78.4 (static)
- expat 2.6.0, zlib 1.3.1, libpng 1.6.39, libspng 0.7.4, libjpeg-turbo 3.0.2,
  libwebp 1.3.2, giflib 5.2.1 (all static)

Backend set currently enabled: `jpeg+png+spng+webp+gif`. The full backend set
(jxl/heif/imagemagick/pdf) is added in Task 6, which will bump the deps-prefix hash.

Flags: `x64-relwithdebinfo-static-codecs-shared-vipscpp` (see `PINS` in
`scripts/deps-hash.js`).

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

```bash
P=$(node nativelibs/zimage/scripts/deps-hash.js)
LD_LIBRARY_PATH="$P/lib" ELECTRON_RUN_AS_NODE=1 \
  node_modules/.bin/electron nativelibs/zimage/__tests__/moduleReady.test.js
```

Expected: `OK moduleReady` (proves the addon links libvips + loads under Electron ABI,
`vips_init` succeeds).

### Known issue: GObject type collision under Electron

As of Task 3, `moduleReady.test.js` passes cleanly under plain Node
(`LD_LIBRARY_PATH="$P/lib" node nativelibs/zimage/__tests__/moduleReady.test.js` →
`OK moduleReady`) but **aborts under Electron** with:

```
GLib-GObject-CRITICAL: cannot register existing type 'gchar'
GLib-GObject:ERROR:../gobject/gvaluetypes.c:452:_g_value_types_init: assertion failed: (type == G_TYPE_CHAR)
```

Root cause (confirmed via `gdb` backtrace): the deps-prefix builds glib
`--default-library=static`, so a full copy of GObject's type-registration code is baked
directly into `libvips.so.42`. The `electron` binary itself directly links the
**system** `libgobject-2.0.so.0` (for its own GTK/D-Bus use) as a hard dependency, which
is loaded and initialized before any JS runs. When `zimage.node` is later `dlopen`'d,
`libvips.so.42`'s embedded `gobject_init_ctor` ELF constructor runs and calls its own
`_g_value_types_init()` — but because shared-library code is PIC/interposable by
default, that function's internal call to `g_type_register_fundamental()` resolves via
the PLT to the **already-loaded system** implementation (first in the process's global
symbol scope), which rejects re-registering the fundamental type `gchar` a second time
→ `SIGABRT`. This is a structural conflict between the prefix's static-glib design and
any host process (like Electron) that already links system glib/GObject — it is **not**
an addon-scaffold bug and reproduces on every load, regardless of require() timing.

Fixing this requires a deps-prefix change (out of Task 3's scope): either build
glib/gobject/gio as shared libraries in the prefix so the dynamic loader dedups against
Electron's copy, or hide the statically-embedded glib symbols in `libvips.so`/
`libvips-cpp.so` (e.g. a linker version script or `-Wl,--exclude-libs=ALL`) so they
cannot interpose with the system copy.
