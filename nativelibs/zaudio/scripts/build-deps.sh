#!/usr/bin/env bash
# Build libopus static into .deps + vendor miniaudio.h into src/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$HERE/.deps"
OPUS_VER="1.5.2"
MA_VER="0.11.21"
# libopus (release tarball has ./configure — no autotools needed)
if [ ! -f "$PREFIX/lib/libopus.a" ]; then
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  cd "$WORK"
  curl -fsSL -o opus.tar.gz "https://downloads.xiph.org/releases/opus/opus-$OPUS_VER.tar.gz"
  tar xzf opus.tar.gz; cd "opus-$OPUS_VER"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --with-pic --disable-doc --disable-extra-programs CFLAGS="-fPIC -O2"
  make -j"$(nproc)"; make install
  echo "libopus $OPUS_VER -> $PREFIX"
fi
# miniaudio single header (vendored)
if [ ! -f "$HERE/src/miniaudio.h" ]; then
  curl -fsSL -o "$HERE/src/miniaudio.h" "https://raw.githubusercontent.com/mackron/miniaudio/$MA_VER/miniaudio.h"
  echo "miniaudio.h $MA_VER -> src/"
fi
