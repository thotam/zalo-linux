'use strict';
// Loads the built zaudio N-API addon (opus + miniaudio) with a helpful error if not compiled.
const path = require('path');
const ADDON = path.join(__dirname, '..', '..', 'nativelibs', 'zaudio', 'build', 'Release', 'zaudio.node');
let addon;
try {
  addon = require(ADDON);
} catch (e) {
  throw new Error('zaudio addon not built — run:\n  cd nativelibs/zaudio && npm install --ignore-scripts && npm run build:deps && npm run build\nOriginal: ' + e.message);
}
module.exports = addon; // { ZAudio }
