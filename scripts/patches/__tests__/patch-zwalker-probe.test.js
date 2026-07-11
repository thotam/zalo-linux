const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

// patch-zwalker-probe appends a one-shot probe to the nativelibs aggregator, and only
// after the logging wiring exists. Validate: requires the log marker, wires once, is
// idempotent, and the appended block is syntactically valid JS.
const { patchAggregator } = require('../patch-zwalker-probe.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwp-'));
const agg = path.join(tmp, 'index.js');

// 1. Missing logging wiring -> throws.
fs.writeFileSync(agg, 'var instance = module.exports = { zwalker(){} };\n', 'utf8');
assert.throws(() => patchAggregator(agg), /run patch-native-lib-logging first/, 'refuses without log wiring');

// 2. With the log marker present -> wires once.
fs.writeFileSync(agg, 'var instance = module.exports = { zwalker(){} };\n/*__znative_log__*/\n', 'utf8');
assert.strictEqual(patchAggregator(agg), 'wired', 'wires when log marker present');
const once = fs.readFileSync(agg, 'utf8');
assert(once.includes('/*__zwalker_probe__*/'), 'probe marker inserted');
assert(once.includes('instance.zwalker()'), 'probe calls the instrumented accessor');

// 3. Idempotent.
assert.strictEqual(patchAggregator(agg), 'already', 'second run is a no-op');
assert.strictEqual(fs.readFileSync(agg, 'utf8'), once, 'no double-append');

// 4. The appended file parses as valid JS.
assert.doesNotThrow(() => new Function(fs.readFileSync(agg, 'utf8')), 'aggregator+probe is valid JS');

fs.removeSync(tmp);
console.log('OK patch-zwalker-probe');
