// Prints the content-addressed deps prefix for mp4thumb's pinned FFmpeg build.
// The hash pins the exact FFmpeg tag + configure flags so any change invalidates
// the cache and forces a rebuild.
const crypto = require('crypto');
const path = require('path');

const PINS = {
  // libavcodec 59.37.100 / libavformat 59.27.100 -> FFmpeg release n5.1.
  ffmpeg: 'n5.1',
  // Static, PIC, no external encoders (we only mjpeg-encode + decode with native
  // decoders). Broad native decoder/demuxer set to cover real videos. zlib (system)
  // enabled for png/matroska. Bump `abi` to force a rebuild without touching a version.
  // Shared (bundled .so + RPATH=$ORIGIN, like zimage) — static x86-asm objects have
  // non-PIC text relocations that cannot link into a shared .node. Code/SIMD identical,
  // so thumbnail bytes are unchanged; shared just sidesteps the PIC-asm link error.
  // network + http/https/tls (openssl) is REQUIRED: the app feeds mp4thumb remote
  // Zalo-cloud video URLs (mac binary supports http/https), not local paths.
  // STATIC + PIC, x86 SIMD kept (byte-identity), inline-asm off (FFmpeg-5.1/new-binutils
  // build bug). Linked into the .node with -Wl,--exclude-libs,ALL so every ffmpeg symbol is
  // LOCAL: (1) no interposition by Electron's global libffmpeg.so (whose Chromium ffmpeg has
  // no `file` protocol -> "Protocol not found" in the renderer), and (2) local symbols make
  // the x86-asm PC32 relocations link cleanly into the shared .node (the reason a naive
  // static link failed before). Self-contained: no bundled .so, no rpath.
  flags: 'x64-static-pic-mjpeg-swscale-broaddec-zlib-noinlineasm-net-openssl-hidden',
  abi: 6,
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
if (require.main === module) process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
