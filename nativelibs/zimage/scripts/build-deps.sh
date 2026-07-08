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
cmake -S "$SRC/zlib" -B "$SRC/zlib/b" "${CM[@]}"; cmake --build "$SRC/zlib/b" -j"$JOBS"; cmake --install "$SRC/zlib/b"

# ---- libpng 1.6.39 (static) ----
clone https://github.com/glennrp/libpng v1.6.39 libpng
cmake -S "$SRC/libpng" -B "$SRC/libpng/b" "${CM[@]}" -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DZLIB_ROOT="$PREFIX"
cmake --build "$SRC/libpng/b" -j"$JOBS"; cmake --install "$SRC/libpng/b"

# ---- libspng (static) ----
clone https://github.com/randy408/libspng v0.7.4 libspng
cmake -S "$SRC/libspng" -B "$SRC/libspng/b" "${CM[@]}" -DSPNG_SHARED=OFF -DBUILD_EXAMPLES=OFF
cmake --build "$SRC/libspng/b" -j"$JOBS"; cmake --install "$SRC/libspng/b"
# libspng's CMakeLists names the pkgconfig file after the cmake target
# (libspng_static.pc when SPNG_SHARED=OFF); libvips looks for "spng.pc" or
# "libspng.pc" (see its meson.build comment: "sometimes called spng.pc, sometimes
# libspng.pc"). Alias it so pkg-config resolves either name to our static build.
cp "$PREFIX/lib/pkgconfig/libspng_static.pc" "$PREFIX/lib/pkgconfig/libspng.pc"

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
cmake -S "$SRC/expat/expat" -B "$SRC/expat/b" "${CM[@]}" -DEXPAT_SHARED_LIBS=OFF -DEXPAT_BUILD_TESTS=OFF \
  -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TOOLS=OFF
cmake --build "$SRC/expat/b" -j"$JOBS"; cmake --install "$SRC/expat/b"

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
meson setup "$SRC/glib/b" "$SRC/glib" --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=shared \
  -Dtests=false -Dnls=disabled -Dlibmount=disabled -Dselinux=disabled || meson setup --reconfigure "$SRC/glib/b" "$SRC/glib" --prefix="$PREFIX" --libdir=lib --default-library=shared
ninja -C "$SRC/glib/b" -j"$JOBS"; ninja -C "$SRC/glib/b" install

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
meson setup "$SRC/libvips/b" "$SRC/libvips" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=shared -Ddeprecated=false -Dexamples=false -Dcplusplus=true -Dnsgif=true \
  -Dintrospection=false -Dvapi=false -Dmodules=disabled \
  -Djpeg=enabled -Dpng=enabled -Dspng=enabled -Dwebp=enabled \
  -Djpeg-xl=disabled -Dheif=disabled -Dmagick=disabled -Dpdfium=disabled -Dpoppler=disabled \
  -Dc_args="$GLIB_COMPAT_ARGS" -Dcpp_args="$GLIB_COMPAT_ARGS" \
  || meson setup --reconfigure "$SRC/libvips/b" "$SRC/libvips" --prefix="$PREFIX" --libdir=lib
ninja -C "$SRC/libvips/b" -j"$JOBS"; ninja -C "$SRC/libvips/b" install

if [ -d "$PREFIX/lib64" ]; then cp -a "$PREFIX/lib64/." "$PREFIX/lib/"; fi
touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
