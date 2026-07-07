// Runs the built addon under Electron's Node ABI (ELECTRON_RUN_AS_NODE) — no display.
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));

const samplesDir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');
const sampleName = fs.readdirSync(samplesDir).find((f) => f.endsWith('.jxl'));
assert(sampleName, 'expected at least one .jxl sample in ' + samplesDir);
const sample = path.join(samplesDir, sampleName);

// Assert a Buffer is a well-formed JPEG: SOI (FF D8) .. EOI (FF D9), non-empty.
function assertJpeg(data, label) {
  assert(Buffer.isBuffer(data) && data.length > 4, label + ': jpeg buffer non-empty');
  assert.strictEqual(data[0], 0xff, label + ': JPEG SOI byte 0');
  assert.strictEqual(data[1], 0xd8, label + ': JPEG SOI byte 1');
  assert.strictEqual(data[data.length - 2], 0xff, label + ': JPEG EOI byte -2');
  assert.strictEqual(data[data.length - 1], 0xd9, label + ': JPEG EOI byte -1');
}

let pending = 2;
function done() { if (--pending === 0) console.log('ALL DECODE TESTS PASSED'); }

// RE'd contract: JS "quality" is a 0..1 float scaled by 100 in native (kJpegQualityScale),
// via mulss + cvttss2si truncation (no rounding, no [1,100] clamp) — matches the mac
// jxlToJpeg @0x519b-0x51c2 bit-for-bit. Passing 0.9 -> float 0.9f * 100.0f = 89.999...,
// truncated -> turbojpeg quality 89 (not 90). (Do NOT pass 90 here; that would become 9000.)
addon.jxlToJpeg({ buffer: fs.readFileSync(sample), quality: 0.9 }, (err, data, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0);
  assertJpeg(data, 'jxlToJpeg');
  // BASELINE JPEG: the mac sets TJPARAM_FASTDCT (ordinal 10), NOT progressive
  // (ordinal 12). So SOF0 (FF C0) must be present and SOF2 (FF C2) absent.
  assert(data.includes(Buffer.from([0xff, 0xc0])), 'jxlToJpeg: baseline SOF0 marker present');
  assert(!data.includes(Buffer.from([0xff, 0xc2])), 'jxlToJpeg: progressive SOF2 marker absent');
  // The mac embeds the decoded JXL's ICC profile via tj3SetICCProfile -> an
  // APP2 (FF E2) marker. Zalo samples are all_default SRGB and may not carry
  // an ICC profile, so this is conditional: assert presence only for samples
  // that actually produced one.
  const hasIcc = data.includes(Buffer.from([0xff, 0xe2]));
  fs.writeFileSync('/tmp/zjxl-out.jpg', data);
  console.log('OK jxlToJpeg', sampleName, data.length, 'bytes', 'ICC(APP2):', hasIcc);
  done();
});

addon.jxlToJpegFromLocalPath({ path: sample, quality: 0.9 }, (err, data, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0);
  assertJpeg(data, 'jxlToJpegFromLocalPath');
  console.log('OK jxlToJpegFromLocalPath', sampleName, data.length, 'bytes');
  done();
});
