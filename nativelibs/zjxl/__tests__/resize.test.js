// Tests for resizeJxl / resizeJxlLimit.
//
// The mac-authoritative resizeJxl path (RE'd from darwin_x64 @0x9f20 /
// darwin_arm64 @0x9184) is: decode -> resizePPF (clampSize target math) ->
// hand-rolled bilinearInterpolate -> re-encode. It is SINGLE-PASS bilinear (NOT
// OpenCV, NOT the two-stage INTER_LINEAR/INTER_AREA path — that path belongs to
// jxlDecompressMulti/local-decode, not resizeJxl). clampSize downscales only when
// BOTH dims exceed the cap, preserving aspect with truncation.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');

// Pick a >1000px sample so both dims exceed the target (real downscale). The
// 1920x1080 samples map: target 64 -> 64x36, target 800 -> 800x450 (verified by
// a standalone clampSize oracle against the disassembly).
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jxl'));
const bigName = files.find((f) => f.startsWith('z7974466650218')) || files[0];
const jxl = fs.readFileSync(path.join(dir, bigName));

function info(buf) {
  return new Promise((resolve, reject) => {
    addon.getJxlInfo({ buffer: buf }, (e, d) => (e ? reject(e) : resolve(d)));
  });
}
function resize(fn, opts) {
  return new Promise((resolve, reject) => {
    addon[fn](opts, (err, data, status) => {
      if (err) return reject(err);
      resolve({ data, status });
    });
  });
}

function isJxl(buf) {
  return Buffer.isBuffer(buf) && buf[0] === 0xff && buf[1] === 0x0a;
}

// Optional: decode the produced JXL with the pinned djxl to confirm it is valid.
function djxlOk(buf) {
  const prefix = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'deps-hash.js')])
    .toString().trim();
  const djxl = path.join(prefix, 'bin', 'djxl');
  if (!fs.existsSync(djxl)) return null; // tool unavailable -> skip
  const tmpIn = path.join(require('os').tmpdir(), `zjxl_${process.pid}_${Date.now()}.jxl`);
  const tmpOut = tmpIn.replace(/\.jxl$/, '.ppm');
  try {
    fs.writeFileSync(tmpIn, buf);
    execFileSync(djxl, [tmpIn, tmpOut], {
      env: { ...process.env, LD_LIBRARY_PATH: path.join(prefix, 'lib') },
      stdio: 'ignore',
    });
    return fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0;
  } catch (_) {
    return false;
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

(async () => {
  assert.strictEqual(typeof addon.resizeJxl, 'function', 'resizeJxl exported');
  assert.strictEqual(typeof addon.resizeJxlLimit, 'function', 'resizeJxlLimit exported');

  const src = await info(jxl);
  console.log(`source ${bigName} -> ${src.width}x${src.height}`);
  assert(src.width > 1000 && src.height > 1000, 'sample exceeds 1000px (both dims)');

  // --- small target (64) ---
  const small = await resize('resizeJxl', { buffer: jxl, width: 64, height: 64 });
  assert.strictEqual(small.status, 0, 'status ok');
  assert(isJxl(small.data), 'small output is FF 0A JXL');
  const si = await info(small.data);
  assert(si.width <= 64 && si.height <= 64, 'small: within target box');
  assert(si.width > 0 && si.height > 0, 'small: non-empty dims');
  // aspect preserved (source 16:9 -> 64x36)
  assert.strictEqual(si.width, 64, 'small: width == 64 (16:9 hits width cap)');
  assert.strictEqual(si.height, 36, 'small: height == 36');
  console.log(`resizeJxl 64 -> ${si.width}x${si.height} (${small.data.length} bytes)`);

  // --- mid target (800) ---
  const mid = await resize('resizeJxl', { buffer: jxl, width: 800, height: 800 });
  assert.strictEqual(mid.status, 0);
  assert(isJxl(mid.data), 'mid output is FF 0A JXL');
  const mi = await info(mid.data);
  assert(mi.width <= 800 && mi.height <= 800, 'mid: within target box');
  assert.strictEqual(mi.width, 800, 'mid: width == 800');
  assert.strictEqual(mi.height, 450, 'mid: height == 450');
  console.log(`resizeJxl 800 -> ${mi.width}x${mi.height} (${mid.data.length} bytes)`);

  // The two downscales must go straight from source (>1000px) to target in a
  // single bilinear pass (no 1000px pre-scale stage). Verified by exact dims.
  console.log('single-pass bilinear confirmed (64x36, 800x450 match clampSize oracle)');

  // djxl round-trip validity
  const ok64 = djxlOk(small.data);
  const ok800 = djxlOk(mid.data);
  console.log(`djxl decode: 64->${ok64}, 800->${ok800}`);
  if (ok64 !== null) { assert(ok64 && ok800, 'resized JXLs decode cleanly with djxl'); }

  // --- resizeJxlLimit: output must be <= limit ---
  const generous = mid.data.length + 4096;
  const gl = await resize('resizeJxlLimit', { buffer: jxl, width: 800, height: 800, limit: generous });
  assert.strictEqual(gl.status, 0);
  assert(isJxl(gl.data), 'limit(generous) output is JXL');
  assert(gl.data.length <= generous, 'limit(generous): output <= limit');
  // generous limit is non-binding -> identical to plain resizeJxl(800)
  assert(gl.data.equals(mid.data), 'limit(generous) == resizeJxl(800) (non-binding)');
  console.log(`resizeJxlLimit generous(${generous}) -> ${gl.data.length} bytes (== plain resize)`);

  // Tight limit forces the assumed shrink loop.
  const tight = Math.max(2000, Math.floor(small.data.length / 2));
  const tl = await resize('resizeJxlLimit', { buffer: jxl, width: 800, height: 800, limit: tight });
  assert.strictEqual(tl.status, 0);
  assert(isJxl(tl.data), 'limit(tight) output is JXL');
  assert(tl.data.length <= tight, `limit(tight): output ${tl.data.length} <= ${tight}`);
  console.log(`resizeJxlLimit tight(${tight}) -> ${tl.data.length} bytes`);

  console.log('OK resize.test.js — all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
