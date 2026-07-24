#!/usr/bin/env bash
# Fetch + build libsrtp2 v2.5.0 as a static lib into nativelibs/zsrtp/.deps (internal crypto).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="$HERE/.deps"
VER="2.5.0"
if [ -f "$PREFIX/lib/libsrtp2.a" ]; then echo "libsrtp2 already built at $PREFIX"; exit 0; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git clone --depth 1 --branch "v$VER" https://github.com/cisco/libsrtp.git
cd libsrtp
./configure --prefix="$PREFIX"
make -j"$(nproc)"
make install
echo "libsrtp2 $VER installed to $PREFIX (libsrtp2.a + srtp2/srtp.h)"
