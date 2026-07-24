'use strict';
// Loads the built zsrtp N-API addon. Tries the repo dev path and the app layout (copied next to
// engine.js in ../zcall/), with a helpful error if not found.
const path = require('path');
const CANDIDATES = [
  path.join(__dirname, '..', '..', 'nativelibs', 'zsrtp', 'build', 'Release', 'zsrtp.node'), // repo dev/test
  path.join(__dirname, '..', 'zcall', 'zsrtp.node'),                                          // app: app/native/nativelibs/zcall/zsrtp.node
  path.join(__dirname, 'zsrtp.node'),                                                          // same-dir fallback
];
let addon, lastErr;
for (const p of CANDIDATES) { try { addon = require(p); break; } catch (e) { lastErr = e; } }
if (!addon) {
  throw new Error('zsrtp addon not found — tried:\n  ' + CANDIDATES.join('\n  ') +
    '\n(build: cd nativelibs/zsrtp && npm i --ignore-scripts && npm run build:deps && npm run build)\nlast: ' + (lastErr && lastErr.message));
}
module.exports = addon; // { ZSrtp }
