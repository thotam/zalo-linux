// Tests for jxlDecompressMulti — the BATCH decode-and-resize path.
//
// Contract RE'd from the mac binary (see src/multi.cc header + RE-PARAMS.md
// "Resize path"): the single input JXL is decoded ONCE, then each tasks[] entry
// is resized with the mac's OpenCV TWO-STAGE pipeline (INTER_LINEAR pre-scale to
// a 1000px cap, then INTER_AREA to target — resizePPFWithOpenCV @0xb578) and
// RE-ENCODED TO JPEG (encodeJpegOneShotTurbo @0xb967). Output per task:
//   { data: Buffer|undefined, size, outputPath, width, height }
// The callback is (error, data=array, status_code); status_code===1 (SUCCESS).
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const addon = require(path.join(__dirname, '..', 'build', 'Release', 'jxl.node'));
const dir = path.join(__dirname, '..', '..', '..', 'scratchpad', 'jxl-samples');

const SUCCESS_STATUS = 1;

function info(buf) {
  return new Promise((resolve, reject) => {
    addon.getJxlInfo({ buffer: buf }, (e, d) => (e ? reject(e) : resolve(d)));
  });
}
function multi(opts) {
  return new Promise((resolve, reject) => {
    addon.jxlDecompressMulti(opts, (err, data, status_code) => {
      if (err) return reject(Object.assign(err, { status_code }));
      resolve({ data, status_code });
    });
  });
}
function isJpeg(buf) {
  // SOI FF D8 ... EOI FF D9
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[buf.length - 2] === 0xff &&
    buf[buf.length - 1] === 0xd9
  );
}
// clampSize oracle (verbatim from RE-PARAMS.md) to predict resize output dims.
function clampSize(sw, sh, cw, ch) {
  const fit = sw <= cw && sh <= ch;
  const area = (sw * sh) >>> 0;
  const both = sw > cw && sh > ch;
  if (fit || !(area > 0x10000000 || both)) return { w: sw, h: sh };
  const aspect = sw / sh;
  let hc = Math.trunc(cw / aspect);
  const nh = hc < ch ? hc : ch;
  const nw = Math.trunc(nh * aspect);
  return { w: nw, h: nh };
}
// Predict the two-stage OpenCV output dims for a downscale to (tw,th).
function predictDims(sw, sh, tw, th) {
  let w = sw, h = sh;
  if ((sw > 1000 && tw < 1000) || (sh > 1000 && th < 1000)) {
    const s1 = clampSize(sw, sh, 1000, 1000);
    w = s1.w; h = s1.h;
  }
  if (w > tw || h > th) {
    const s2 = clampSize(w, h, tw, th);
    w = s2.w; h = s2.h;
  }
  return { w, h };
}

