// Functional + determinism + contract tests for the Linux mp4thumb addon.
//
// No system ffmpeg: a tiny C fixture-generator (gen-fixture.c) is compiled against
// the pinned FFmpeg and emits a synthetic JPEG, which the addon reads back as a
// 1-frame video (image2 demuxer) and thumbnails. We can't byte-compare against the
// mac binary (no Mac oracle) — byte-identity is by construction (pinned FFmpeg 5.1 +
// exact pipeline). We DO verify: valid JPEG, correct fit-inside-even dimensions,
// determinism (two runs byte-equal), async, cancel, and the error contract.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const addon = require('./load-addon');

const HERE = path.join(__dirname, '..');
const prefix = execFileSync('node', [path.join(HERE, 'scripts', 'deps-hash.js')]).toString().trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4thumb-'));

// ---- compile + run the fixture generator (link the pinned ffmpeg) ----
const genSrc = path.join(__dirname, 'gen-fixture.c');
const genBin = path.join(tmp, 'gen-fixture');
// FFmpeg is built static now — link the archives directly (group for circular deps).
const lib = (n) => path.join(prefix, 'lib', n);
execFileSync('cc', ['-O2', '-o', genBin, genSrc,
  '-I' + path.join(prefix, 'include'),
  '-Wl,--start-group', lib('libavcodec.a'), lib('libavutil.a'), lib('libswresample.a'), '-Wl,--end-group',
  '-lm', '-lpthread', '-lz']);

const fixture = path.join(tmp, 'fixture.jpg');
execFileSync(genBin, [fixture, '800', '600']);
assert.ok(fs.statSync(fixture).size > 0, 'fixture generated');

// ---- shape ----
assert.strictEqual(typeof addon.MP4Thumb, 'function', 'MP4Thumb class exported');
const t = new addon.MP4Thumb();
for (const m of ['generateThumbnail', 'generateThumbnailAsync', 'setOutputPath', 'cancel']) {
  assert.strictEqual(typeof t[m], 'function', `instance method ${m}`);
}
console.log('OK shape');

// Parse a baseline JPEG's SOF0 (0xFFC0) for [height, width].
function jpegDims(buf) {
  assert.strictEqual(buf[0], 0xff); assert.strictEqual(buf[1], 0xd8); // SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) { // SOF0/1/2
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { w, h };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

// ---- sync happy path + dimensions (fit-inside, even) ----
const out1 = path.join(tmp, 'out1.jpg');
const ok = t.generateThumbnail(fixture, out1, 320, 240);
assert.strictEqual(ok, true, 'generateThumbnail returns true');
const b1 = fs.readFileSync(out1);
assert.ok(b1[0] === 0xff && b1[1] === 0xd8 && b1[2] === 0xff, 'output is JPEG (FFD8FF)');
// src 800x600, scale=min(320/800,240/600)=0.4 -> 320x240 (already even)
assert.deepStrictEqual(jpegDims(b1), { w: 320, h: 240 }, 'fit-inside-even dims');
console.log('OK sync + dims', jpegDims(b1));

// ---- determinism: same input+params -> byte-identical output ----
const out2 = path.join(tmp, 'out2.jpg');
assert.strictEqual(t.generateThumbnail(fixture, out2, 320, 240), true);
assert.ok(fs.readFileSync(out2).equals(b1), 'two runs are byte-identical (deterministic)');
console.log('OK determinism (byte-identical across runs)');

// ---- never upscale ----
const outBig = path.join(tmp, 'big.jpg');
t.generateThumbnail(fixture, outBig, 4000, 4000);
assert.deepStrictEqual(jpegDims(fs.readFileSync(outBig)), { w: 800, h: 600 }, 'no upscale');
console.log('OK no-upscale');

// ---- async ----
(async () => {
  const outA = path.join(tmp, 'async.jpg');
  const okA = await t.generateThumbnailAsync(fixture, outA, 200, 200);
  assert.strictEqual(okA, true, 'async resolves true');
  // 800x600 -> scale=min(200/800,200/600)=0.25 -> 200x150
  assert.deepStrictEqual(jpegDims(fs.readFileSync(outA)), { w: 200, h: 150 }, 'async dims');
  console.log('OK async', jpegDims(fs.readFileSync(outA)));

  // ---- error contract ----
  assert.throws(() => t.generateThumbnail(),
    (e) => /Usage: generateThumbnail\(inputPath, outputPath/.test(e.message),
    'missing args -> Usage string');
  await assert.rejects(t.generateThumbnailAsync('/no/such/video.mp4', path.join(tmp, 'x.jpg')),
    (e) => /Could not open input file:/.test(e.message),
    'bad input -> Could not open input file');
  console.log('OK error contract');

  // ---- setOutputPath + cancel exist and behave ----
  t.setOutputPath(path.join(tmp, 'ignored.jpg'));
  assert.throws(() => t.setOutputPath(123), /Expected output path string/);
  t.cancel(); // no throw
  console.log('OK setOutputPath + cancel');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OK all mp4thumb tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
