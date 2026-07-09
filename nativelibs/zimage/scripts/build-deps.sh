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

# Build dirs live UNDER the prefix (hash-specific), not under the shared $SRC.
# Rationale: cmake/meson build dirs CACHE the install prefix (CMAKE_INSTALL_PREFIX /
# meson --prefix). If they lived under $SRC (shared across all prefix hashes) and the
# hash changed (e.g. a flag/pin change), a re-run would see the dep already "built" in
# that dir and cmake/meson would treat --install as a no-op against the OLD cached
# prefix, silently leaving the NEW prefix without the installed files (e.g. zlib.pc).
# Keying the build dir on $PREFIX means a hash change always gets a fresh build dir
# (correct prefix baked in from the start) while re-running the SAME prefix reuses it
# (incremental). The git clones/downloads stay in $SRC (expensive, prefix-independent).
BUILD="$PREFIX/.build"
mkdir -p "$BUILD"

for tool in meson ninja cmake pkg-config git curl nasm; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$PREFIX" "$SRC"
# zlib's CMake install puts zlib.pc under share/pkgconfig (not lib/pkgconfig) —
# include it or every Requires.private:zlib consumer (libpng, libspng) fails to
# resolve even though the .pc files exist.
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
export CMAKE_PREFIX_PATH="$PREFIX"
export PATH="$PREFIX/bin:$PATH"
CM=(-G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX="$PREFIX"
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF   # static codecs
    # CMake 4.x refuses projects whose cmake_minimum_required predates 3.5; this floor
    # keeps these older codec releases configurable (same fix as nativelibs/zjxl).
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5)

clone() { local repo="$1" tag="$2" dir="$3"; [ -d "$SRC/$dir" ] || git clone --depth 1 --branch "$tag" "$repo" "$SRC/$dir"; }
dl() { local url="$1" tar="$2" dir="$3"; [ -d "$SRC/$dir" ] || { curl -fsSL "$url" -o "$SRC/$tar"; tar -C "$SRC" -xf "$SRC/$tar"; }; }

# ---- zlib (static) ----
clone https://github.com/madler/zlib v1.3.1 zlib
cmake -S "$SRC/zlib" -B "$BUILD/zlib" "${CM[@]}"; cmake --build "$BUILD/zlib" -j"$JOBS"; cmake --install "$BUILD/zlib"

# ---- libpng 1.6.39 (static) ----
clone https://github.com/glennrp/libpng v1.6.39 libpng
cmake -S "$SRC/libpng" -B "$BUILD/libpng" "${CM[@]}" -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DZLIB_ROOT="$PREFIX"
cmake --build "$BUILD/libpng" -j"$JOBS"; cmake --install "$BUILD/libpng"

# ---- libspng (static) ----
clone https://github.com/randy408/libspng v0.7.4 libspng
cmake -S "$SRC/libspng" -B "$BUILD/libspng" "${CM[@]}" -DSPNG_SHARED=OFF -DBUILD_EXAMPLES=OFF
cmake --build "$BUILD/libspng" -j"$JOBS"; cmake --install "$BUILD/libspng"
# libspng's CMakeLists names the pkgconfig file after the cmake target
# (libspng_static.pc when SPNG_SHARED=OFF); libvips looks for "spng.pc" or
# "libspng.pc" (see its meson.build comment: "sometimes called spng.pc, sometimes
# libspng.pc"). Alias it so pkg-config resolves either name to our static build.
cp "$PREFIX/lib/pkgconfig/libspng_static.pc" "$PREFIX/lib/pkgconfig/libspng.pc"

# ---- libjpeg-turbo (static) ----
clone https://github.com/libjpeg-turbo/libjpeg-turbo 3.0.2 ljt
cmake -S "$SRC/ljt" -B "$BUILD/ljt" "${CM[@]}" -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_TURBOJPEG=ON
cmake --build "$BUILD/ljt" -j"$JOBS"; cmake --install "$BUILD/ljt"

# ---- libwebp (static) ----
clone https://github.com/webmproject/libwebp v1.3.2 webp
cmake -S "$SRC/webp" -B "$BUILD/webp" "${CM[@]}" -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
  -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
  -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=ON -DWEBP_BUILD_EXTRAS=OFF
cmake --build "$BUILD/webp" -j"$JOBS"; cmake --install "$BUILD/webp"
# libwebp.pc lists libsharpyuv (and libwebpmux/libwebpdemux list libwebp) under
# Requires.private, which pkg-config only expands for a `--static` query. Since
# we only ever build static .a's here (no .so fallback), a plain (non-static)
# pkg-config query — what meson's dependency() does by default — silently drops
# -lsharpyuv from the link line, causing undefined SharpYuv* references when
# linking libvips.so. Promote these to public Requires so they're always pulled in.
sed -i 's/^Requires\.private:/Requires:/' "$PREFIX"/lib/pkgconfig/libwebp*.pc