(async () => {
  assert.strictEqual(typeof addon.jxlDecompressMulti, 'function', 'exported');

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jxl'));
  assert(files.length > 0, 'have JXL samples');
  // A >1000px sample (both dims) to exercise the two-stage resize.
  const bigName = files.find((f) => f.startsWith('z7974466650218')) || files[0];
  const jxl = fs.readFileSync(path.join(dir, bigName));
  const src = await info(jxl);
  console.log(`source ${bigName} -> ${src.width}x${src.height}`);
  assert(src.width > 1000 && src.height > 1000, 'sample exceeds 1000px both dims');

  // --- 1: default (no tasks) => 1 output at source size, inline JPEG ---
  const def = await multi({ buffer: jxl });
  assert.strictEqual(def.status_code, SUCCESS_STATUS, 'default: SUCCESS');
  assert(Array.isArray(def.data), 'default: data is array');
  assert.strictEqual(def.data.length, 1, 'default: exactly 1 output');
  const d0 = def.data[0];
  assert(isJpeg(d0.data), 'default: output is a JPEG buffer');
  assert.strictEqual(d0.width, src.width, 'default: source width');
  assert.strictEqual(d0.height, src.height, 'default: source height');
  assert.strictEqual(d0.size, d0.data.length, 'default: size == buffer length');
  assert.strictEqual(d0.outputPath, '', 'default: empty outputPath');
  console.log(`default -> 1 JPEG ${d0.width}x${d0.height} (${d0.size} bytes)`);

  // --- 1b: explicit empty tasks array => 0 outputs (mac @0x5fc7: the default
  // task is synthesized only when the "tasks" KEY is absent, not merely when
  // the parsed array is empty) ---
  const emptyTasks = await multi({ buffer: jxl, tasks: [] });
  assert.strictEqual(emptyTasks.status_code, SUCCESS_STATUS, 'emptyTasks: SUCCESS');
  assert(Array.isArray(emptyTasks.data), 'emptyTasks: data is array');
  assert.strictEqual(emptyTasks.data.length, 0, 'emptyTasks: tasks:[] yields 0 outputs');
  console.log('emptyTasks -> tasks:[] yields 0 outputs (tasks-key-absent default confirmed)');

  // --- 2: batch of resize tasks (exercise two-stage) ---
  const targets = [64, 256, 800];
  const res = await multi({
    buffer: jxl,
    quality: 0.9,
    tasks: targets.map((t) => ({ maxWidth: t, maxHeight: t })),
  });
  assert.strictEqual(res.status_code, SUCCESS_STATUS, 'batch: SUCCESS');
  assert.strictEqual(res.data.length, targets.length, 'batch: one output per task');
  res.data.forEach((o, i) => {
    const t = targets[i];
    assert(isJpeg(o.data), `batch[${i}]: JPEG`);
    assert.strictEqual(o.size, o.data.length, `batch[${i}]: size==len`);
    // Dims must match the mac two-stage clampSize math EXACTLY (note clampSize
    // only downscales when BOTH dims exceed the cap, so e.g. maxWidth=800 yields
    // 999x562, not <=800 — see RE-PARAMS.md clampSize quirk).
    const exp = predictDims(src.width, src.height, t, t);
    assert.strictEqual(o.width, exp.w, `batch[${i}]: width ${o.width}==${exp.w}`);
    assert.strictEqual(o.height, exp.h, `batch[${i}]: height ${o.height}==${exp.h}`);
    console.log(`  task maxWidth=${t} -> ${o.width}x${o.height} (${o.size} bytes)`);
  });
  // The 64px target from a 1920x1080 source must go through the 1000px pre-scale
  // (INTER_LINEAR: 1920x1080 -> 999x562) then INTER_AREA (999x562 -> 63x36).
  // That 63x36 (not 64x36) is the fingerprint of the TWO-STAGE path: a single
  // direct 1920->64 clampSize would give 64x36.
  const exp64 = predictDims(src.width, src.height, 64, 64);
  assert.strictEqual(exp64.w, 63, 'two-stage: 64 target -> width 63 (via 999px pre-scale)');
  assert.strictEqual(exp64.h, 36, 'two-stage: 64 target -> height 36');
  assert.strictEqual(res.data[0].width, 63, 'two-stage: actual 64-target width is 63');
  assert.strictEqual(res.data[0].height, 36, 'two-stage: actual 64-target height is 36');
  console.log('two-stage OpenCV resize confirmed (1000px INTER_LINEAR pre-scale -> INTER_AREA; 63x36 fingerprint)');

  // --- 3: outputPath => JPEG written to disk, data undefined ---
  const tmp = path.join(os.tmpdir(), `zjxl_multi_${process.pid}_${Date.now()}.jpg`);
  const fileRes = await multi({
    buffer: jxl,
    tasks: [{ maxWidth: 128, maxHeight: 128, outputPath: tmp }],
  });
  assert.strictEqual(fileRes.status_code, SUCCESS_STATUS, 'file: SUCCESS');
  const fo = fileRes.data[0];
  assert.strictEqual(fo.data, undefined, 'file: data is undefined');
  assert.strictEqual(fo.outputPath, tmp, 'file: outputPath echoed');
  assert(fs.existsSync(tmp), 'file: written to disk');
  const onDisk = fs.readFileSync(tmp);
  assert(isJpeg(onDisk), 'file: on-disk bytes are a JPEG');
  assert.strictEqual(fo.size, onDisk.length, 'file: size == on-disk length');
  fs.unlinkSync(tmp);
  console.log(`outputPath -> wrote ${fo.size}-byte JPEG ${fo.width}x${fo.height}, data undefined`);

  // --- 4: localPath input (decode from file) ---
  const lp = await multi({ localPath: path.join(dir, bigName), tasks: [{ maxWidth: 100, maxHeight: 100 }] });
  assert.strictEqual(lp.status_code, SUCCESS_STATUS, 'localPath: SUCCESS');
  assert(isJpeg(lp.data[0].data), 'localPath: JPEG output');
  console.log(`localPath -> ${lp.data[0].width}x${lp.data[0].height} JPEG`);

  console.log('OK multi.test.js — all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
