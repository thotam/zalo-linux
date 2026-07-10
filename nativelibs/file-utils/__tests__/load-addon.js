// Load the node-gyp-built addon. Unlike file-utilities (a cargo cdylib whose
// .so name must be aliased), node-gyp emits a real `.node`, so a plain require
// works. Centralized here so every test resolves the same build artifact.
const path = require('path');
module.exports = require(path.join(__dirname, '..', 'build', 'Release', 'file-utils-native.node'));