# ---- giflib (static; Makefile-based) ----
# Real sourceforge path nests the tarball under giflib-5.x/, not flat.
dl https://downloads.sourceforge.net/project/giflib/giflib-5.x/giflib-5.2.1.tar.gz giflib-5.2.1.tar.gz giflib-5.2.1
make -C "$SRC/giflib-5.2.1" libgif.a
install -Dm644 "$SRC/giflib-5.2.1/libgif.a" "$PREFIX/lib/libgif.a"
install -Dm644 "$SRC/giflib-5.2.1/gif_lib.h" "$PREFIX/include/gif_lib.h"

# ---- expat (static) ----
clone https://github.com/libexpat/libexpat R_2_6_0 expat
cmake -S "$SRC/expat/expat" -B "$BUILD/expat" "${CM[@]}" -DEXPAT_SHARED_LIBS=OFF -DEXPAT_BUILD_TESTS=OFF \
  -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TOOLS=OFF
cmake --build "$BUILD/expat" -j"$JOBS"; cmake --install "$BUILD/expat"

# ---- glib (meson, SHARED — must NOT be static) ----
# glib/gobject/gio MUST be shared, not static. A static glib gets baked into
# libvips.so.42; when the addon dlopen()s under Electron (which already links the
# system libgobject/libglib for GTK), libvips's embedded gobject_init_ctor tries
# to re-register the fundamental type 'gchar' -> "cannot register existing type"
# -> SIGABRT. Shared glib resolves to a single runtime copy (system glib under
# Electron, bundled under plain Node) via SONAME, so no double registration.
# glib is not a codec, so this does NOT affect byte-identical image output.
# --libdir=lib: on Debian/Ubuntu meson defaults libdir to the multiarch triplet
# (lib/x86_64-linux-gnu), which our PKG_CONFIG_PATH/CMAKE_PREFIX_PATH don't scan.
clone https://gitlab.gnome.org/GNOME/glib.git 2.78.4 glib
# Build dir is under $BUILD (per-prefix, see rationale above), so it always starts
# fresh for a new prefix hash and the --default-library=shared config below always
# applies cleanly (no stale static config to fall back to via --reconfigure).
meson setup "$BUILD/glib" "$SRC/glib" --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Dtests=false -Dnls=disabled -Dlibmount=disabled -Dselinux=disabled
ninja -C "$BUILD/glib" -j"$JOBS"; ninja -C "$BUILD/glib" install

# ---- libvips 8.14.2 (meson; shared libvips-cpp, codecs static) ----
# cplusplus is a boolean option in 8.14's meson_options.txt (not a feature) -> true.
# There is no top-level "gif" option in 8.14: GIF *read* is the bundled nsgif
# decoder (boolean, default true, no external lib needed); GIF *write* would be
# the separate "cgif" feature (needs libcgif, not giflib) — left at its "auto"
# default so it silently no-ops without libcgif. giflib is still built above for
# forward-compat but libvips 8.14 doesn't link it for gifload.
#
# GLIB_VERSION_MAX_ALLOWED pin: glib 2.78's g_free() fast-path macro (gmem.h,
# guarded by GLIB_VERSION_MAX_ALLOWED >= GLIB_VERSION_2_78) is missing outer
# parens around its ternary, so any `(void) g_free(x)` — exactly what libvips's
# VIPS_FREEF/VIPS_FREE/VIPS_SETSTR macros do everywhere — fails to compile with
# "void value not ignored as it ought to be". Capping the allowed API surface to
# 2.76 skips that macro (falls back to the plain g_free() function decl) without
# touching glib itself; libvips 8.14 doesn't use any 2.78-only API anyway.
GLIB_COMPAT_ARGS="-DGLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_76 -DGLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_76"
clone https://github.com/libvips/libvips v8.14.2 libvips
# Build dir is under $BUILD (per-prefix, see rationale above), so the full flag
# set (incl. --default-library=shared and the codec toggles) always applies fresh
# for a new prefix hash. libvips must dynamic-link glib so a single glib copy is
# used at runtime (system glib under Electron, bundled under plain Node) — no
# double gobject type registration -> no SIGABRT.
meson setup "$BUILD/libvips" "$SRC/libvips" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=shared -Ddeprecated=false -Dexamples=false -Dcplusplus=true -Dnsgif=true \
  -Dintrospection=false -Dvapi=false -Dmodules=disabled \
  -Djpeg=enabled -Dpng=enabled -Dspng=enabled -Dwebp=enabled \
  -Djpeg-xl=disabled -Dheif=disabled -Dmagick=disabled -Dpdfium=disabled -Dpoppler=disabled \
  -Dc_args="$GLIB_COMPAT_ARGS" -Dcpp_args="$GLIB_COMPAT_ARGS"
ninja -C "$BUILD/libvips" -j"$JOBS"; ninja -C "$BUILD/libvips" install

if [ -d "$PREFIX/lib64" ]; then cp -a "$PREFIX/lib64/." "$PREFIX/lib/"; fi
touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
