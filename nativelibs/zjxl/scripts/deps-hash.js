// Prints the content-addressed deps prefix path. The hash pins the exact
// upstream versions + build flags so a version bump invalidates the cache.
const crypto = require('crypto');
const path = require('path');

const PINS = {
  libjxl: '0.9.3',
  highway: '1.0.7',
  brotli: '1.0.9',
  libjpeg_turbo: '3.0.2',
  opencv: '4.12.0',
  flags: 'x64-relwithdebinfo-cxx17-shared-jxl-static-hwy',
  abi: 1, // bump to force a rebuild without changing a version
};

const hash = crypto.createHash('sha256').update(JSON.stringify(PINS)).digest('hex').slice(0, 12);
const prefix = path.join(__dirname, '..', '.deps-prefix', hash);
process.stdout.write(prefix);
module.exports = { PINS, prefix, hash };
