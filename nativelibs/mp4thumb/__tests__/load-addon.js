// Load the node-gyp-built addon. FFmpeg is statically linked into the .node
// (symbols hidden via -Wl,--exclude-libs,ALL), so it is fully self-contained —
// no sibling .so to resolve, a plain require works.
const path = require('path');
module.exports = require(path.join(__dirname, '..', 'build', 'Release', 'mp4thumb.node'));
