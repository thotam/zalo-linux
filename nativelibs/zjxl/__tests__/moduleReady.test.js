// Runs the built addon under Electron's Node ABI (ELECTRON_RUN_AS_NODE) — no display.
const path = require('path');
const assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
assert.strictEqual(typeof addon.moduleReady, 'function', 'moduleReady exported');
assert.strictEqual(addon.moduleReady(), true, 'moduleReady() true');

// Task 3 only wires up moduleReady; the 7 real methods are added by empty
// registrars (Register{Info,Decode,Encode,Resize,Multi}) that don't export
// anything yet. Enable this loop incrementally as Tasks 4-8 land the methods.
// for (const fn of ['jxlToJpeg', 'bitmapToJxl', 'getJxlInfo', 'resizeJxl', 'resizeJxlLimit', 'jxlDecompressMulti', 'jxlToJpegFromLocalPath']) {
//   assert.strictEqual(typeof addon[fn], 'function', fn + ' exported');
// }
console.log('OK moduleReady');
