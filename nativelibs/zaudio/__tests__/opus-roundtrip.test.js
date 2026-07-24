const assert = require('assert');
const path = require('path');
const { ZAudio } = require(path.join(__dirname, '..', 'build', 'Release', 'zaudio.node'));

const a = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 });

// 20 ms of a 440 Hz sine at 16 kHz mono, int16 (320 samples).
const N = 320;
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 8000), i * 2);

const opus = a.encodeFrame(pcm);
assert.ok(Buffer.isBuffer(opus) && opus.length > 0 && opus.length < 400, 'opus frame produced');

const back = a.decodeFrame(opus);
assert.strictEqual(back.length, N * 2, 'decoded PCM is one 20 ms frame');
// opus is lossy — check the decoded frame carries real signal energy (not silence).
let energy = 0;
for (let i = 0; i < N; i++) { const s = back.readInt16LE(i * 2); energy += s * s; }
const rms = Math.sqrt(energy / N);
assert.ok(rms > 500, 'decoded frame has audio energy (rms=' + rms.toFixed(0) + ')');
console.log('OK zaudio opus-roundtrip (opus ' + opus.length + 'B, rms ' + rms.toFixed(0) + ')');
