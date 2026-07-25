const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'patch-call-incoming-enrich.js');
const { applyPatch, detectAlias, MARKER } = require(MOD);

const SAMPLE = 'x();const t={type:"control",data:e};this._sendToNative(t);y();';
const out = applyPatch(SAMPLE);
assert.ok(out.includes(MARKER), 'marker injected');
assert.ok(out.indexOf(MARKER) < out.indexOf('const t={type:"control"'), 'enrich runs before building t');
// idempotent
assert.strictEqual(applyPatch(out), out, 'idempotent');
// fail-loud
let threw = false; try { applyPatch('no anchor here'); } catch (e) { threw = true; }
assert.ok(threw, 'fail-loud when anchor missing');

// --- bundle-agnostic alias detection ---

// Bundle where the contact-store module aliases to `T` (matches the real znotification chunk).
const SAMPLE_T =
  'function getInitialData(e){let r=e||T.default.getUidMe();const c=T.default.getMiniInfo(r)||{};return c}' +
  'x();const t={type:"control",data:e};this._sendToNative(t);y();';
assert.strictEqual(detectAlias(SAMPLE_T), 'T', 'detects T alias via getMiniInfo');
const outT = applyPatch(SAMPLE_T);
assert.ok(outT.includes('T.default.getMiniInfo(_u)'), 'injected snippet uses detected alias T');
assert.ok(outT.indexOf(MARKER) < outT.indexOf('const t={type:"control"'), 'T-bundle: enrich runs before building t');

// Bundle where the SAME module aliases to `b` (matches compact-app-pc / sync-v2-sub-worker / search-worker).
const SAMPLE_B =
  'function getInitialData(e){let r=e||b.default.getUidMe();const c=b.default.getMiniInfo(r)||{};return c}' +
  'x();const t={type:"control",data:e};this._sendToNative(t);y();';
assert.strictEqual(detectAlias(SAMPLE_B), 'b', 'detects b alias via getMiniInfo');
const outB = applyPatch(SAMPLE_B);
assert.ok(outB.includes('b.default.getMiniInfo(_u)'), 'injected snippet uses detected alias b');
assert.ok(!outB.includes('T.default.getMiniInfo'), 'does not leak the other bundle\'s alias');

// Fallback: only getDName present (no getMiniInfo) still resolves an alias.
const SAMPLE_DNAME_ONLY = 'const e=q.default.getDName(n.noisedId);' + 'const t={type:"control",data:e};';
assert.strictEqual(detectAlias(SAMPLE_DNAME_ONLY), 'q', 'falls back to getDName to detect alias');

// No detectable alias at all -> detectAlias returns null (caller must skip enrichment, not inject T blindly).
assert.strictEqual(detectAlias('const t={type:"control",data:e};'), null, 'null when neither selector present');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK patch-call-incoming-enrich');
