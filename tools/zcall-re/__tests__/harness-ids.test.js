const assert = require('assert');
const path = require('path');
// harness.js runs a body on require (it loads the addon). Guard: it only reaches the
// addon load when executed as the CLI; we require it with a sentinel so it exports and
// returns early. The module must export resolveIds without needing the addon.
process.env.ZCALL_HARNESS_TEST = '1';
const { resolveIds } = require(path.join(__dirname, '..', 'harness.js'));

assert.deepStrictEqual(
  resolveIds({}),
  { fromId: 111, toId: 222, callId: 10, sessId: 'SP1CAPTURE' },
  'defaults');
assert.deepStrictEqual(
  resolveIds({ FROM_ID: '16909060', TO_ID: '84281096', CALL_ID: '287454020', SESS_ID: 'WIDECAP' }),
  { fromId: 16909060, toId: 84281096, callId: 287454020, sessId: 'WIDECAP' },
  'wide distinct-byte ids from env');
console.log('OK harness-ids');
