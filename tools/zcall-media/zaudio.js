'use strict';
// Loads the built zaudio N-API addon (opus + miniaudio). Tries the repo dev path and the app
// layout (copied next to engine.js in ../zcall/), with a helpful error if not found.
const path = require('path');
const CANDIDATES = [
  path.join(__dirname, '..', '..', 'nativelibs', 'zaudio', 'build', 'Release', 'zaudio.node'), // repo dev/test
  path.join(__dirname, '..', 'zcall', 'zaudio.node'),                                           // app layout
  path.join(__dirname, 'zaudio.node'),                                                          // same-dir fallback
];
let addon, lastErr;
for (const p of CANDIDATES) { try { addon = require(p); break; } catch (e) { lastErr = e; } }
if (!addon) {
  throw new Error('zaudio addon not found — tried:\n  ' + CANDIDATES.join('\n  ') +
    '\n(build: cd nativelibs/zaudio && npm i --ignore-scripts && npm run build:deps && npm run build)\nlast: ' + (lastErr && lastErr.message));
}
module.exports = addon; // { ZAudio }
