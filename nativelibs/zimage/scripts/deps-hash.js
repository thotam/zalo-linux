// Content-addressed deps prefix for zimage's libvips stack. The hash pins the
// exact upstream versions + build flags so a version/backend change invalidates
// the cache. CLI-only stdout (require must not pollute stdout).
const crypto = require('crypto');
const path = require('path');

const PINS = {
  libvips: '8.14.2',
  glib: '2.78.4',
  expat: '2.6.0',
  zlib: '1.3.1',
  libpng: '1.6.39',
  libspng: '0.7.4',
  // JPEG codec: mozjpeg (a libjpeg-turbo fork), NOT libjpeg-turbo — matches the
  // mac build exactly (mac dylib strings: "mozjpeg version 4.1.1 (build 20230321)").
  mozjpeg: '4.1.1',
  libwebp: '1.3.2',
  giflib: '5.2.1',
  // Task 6: backends the mac libvips-cpp.42.dylib has enabled (recovered from its
  // build-config string dump), added to reach full parity. Versions recovered from
  // dylib strings where present (mozjpeg 4.1.1, aom v3.6.0, orc-0.4.33); the rest
  // are indeterminate from strings alone and are pinned to a contemporaneous stable
  // release (assumed — see task-6-report.md).
  libheif: '1.15.2',   // assumed (contemporaneous w/ aom v3.6.0 + mozjpeg 4.1.1 build date)
  libde265: '1.0.12',  // assumed
  x265: '3.5',         // assumed
  aom: '3.6.0',         // recovered from dylib strings ("AOMedia Project AV1 ... v3.6.0")
  dav1d: '1.2.0',       // assumed
  libtiff: '4.5.0',     // assumed
  lcms2: '2.15',        // assumed
  libexif: '0.6.24',    // assumed (latest stable at the time)
  cgif: '0.3.2',        // assumed
  orc: '0.4.33',        // recovered from dylib strings ("orc-0.4.33 debug init")
  backends: 'mozjpeg+spng+webp+cgif+gif+heif+tiff+lcms+exif+orc',
  flags: 'x64-relwithdebinfo-static-codecs-shared-glib-shared-vipscpp',
  abi: 1,
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
if (require.main === module) process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
