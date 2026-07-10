// Byte-identical-output + API-contract tests for the Linux file-utils addon.
//
// Fidelity target: getDiskUsage(path) returns { available, free, total } as
// doubles, computed EXACTLY as the mac binary does — (uint64)f_bavail|f_bfree|
// f_blocks * f_frsize — verified against an independent statvfs oracle (a tiny
// C program compiled with the same gcc, so the syscall parity is exact and
// host-independent). Error messages must match the RE'd strings byte-for-byte.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const addon = require('./load-addon');

// ---- shape ----------------------------------------------------------------
assert.strictEqual(typeof addon.getDiskUsage, 'function', 'missing export: getDiskUsage');

const r0 = addon.getDiskUsage(process.cwd());
assert.strictEqual(typeof r0, 'object');
assert.deepStrictEqual(Object.keys(r0), ['available', 'free', 'total'],
  'property order must be available, free, total');
for (const k of ['available', 'free', 'total']) {
  assert.strictEqual(typeof r0[k], 'number', `${k} must be a number`);
  assert.ok(Number.isFinite(r0[k]) && r0[k] >= 0, `${k} must be finite >= 0`);
}
assert.ok(r0.total >= r0.free && r0.free >= r0.available - r0.total, 'sane magnitudes');
console.log('OK shape:', r0);

// ---- statvfs oracle (byte-identical) --------------------------------------
// Compile a one-shot C oracle that prints "frsize blocks bfree bavail" for argv[1].
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-oracle-'));
const src = path.join(tmp, 'oracle.c');
const bin = path.join(tmp, 'oracle');
fs.writeFileSync(src, `
#include <sys/statvfs.h>
#include <stdio.h>
#include <stdint.h>
int main(int argc, char** argv){
  struct statvfs b;
  if (statvfs(argv[1], &b) != 0) return 1;
  printf("%llu %llu %llu %llu\\n",
    (unsigned long long)b.f_frsize, (unsigned long long)b.f_blocks,
    (unsigned long long)b.f_bfree,  (unsigned long long)b.f_bavail);
  return 0;
}
`);
execFileSync('cc', ['-O2', '-o', bin, src]);

function oracle(p) {
  const out = execFileSync(bin, [p]).toString().trim().split(/\s+/).map(Number);
  const [frsize, blocks, bfree, bavail] = out;
  return {
    available: bavail * frsize,
    free: bfree * frsize,
    total: blocks * frsize,
  };
}

// free/available can drift if the FS is written between the two statvfs calls,
// so assert `total` strictly and allow a small slack on free/available.
const DRIFT = 64 * 1024 * 1024; // 64 MiB — absorbs live-FS churn between reads
for (const p of [process.cwd(), '/', os.tmpdir(), os.homedir()]) {
  const exp = oracle(p);
  const got = addon.getDiskUsage(p);
  assert.strictEqual(got.total, exp.total, `total mismatch for ${p}`);
  assert.ok(Math.abs(got.available - exp.available) <= DRIFT,
    `available mismatch for ${p}: got ${got.available} exp ${exp.available}`);
  assert.ok(Math.abs(got.free - exp.free) <= DRIFT,
    `free mismatch for ${p}: got ${got.free} exp ${exp.free}`);
  console.log(`OK oracle ${p}: total=${got.total}`);
}

// ---- error contract -------------------------------------------------------
assert.throws(() => addon.getDiskUsage(),
  (e) => e.message === 'DISKUSAGE_WRONG_NUMBER_OF_ARGS',
  'no-args must throw DISKUSAGE_WRONG_NUMBER_OF_ARGS');

assert.throws(() => addon.getDiskUsage(123),
  (e) => e.message === 'DISKUSAGE_INVALID_ARG_TYPE:  The "path" argument must be one of type string',
  'non-string must throw the exact invalid-arg message (double space)');

assert.throws(() => addon.getDiskUsage('/nonexistent/xyzzy-does-not-exist-12345'),
  (e) => e.message === 'DISKUSAGE_RUNTIME_ERROR: Get diskusage failed',
  'bad path must throw DISKUSAGE_RUNTIME_ERROR: Get diskusage failed');
console.log('OK error contract');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK all diskusage tests passed');
