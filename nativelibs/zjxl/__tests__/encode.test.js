// Runs the built addon under Electron's Node ABI (ELECTRON_RUN_AS_NODE) — no display.
// Round-trip test for bitmapToJxl: raw RGB bitmap -> JXL (byte-contract encode) ->
// getJxlInfo (dimensions) -> jxlToJpeg (peer-decodable round-trip).
const path = require('path'), fs = require('fs'), assert = require('assert');
const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));

const W = 4, H = 4;

// Build a small 3-channel RGB gradient (the mac encode path is 3ch RGB, not RGBA).
function makeRgb(w, h) {
  const bmp = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    bmp[i * 3] = (i * 10) & 0xff;
    bmp[i * 3 + 1] = (i * 5) & 0xff;
    bmp[i * 3 + 2] = (255 - i * 10) & 0xff;
  }
  return bmp;
}

let pending = 2;
function done() { if (--pending === 0) console.log('ALL ENCODE TESTS PASSED'); }

// --- Test 1: 3-channel RGB encode -> signature + info + jxlToJpeg round-trip ---
addon.bitmapToJxl({ buffer: makeRgb(W, H), width: W, height: H }, (err, jxl, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0, 'bitmapToJxl status OK');
  assert(Buffer.isBuffer(jxl) && jxl.length > 0, 'jxl buffer non-empty');
  // JXL codestream signature: FF 0A.
  assert.strictEqual(jxl[0], 0xff, 'JXL signature byte 0 (FF)');
  assert.strictEqual(jxl[1], 0x0a, 'JXL signature byte 1 (0A)');

  // getJxlInfo must recover the dimensions from the produced codestream.
  addon.getJxlInfo({ buffer: jxl }, (e2, info) => {
    assert.ifError(e2);
    assert.strictEqual(info.width, W, 'getJxlInfo width');
    assert.strictEqual(info.height, H, 'getJxlInfo height');

    // Peer-decodability: the produced JXL must decode cleanly back through the
    // addon's already-implemented jxlToJpeg (baseline JPEG SOI/EOI).
    addon.jxlToJpeg({ buffer: jxl, quality: 0.9 }, (e3, jpeg, s3) => {
      assert.ifError(e3);
      assert.strictEqual(s3, 0, 'jxlToJpeg round-trip status OK');
      assert(Buffer.isBuffer(jpeg) && jpeg.length > 4, 'round-trip jpeg non-empty');
      assert.strictEqual(jpeg[0], 0xff, 'round-trip JPEG SOI byte 0');
      assert.strictEqual(jpeg[1], 0xd8, 'round-trip JPEG SOI byte 1');
      fs.writeFileSync('/tmp/zjxl-enc.jxl', jxl);
      console.log('OK bitmapToJxl(RGB)', jxl.length, 'bytes ->', W + 'x' + H,
                  '-> jpeg', jpeg.length, 'bytes');
      done();
    });
  });
});

// --- Test 2: 4-channel RGBA input is accepted (alpha dropped -> 3ch RGB output) ---
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = (i * 10) & 0xff;
  rgba[i * 4 + 1] = (i * 5) & 0xff;
  rgba[i * 4 + 2] = (255 - i * 10) & 0xff;
  rgba[i * 4 + 3] = 255;
}
addon.bitmapToJxl({ buffer: rgba, width: W, height: H }, (err, jxl, status) => {
  assert.ifError(err);
  assert.strictEqual(status, 0, 'bitmapToJxl(RGBA) status OK');
  assert.strictEqual(jxl[0], 0xff, 'RGBA JXL signature byte 0');
  assert.strictEqual(jxl[1], 0x0a, 'RGBA JXL signature byte 1');
  addon.getJxlInfo({ buffer: jxl }, (e2, info) => {
    assert.ifError(e2);
    assert.strictEqual(info.width, W, 'RGBA getJxlInfo width');
    assert.strictEqual(info.height, H, 'RGBA getJxlInfo height');
    console.log('OK bitmapToJxl(RGBA->RGB)', jxl.length, 'bytes');
    done();
  });
});
