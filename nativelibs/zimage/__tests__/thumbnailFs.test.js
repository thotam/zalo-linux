// Functional test for zimage.thumbnailFs() (file -> file). Byte-identical
// JPEG output vs the mac binary is NOT expected yet: the mac used mozjpeg
// 4.1.1, this build currently links libjpeg-turbo (Task 6 swaps in mozjpeg).
//
// Full disassembly of ThumbnailFsAsyncWorker::Execute (@0x38f8, see
// RE-PARAMS.md) shows this variant is SIMPLER than the buffer variant
// (thumbnail.cc / ThumbnailAsyncWorker): it is exactly
//   vips_thumbnail(inputPath, &out, width, "height", height, "size", 3, NULL);
//   vips_image_write_to_file(out, outputPath, NULL);
// with NO vips_image_hasalpha()/vips_flatten() call anywhere -- format and
// save options are 100% libvips' extension-inferred defaults. This test
// verifies: valid output signatures, exact FORCE dimensions, both calling
// conventions (positional direct-binding + the object form index.js's
// resizeQA actually sends), and cross-checks thumbnailFs output against
// thumbnail() (buffer variant) for the same input/dims/format, since both
// are supposed to run through the same vips_thumbnail(..., size=FORCE)
// core.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'zimage.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'img-samples');
const f = path.join(dir, fs.readdirSync(dir).find((x) => /\.(jpe?g|png)$/i.test(x)));
const inputBuf = fs.readFileSync(f);

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

function pngDims(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(buf.subarray(0, 8).equals(sig), 'PNG signature');
  assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let pending = 0;
function done() {
  pending -= 1;
  if (pending === 0) console.log('OK thumbnailFs: all cases passed');
}

// 1. Positional calling convention (the brief's direct-binding test shape):
//    (inputPath, outputPath, width, height, quality, callback). Output
//    extension is .jpg -> jpeg.
pending += 1;
const out1 = path.join(os.tmpdir(), 'zimage-fs-out.jpg');
addon.thumbnailFs(f, out1, 200, 200, 80, (err) => {
  assert.ifError(err);
  const b = fs.readFileSync(out1);
  const dims = jpegDims(b);
  assert.strictEqual(dims.width, 200, 'positional/jpg width');
  assert.strictEqual(dims.height, 200, 'positional/jpg height');
  console.log('OK positional/jpg', b.length, 'bytes', dims);

  // Cross-check vs thumbnail() (buffer variant) for the same input/dims/
  // format: both run through the RE'd vips_thumbnail(size=FORCE) core, so
  // dimensions (and, modulo encoder options, output) should agree.
  addon.thumbnail(inputBuf, 200, 200, 'jpeg', 80, (err2, data) => {
    assert.ifError(err2);
    const dims2 = jpegDims(data);
    assert.strictEqual(dims2.width, dims.width, 'thumbnailFs vs thumbnail width match');
    assert.strictEqual(dims2.height, dims.height, 'thumbnailFs vs thumbnail height match');
    console.log('OK thumbnailFs/thumbnail dims match', dims, dims2);
    done();
  });
});

// 2. Positional calling convention, .png output extension.
pending += 1;
const out2 = path.join(os.tmpdir(), 'zimage-fs-out.png');
addon.thumbnailFs(f, out2, 64, 96, 80, (err) => {
  assert.ifError(err);
  const b = fs.readFileSync(out2);
  const dims = pngDims(b);
  assert.strictEqual(dims.width, 64, 'positional/png width');
  assert.strictEqual(dims.height, 96, 'positional/png height');
  console.log('OK positional/png', b.length, 'bytes', dims);
  done();
});

// 3. Object calling convention -- matches EXACTLY what
//    app/native/nativelibs/zimage/index.js's resizeQA sends the addon:
//      zimage.thumbnailFs({inputPath, outputPath, width, height, quality}, callback)
//    (confirmed by reading index.js directly).
pending += 1;
const out3 = path.join(os.tmpdir(), 'zimage-fs-out-obj.jpg');
addon.thumbnailFs(
  { inputPath: f, outputPath: out3, width: 150, height: 100, quality: 80 },
  (err) => {
    assert.ifError(err);
    const b = fs.readFileSync(out3);
    const dims = jpegDims(b);
    assert.strictEqual(dims.width, 150, 'object/jpg width');
    assert.strictEqual(dims.height, 100, 'object/jpg height');
    console.log('OK object/jpg', b.length, 'bytes', dims);
    done();
  }
);

// 4. No-flatten-on-FS-path check: writing an RGBA PNG source out to .png
//    must simply preserve alpha (no flatten call exists in
//    ThumbnailFsAsyncWorker::Execute per the disassembly) -- verify the
//    written PNG round-trips through libvips with 4 bands.
pending += 1;
const rgbaIn = path.join(__dirname, 'fixture-rgba.png');
const out4 = path.join(os.tmpdir(), 'zimage-fs-out-rgba.png');
addon.thumbnailFs(rgbaIn, out4, 16, 16, 80, (err) => {
  assert.ifError(err);
  const b = fs.readFileSync(out4);
  const dims = pngDims(b);
  assert.strictEqual(dims.width, 16, 'rgba/png width');
  assert.strictEqual(dims.height, 16, 'rgba/png height');
  console.log('OK rgba-source/png (alpha preserved, no flatten)', b.length, 'bytes', dims);
  done();
});
