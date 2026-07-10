const path = require('path');
const assert = require('assert');
// Node only auto-registers a native-addon loader for the ".node" extension;
// cargo's cdylib output on Linux is named ".so", so without this the file
// would fall through to the default ".js" (source-text) loader and fail
// with a SyntaxError. Register the same dlopen-based loader for ".so".
require.extensions['.so'] = require.extensions['.node'];
const addon = require(path.join(__dirname, '..', 'target', 'release', 'libfile_utilities.so'));
assert.strictEqual(typeof addon.ping, 'function', 'ping export missing');
assert.strictEqual(addon.ping(), 'pong');
console.log('OK smoke: addon loads and ping() works');
