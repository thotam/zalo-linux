// Runs the built addon under Electron's Node ABI (ELECTRON_RUN_AS_NODE) — no display.
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));

const samplesDir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');
const sampleName = fs.readdirSync(samplesDir).find((f) => f.endsWith('.jxl'));
assert(sampleName, 'expected at least one .jxl sample in ' + samplesDir);
const sample = path.join(samplesDir, sampleName);

const buf = fs.readFileSync(sample);
addon.getJxlInfo({ buffer: buf }, (err, data, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0);
  assert(Number.isInteger(data.width) && data.width > 0, 'width');
  assert(Number.isInteger(data.height) && data.height > 0, 'height');
  // Key set matches the mac binary exactly (width/height/orientation only --
  // see RE-PARAMS.md "getJxlInfo output keys"); no hasAlpha/bitsPerSample.
  assert(Number.isInteger(data.orientation), 'orientation');
  assert.deepStrictEqual(Object.keys(data).sort(), ['height', 'orientation', 'width']);
  console.log('OK getJxlInfo', sampleName, data.width + 'x' + data.height, 'orientation=' + data.orientation);
});
