'use strict';
// Loads the built zsrtp N-API addon with a helpful error if it isn't compiled yet.
const path = require('path');
const ADDON = path.join(__dirname, '..', '..', 'nativelibs', 'zsrtp', 'build', 'Release', 'zsrtp.node');
let addon;
try {
  addon = require(ADDON);
} catch (e) {
  throw new Error('zsrtp addon not built — run:\n  cd nativelibs/zsrtp && npm install --ignore-scripts && npm run build:deps && npm run build\nOriginal: ' + e.message);
}
module.exports = addon; // { ZSrtp }
