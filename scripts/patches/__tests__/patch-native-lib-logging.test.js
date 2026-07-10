const fs = require('fs-extra'), path = require('path'), os = require('os'), assert = require('assert');

// ---------------------------------------------------------------------------
// 1. patchAggregator: wires the logging block into a replica aggregator,
//    idempotently, and fails loud when the aggregator shape changes.
// ---------------------------------------------------------------------------
const { patchAggregator } = require('../patch-native-lib-logging.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nlog-'));

// The real shim must sit next to the aggregator for require("./__zinstrument.js").
fs.copyFileSync(path.join(__dirname, '..', 'data', 'zinstrument.js'), path.join(tmp, '__zinstrument.js'));

const agg = path.join(tmp, 'index.js');
fs.writeFileSync(agg,
  'var instance = module.exports = {\n' +
  '  zjxl: () => require("./zjxl-stub.js"),\n' +
  '  zimage: (o) => require("./zimage-stub.js")(o),\n' +
  '  sqlite3: () => require("./sqlite3-stub.js"),\n' +
  '  nope: 5\n' +
  '};\n');

assert.strictEqual(patchAggregator(agg), 'wired', 'first run wires');
let c = fs.readFileSync(agg, 'utf8');
assert(c.includes('/*__znative_log__*/'), 'marker present');
assert.strictEqual(patchAggregator(agg), 'already', 'second run is a no-op');
assert.strictEqual(fs.readFileSync(agg, 'utf8'), c, 'idempotent: file unchanged');

// Fail-loud when the `var instance = module.exports = {` anchor is gone.
const bad = path.join(tmp, 'bad.js');
fs.writeFileSync(bad, 'module.exports = { zjxl: () => ({}) };');
assert.throws(() => patchAggregator(bad), /expected exactly 1/i, 'throws on anchor drift');

// ---------------------------------------------------------------------------
// 2. The wired aggregator actually instruments the libs it hands out, logging
//    to $ZALO_NATIVE_LOG — flat fns, promise-returning accessors, and
//    constructors (whose prototype methods stay UNWRAPPED = DB hot path safe).
// ---------------------------------------------------------------------------
const LOG = path.join(tmp, 'out.log');
process.env.ZALO_NATIVE_LOG = LOG;

// zjxl: flat object of (async) functions.
fs.writeFileSync(path.join(tmp, 'zjxl-stub.js'),
  'module.exports = { moduleReady: async () => true, ' +
  'getJxlInfo: async (b) => ({ width: 10, status_code: 0 }) };');
// zimage: function -> Promise<{Image:{thumbnail}}> (nested resolved value).
fs.writeFileSync(path.join(tmp, 'zimage-stub.js'),
  'module.exports = () => Promise.resolve({ Image: { thumbnail: async () => Buffer.alloc(7) } });');
// sqlite3: module with a Database CONSTRUCTOR whose methods live on the prototype.
fs.writeFileSync(path.join(tmp, 'sqlite3-stub.js'),
  'function Database(name){ this.name = name; }\n' +
  'Database.prototype.run = function(){ this.ran = true; return this; };\n' +
  'module.exports = { Database, OPEN_READWRITE: 2 };');

(async () => {
  const api = require(agg);

  // flat fns
  const zjxl = api.zjxl();
  assert.strictEqual(await zjxl.moduleReady(), true, 'moduleReady passes through');
  const info = await zjxl.getJxlInfo(Buffer.alloc(3));
  assert.strictEqual(info.width, 10, 'getJxlInfo return preserved');

  // identity is memoized across accessor calls
  assert.strictEqual(api.zjxl(), zjxl, 'accessor result memoized (stable identity)');

  // promise-returning accessor: resolved {Image} must be instrumented too
  const zimage = await api.zimage();
  const thumb = await zimage.Image.thumbnail();
  assert.strictEqual(thumb.length, 7, 'nested thumbnail return preserved');

  // constructor: instance works, prototype method runs, instanceof holds
  const sqlite3 = api.sqlite3();
  const db = new sqlite3.Database('mem');
  assert.strictEqual(db.name, 'mem', 'constructor ran');
  assert.strictEqual(db.run(), db, 'prototype method (hot path) works untouched');
  assert(db instanceof sqlite3.Database, 'instanceof preserved through wrapped constructor');
  assert.strictEqual(sqlite3.OPEN_READWRITE, 2, 'constants pass through');

  // give appendFileSync-based logging a tick, then assert the log captured calls
  const log = fs.readFileSync(LOG, 'utf8');
  assert(/CALL zjxl\.moduleReady/.test(log), 'logged flat fn call');
  assert(/RESOLVE zjxl\.getJxlInfo .*width:10/.test(log), 'logged resolve w/ summary');
  assert(/CALL zimage\.Image\.thumbnail/.test(log), 'logged nested (post-promise) fn call');
  assert(/NEW sqlite3\.Database/.test(log), 'logged constructor NEW');
  assert(!/CALL .*\.run\b/.test(log), 'prototype method NOT wrapped (DB hot path untouched)');

  fs.removeSync(tmp);
  console.log('OK patch-native-lib-logging');
})().catch((e) => { console.error(e); process.exit(1); });
