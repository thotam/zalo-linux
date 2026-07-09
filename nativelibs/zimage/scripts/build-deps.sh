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

for tool in meson ninja cmake pkg-config git curl nasm autoreconf automake autoconf; do
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

# ---- mozjpeg 4.1.1 (static; libjpeg-turbo fork, JPEG codec on mac) ----
# mac's libvips-cpp.42.dylib embeds "mozjpeg version 4.1.1 (build 20230321)" — NOT
# libjpeg-turbo. mozjpeg is API/ABI-compatible with libjpeg (installs libjpeg.a +
# jpeglib.h) so libvips's jpeg loader/saver links it exactly like libjpeg-turbo
# before, but produces byte-identical-to-mac JPEG output. PNG_SUPPORTED=OFF (we
# use libspng for PNG, not mozjpeg's bundled cjpeg/djpeg PNG support) and
# WITH_TURBOJPEG=OFF (libvips doesn't need the turbojpeg wrapper API, only libjpeg).
# mozjpeg's CMakeLists always configures pkgscripts/libjpeg.pc regardless of
# WITH_TURBOJPEG, so meson's dependency('libjpeg') still resolves via pkg-config.
clone https://github.com/mozilla/mozjpeg v4.1.1 mozjpeg
cmake -S "$SRC/mozjpeg" -B "$BUILD/mozjpeg" "${CM[@]}" -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
  -DPNG_SUPPORTED=OFF -DWITH_TURBOJPEG=OFF
cmake --build "$BUILD/mozjpeg" -j"$JOBS"; cmake --install "$BUILD/mozjpeg"

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

# ---- Task 6 backends: match the mac libvips build config exactly ----
# The mac libvips-cpp.42.dylib build-config string has these ON: libtiff, lcms2
# (ICC), libexif (EXIF), cgif (GIF save), orc (loop accel), libheif (HEIC/AVIF,
# itself backed by libde265/x265/aom/dav1d) — and libjxl/ImageMagick/PDF/OpenJPEG
# OFF. Adding exactly this set (no more) below, all static, in dependency order.

# ---- lcms2 2.15 (static; meson — avoids the autotools/libtool path) ----
clone https://github.com/mm2/Little-CMS lcms2.15 lcms2
meson setup "$BUILD/lcms2" "$SRC/lcms2" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=static -Dsamples=false -Dfastfloat=false -Dthreaded=false \
  -Djpeg=disabled -Dtiff=disabled
ninja -C "$BUILD/lcms2" -j"$JOBS"; ninja -C "$BUILD/lcms2" install

# ---- libexif 0.6.24 (static; autotools — no cmake/meson upstream at this tag).
# libtool IS present on this system (libtoolize + /usr/share/libtool/build-aux/
# ltmain.sh from the `libtool` apt package); there's just no standalone `libtool`
# binary in PATH, which is normal — autoreconf generates the project-local
# ./libtool script from ltmain.sh during bootstrap. ----
clone https://github.com/libexif/libexif v0.6.24 libexif
if [ ! -f "$SRC/libexif/configure" ]; then
  ( cd "$SRC/libexif" && autoreconf -fi )
fi
mkdir -p "$BUILD/libexif"
# --with-pic: libtool's static-only builds default to non-PIC objects (assumes
# linking into a static executable); this .a gets linked into shared
# libvips-cpp.so.42, so PIC is required (cmake builds get this for free via
# CMAKE_POSITION_INDEPENDENT_CODE=ON in $CM; autotools needs it spelled out).
( cd "$BUILD/libexif" && "$SRC/libexif/configure" --prefix="$PREFIX" --enable-shared=no --enable-static=yes \
    --with-pic --disable-nls )
make -C "$BUILD/libexif" -j"$JOBS"; make -C "$BUILD/libexif" install

# ---- libtiff 4.5.0 (static; cmake, jpeg=ON against our mozjpeg) ----
clone https://gitlab.com/libtiff/libtiff v4.5.0 libtiff
cmake -S "$SRC/libtiff" -B "$BUILD/libtiff" "${CM[@]}" -Dtiff-tools=OFF -Dtiff-tests=OFF \
  -Dtiff-contrib=OFF -Dtiff-docs=OFF -Djpeg=ON -Dlzma=OFF -Dzstd=OFF -Dwebp=OFF -Djbig=OFF -Dlibdeflate=OFF
cmake --build "$BUILD/libtiff" -j"$JOBS"; cmake --install "$BUILD/libtiff"
# libtiff-4.pc lists its zlib/libjpeg deps under Requires.private (jpeg=ON above
# adds "libjpeg" there) — same Requires.private-vs-plain-query bug as libwebp and
# libheif below; promote to a public Requires so meson's non-static dependency()
# still pulls in -ljpeg/-lz when linking libvips.
sed -i 's/^Requires\.private:/Requires:/' "$PREFIX/lib/pkgconfig/libtiff-4.pc"

# ---- cgif 0.3.2 (static; meson — GIF save, mac uses cgif not giflib for save) ----
clone https://github.com/dloebl/cgif V0.3.2 cgif
meson setup "$BUILD/cgif" "$SRC/cgif" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=static -Dtests=false
ninja -C "$BUILD/cgif" -j"$JOBS"; ninja -C "$BUILD/cgif" install

