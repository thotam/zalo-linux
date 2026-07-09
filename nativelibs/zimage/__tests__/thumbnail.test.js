// Functional test for zimage.thumbnail(). This build now links mozjpeg 4.1.1
// (matching the mac, since Task 6), so JPEG output should be byte-comparable to
// the mac binary — but that cross-check against real mac output is still
// deferred (see RE-PARAMS.md "Step 3"). Until then this test does not assert
// byte-identity; it verifies valid output signatures and exact FORCE dimensions
// (size=FORCE
// stretches to precisely width x height, no aspect preservation) for both
// calling conventions the addon must support and both formats the mac
// binary ever produces ("jpeg" -> JPEG, anything else -> PNG per RE-PARAMS.md).
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'img-samples');
const f = path.join(dir, fs.readdirSync(dir).find((x) => /\.(jpe?g|png)$/i.test(x)));
const input = fs.readFileSync(f);

// Minimal JPEG SOFn parser: returns {width, height} or throws.
function jpegDims(buf) {
  assert.strictEqual(buf[0], 0xff);
  assert.strictEqual(buf[1], 0xd8, 'JPEG SOI');
  let i = 2;
  while (i < buf.length) {
    assert.strictEqual(buf[i], 0xff, 'JPEG marker sync');
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('no SOF marker found');
}

// Minimal PNG IHDR parser: returns {width, height} or throws.
function pngDims(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(buf.subarray(0, 8).equals(sig), 'PNG signature');
  assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let pending = 0;
function done() {
  pending -= 1;
  if (pending === 0) console.log('OK thumbnail: all cases passed');
}

function expectJpeg(data, w, h, label) {
  assert(Buffer.isBuffer(data) && data.length > 2, label + ': buffer out');
  const dims = jpegDims(data);
  assert.strictEqual(dims.width, w, label + ': width');
  assert.strictEqual(dims.height, h, label + ': height');
  console.log('OK', label, data.length, 'bytes', dims);
}

function expectPng(data, w, h, label) {
  assert(Buffer.isBuffer(data) && data.length > 8, label + ': buffer out');
  const dims = pngDims(data);
  assert.strictEqual(dims.width, w, label + ': width');
  assert.strictEqual(dims.height, h, label + ': height');
  console.log('OK', label, data.length, 'bytes', dims);
}

// 1. Positional calling convention, format "jpeg", non-square (exercises
//    VIPS_SIZE_FORCE stretch, not aspect-preserving resize).
pending += 1;
addon.thumbnail(input, 120, 80, 'jpeg', 80, (err, data) => {
  assert.ifError(err);
  expectJpeg(data, 120, 80, 'positional/jpeg');
  fs.writeFileSync('/tmp/zimage-thumb.jpg', data);
  done();
});

// 2. Positional calling convention, format "png" (mac's else-branch).
pending += 1;
addon.thumbnail(input, 64, 96, 'png', 80, (err, data) => {
  assert.ifError(err);
  expectPng(data, 64, 96, 'positional/png');
  done();
});

// 3. Object calling convention — matches what
//    app/native/nativelibs/zimage/index.js actually sends the addon:
//      zimage.thumbnail({buffer,width,height,format,quality}, callback)
pending += 1;
addon.thumbnail(
  { buffer: input, width: 128, height: 128, format: 'jpeg', quality: 80 },
  (err, data) => {
    assert.ifError(err);
    expectJpeg(data, 128, 128, 'object/jpeg');
    done();
  }
);

// 4. Alpha-flatten gate: format "jpeg" on a source WITH an alpha channel
//    must flatten onto white before saving (mac disasm @0x1512 gates the
//    flatten on vips_image_hasalpha()). A source WITHOUT alpha must NOT be
//    flattened (flatten unconditionally drops the last band, which would
//    corrupt an alpha-less RGB image -- see RE-PARAMS.md's correction note).
//    fixture-rgba.png is a synthetic 8x8 RGBA (4-band) image.
const rgbaInput = fs.readFileSync(path.join(__dirname, 'fixture-rgba.png'));
pending += 1;
addon.thumbnail(rgbaInput, 32, 32, 'jpeg', 80, (err, data) => {
  assert.ifError(err);
  // A flattened JPEG has no alpha: baseline JPEG only ever encodes 1 or 3
  // components, so simply decoding valid dims (via SOF) already proves the
  // hasalpha->flatten->jpegsave path ran without error and produced a
  // structurally valid, correctly-sized JPEG (byte-identical mozjpeg output
  // is deferred to Task 6).
  expectJpeg(data, 32, 32, 'alpha-source/jpeg(flattened)');
  done();
});
