#!/usr/bin/env bash
# Builds the exact pinned FFmpeg the mac mp4thumb bundle links (n5.1 =
# libavcodec 59.37.100 / libavformat 59.27.100), STATIC, into a content-addressed
# prefix. Idempotent: exits early if <prefix>/.done exists. Built from source;
# nothing prebuilt is checked in. Byte-identical output requires this exact version.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # nativelibs/mp4thumb
PREFIX="$(node "$HERE/scripts/deps-hash.js")"
SRC="$HERE/deps-src"
JOBS="$(nproc)"
TAG="$(node -e "process.stdout.write(require('$HERE/scripts/deps-hash.js').PINS.ffmpeg)")"

if [ -f "$PREFIX/.done" ]; then
  echo "deps-prefix cache hit: $PREFIX"
  exit 0
fi

for tool in gcc g++ make nasm pkg-config git; do
  command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done

mkdir -p "$PREFIX" "$SRC"

# ---- FFmpeg n5.1 (static, PIC) ----
if [ ! -d "$SRC/ffmpeg" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/FFmpeg/FFmpeg "$SRC/ffmpeg"
fi

# Assert we cloned the version whose libavcodec == 59.37.100 (the mac binary's Lavc).
# n5.1 splits MAJOR into version_major.h, MINOR/MICRO stay in version.h.
vfield() { grep -hE "#define $1 " "$SRC"/ffmpeg/libavcodec/version_major.h "$SRC"/ffmpeg/libavcodec/version.h | head -1 | awk '{print $3}'; }
LAVC="$(vfield LIBAVCODEC_VERSION_MAJOR).$(vfield LIBAVCODEC_VERSION_MINOR).$(vfield LIBAVCODEC_VERSION_MICRO)"
echo "cloned FFmpeg libavcodec version: $LAVC (expect 59.37.100)"
if [ "$LAVC" != "59.37.100" ]; then
  echo "WARN: libavcodec is $LAVC, not 59.37.100 — byte-identity may drift. Continuing." >&2
fi

# Broad native decoder / parser / demuxer set to cover Zalo's real videos, but zero
# external encoders (we only mjpeg-encode). --disable-autodetect keeps it self-contained;
# zlib (system) is explicitly enabled for png/matroska paths.
cd "$SRC/ffmpeg"
if [ ! -f config.mak ]; then
  ./configure \
    --prefix="$PREFIX" \
    --enable-static --disable-shared --enable-pic \
    `# FFmpeg 5.1's mathops.h inline asm ("shr" operand) fails on newer binutils.` \
    `# Disable inline asm ONLY; external nasm x86 SIMD (idct/mc/swscale) stays enabled,` \
    `# so decoder/swscale output is unchanged — the C fallbacks for the disabled inline` \
    `# asm are bit-identical scalar math -> thumbnail bytes are unaffected.` \
    --disable-inline-asm \
    --disable-programs --disable-doc --disable-htmlpages --disable-manpages \
    --disable-podpages --disable-txtpages \
    --enable-network --disable-autodetect --enable-zlib \
    `# openssl for TLS (system OpenSSL 3 = the deb compat floor); nonfree only affects` \
    `# redistribution of the openssl-linked binary, irrelevant for this personal repack.` \
    --enable-openssl --enable-nonfree \
    --disable-everything \
    --enable-decoder=h264,hevc,mpeg4,mpeg2video,mpeg1video,msmpeg4v1,msmpeg4v2,msmpeg4v3,mpeg4_v4l2m2m,vp6,vp6a,vp6f,vp7,vp8,vp9,av1,mjpeg,mjpegb,png,gif,flv,h263,h263i,h263p,vc1,wmv1,wmv2,wmv3,theora,rawvideo,prores,cfhd,dnxhd,huffyuv,ffv1,rv10,rv20,rv30,rv40,svq1,svq3 \
    --enable-parser=h264,hevc,mpeg4video,mpegvideo,vp8,vp9,av1,mjpeg,vc1,h263,h261,flv,dnxhd,gif,png,vp3,dvbsub \
    --enable-demuxer=mov,matroska,webm,avi,flv,mpegts,mpegps,mpegvideo,m4v,h264,hevc,image2,image2pipe,rawvideo,gif,ogg,asf,rm,dv,3gp \
    --enable-encoder=mjpeg \
    --enable-muxer=mjpeg,image2,image2pipe \
    --enable-protocol=file,pipe,http,https,tls,tcp,crypto,data,subfile,cache,httpproxy \
    --enable-swscale --enable-swresample
fi

make -j"$JOBS"
make install

# Sanity: the static archives must exist (linked into the .node by node-gyp).
for lib in libavformat libavcodec libswscale libswresample libavutil; do
  test -f "$PREFIX/lib/$lib.a" || { echo "missing static lib: $lib.a" >&2; exit 1; }
done

touch "$PREFIX/.done"
echo "FFmpeg static deps installed: $PREFIX"