# ---- orc 0.4.33 (static; meson — libvips loop-acceleration backend) ----
clone https://gitlab.freedesktop.org/gstreamer/orc 0.4.33 orc
meson setup "$BUILD/orc" "$SRC/orc" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=static -Dtests=disabled -Dexamples=disabled -Dbenchmarks=disabled \
  -Dorc-test=disabled -Dgtk_doc=disabled
ninja -C "$BUILD/orc" -j"$JOBS"; ninja -C "$BUILD/orc" install

# ---- HEIF stack (all static): dav1d -> libde265 -> aom -> x265 -> libheif ----

# dav1d 1.2.0 (meson; AV1 decoder used by libheif for AVIF)
clone https://code.videolan.org/videolan/dav1d 1.2.0 dav1d
meson setup "$BUILD/dav1d" "$SRC/dav1d" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=static -Denable_tools=false -Denable_examples=false -Denable_tests=false \
  -Denable_docs=false
ninja -C "$BUILD/dav1d" -j"$JOBS"; ninja -C "$BUILD/dav1d" install

# libde265 1.0.12 (cmake; HEVC/HEIC decoder used by libheif)
clone https://github.com/strukturag/libde265 v1.0.12 libde265
cmake -S "$SRC/libde265" -B "$BUILD/libde265" "${CM[@]}" -DENABLE_SDL=OFF -DENABLE_DECODER=ON \
  -DENABLE_ENCODER=OFF
cmake --build "$BUILD/libde265" -j"$JOBS"; cmake --install "$BUILD/libde265"

# libheif is built DECODE-ONLY: HEVC decode via libde265 + AV1 decode via dav1d.
# The HEVC/AV1 ENCODERS (x265, aom) are deliberately NOT built:
#   - zimage's thumbnail path only DECODES HEIC/AVIF *input* and then saves JPEG/PNG;
#     it never SAVES HEIF, so the encoders are never on the output path — decode-only
#     libheif produces byte-identical THUMBNAIL output to a full libheif.
#   - x265 3.5 sets cmake_policy(SET CMP0025/CMP0054 OLD), which CMake 4.2 hard-rejects
#     (OLD no longer supported); aom 3.6.0's test_nasm rejects the system nasm 3.01.
#     Both are encoder-only for our purposes, so dropping them removes two build
#     blockers with zero effect on thumbnail bytes.
# (deps-hash.js still pins aom/x265 as cache keys; they are intentionally unbuilt —
# see the note there.)

# libheif 1.15.2 (cmake; decode-only: libde265 (HEVC) + dav1d (AV1)). Static, codecs
# built in (not plugins) — matches the mac "libheif: true (dynamic module: false)".
clone https://github.com/strukturag/libheif v1.15.2 libheif
cmake -S "$SRC/libheif" -B "$BUILD/libheif" "${CM[@]}" -DBUILD_SHARED_LIBS=OFF -DWITH_EXAMPLES=OFF \
  -DWITH_LIBDE265=ON -DWITH_DAV1D=ON \
  -DWITH_X265=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
  -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DENABLE_PLUGIN_LOADING=OFF
cmake --build "$BUILD/libheif" -j"$JOBS"; cmake --install "$BUILD/libheif"
# libheif.pc lists de265/dav1d under Requires.private; pkg-config only expands those
# for a `--static` query, but meson's dependency() does a plain query by default, so
# without this the -lde265/-ldav1d flags silently drop off libvips's link line.
sed -i 's/^Requires\.private:/Requires:/' "$PREFIX/lib/pkgconfig/libheif.pc"

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
# decoder (boolean, default true, no external lib needed); GIF *write* is the
# separate "cgif" feature (needs libcgif, built above — matches the mac config
# line "GIF save with cgif: true"). giflib is still built above for forward-compat
# but libvips 8.14 doesn't link it for gifload/gifsave either way.
#
# Task 6 backend set — matches the mac libvips-cpp.42.dylib build-config exactly:
# jpeg (mozjpeg), spng (PNG — NOT libpng, mac has "PNG load/save with libpng:
# false"), webp, tiff, heif (HEIC/AVIF), lcms (ICC), exif (EXIF), cgif (GIF save),
# orc (loop accel) all enabled; jpeg-xl, magick, pdfium, poppler, openjpeg all
# disabled like mac (enabling them would DIVERGE from mac's feature set).
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
  -Djpeg=enabled -Dspng=enabled -Dwebp=enabled -Dtiff=enabled -Dheif=enabled \
  -Dlcms=enabled -Dexif=enabled -Dcgif=enabled -Dorc=enabled \
  -Djpeg-xl=disabled -Dmagick=disabled -Dpdfium=disabled -Dpoppler=disabled \
  -Dopenjpeg=disabled -Dpng=disabled \
  -Dc_args="$GLIB_COMPAT_ARGS" -Dcpp_args="$GLIB_COMPAT_ARGS"
ninja -C "$BUILD/libvips" -j"$JOBS"; ninja -C "$BUILD/libvips" install

if [ -d "$PREFIX/lib64" ]; then cp -a "$PREFIX/lib64/." "$PREFIX/lib/"; fi
touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
