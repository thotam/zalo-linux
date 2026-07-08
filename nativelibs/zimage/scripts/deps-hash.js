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
  libjpeg_turbo: '3.0.2',
  libwebp: '1.3.2',
  giflib: '5.2.1',
  // heavy backends added in Task 6 (jxl/heif/magick/pdf); listed here so enabling
  // them changes the hash:
  backends: 'jpeg+png+spng+webp+gif',   // Task 6 flips to full set
  flags: 'x64-relwithdebinfo-static-codecs-shared-glib-shared-vipscpp',
  abi: 1,
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
if (require.main === module) process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
