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

for tool in cmake nasm ninja git curl patchelf; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$PREFIX" "$SRC"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
CMAKE_COMMON=(-G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=ON
  # CMake 4.2 refuses projects whose cmake_minimum_required predates 3.5; this floor keeps them configurable.
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  -DCMAKE_INSTALL_RPATH="$PREFIX/lib" -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,-rpath-link,$PREFIX/lib"
  -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-rpath-link,$PREFIX/lib")

clone() { # repo tag dir
  local repo="$1" tag="$2" dir="$3"
  [ -d "$SRC/$dir" ] || git clone --depth 1 --branch "$tag" --recurse-submodules "$repo" "$SRC/$dir"
}

# ---- Highway 1.0.7 (static; libjxl SIMD dep) ----
# Highway's real tag is 1.0.7 (no leading v).
clone https://github.com/google/highway 1.0.7 highway
cmake -S "$SRC/highway" -B "$SRC/highway/b" "${CMAKE_COMMON[@]}" \
  -DBUILD_SHARED_LIBS=OFF -DHWY_ENABLE_TESTS=OFF -DHWY_ENABLE_EXAMPLES=OFF -DHWY_ENABLE_CONTRIB=OFF
cmake --build "$SRC/highway/b" -j"$JOBS"; cmake --install "$SRC/highway/b"

# ---- brotli 1.0.9 ----
clone https://github.com/google/brotli v1.0.9 brotli
cmake -S "$SRC/brotli" -B "$SRC/brotli/b" "${CMAKE_COMMON[@]}"
cmake --build "$SRC/brotli/b" -j"$JOBS"; cmake --install "$SRC/brotli/b"
# brotli's pkgconfig templates hardcode a raw Solaris-style "-R${libdir}" in
# Libs:, which the GNU c++ driver rejects outright ("unrecognized
# command-line option '-R'") when libjxl's pkg_check_modules pulls it in
# verbatim. Strip it — the patchelf pass below sets $ORIGIN rpath instead.
sed -i -E 's/ -R\$\{libdir\}//' "$PREFIX"/lib/pkgconfig/libbrotli*.pc

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
  -DHWY_ROOT="$PREFIX" -DCMAKE_PREFIX_PATH="$PREFIX" \
  # libjxl tests need hwy/tests/hwy_gtest.h, which we intentionally did not build (Highway built with tests off).
  -DBUILD_TESTING=OFF
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

# Belt-and-suspenders: rewrite every installed .so's rpath to $ORIGIN so the
# whole lib/ dir is self-contained and relocatable (sibling libs resolve
# without LD_LIBRARY_PATH), on top of the CMAKE_INSTALL_RPATH set above.
find "$PREFIX/lib" -maxdepth 1 -type f -name '*.so*' -print0 2>/dev/null \
  | xargs -0 -I{} patchelf --set-rpath '$ORIGIN' {}

touch "$PREFIX/.done"
echo "deps-prefix built: $PREFIX"
