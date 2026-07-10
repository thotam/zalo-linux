// Load the cargo-built cdylib as a Node native addon.
// Node's require() only auto-registers the ".node" extension, not the cdylib's
// ".so" name, so alias it once here. Every test file requires this module
// instead of duplicating the shim.
const path = require('path');
require.extensions['.so'] = require.extensions['.node'];
module.exports = require(path.join(__dirname, '..', 'target', 'release', 'libfile_utilities.so'));
