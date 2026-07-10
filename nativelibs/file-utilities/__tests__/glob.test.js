const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    // match only *.bin at top level: a.bin (1000) + b.bin (2000) = 3000, count 2
    const pat = path.join(root, '*.bin');
    const r = addon.getDirectorySizeByGlobSync(pat);
    assert.strictEqual(r.totalSize, 3000, `glob totalSize ${r.totalSize} != 3000`);
    assert.strictEqual(r.fileCount, 2, `glob fileCount ${r.fileCount} != 2`);

    // recursive: match all *.txt under root -> c.txt(500)+d.txt(300)=800, count 2
    const patTxt = path.join(root, '**', '*.txt');
    const rt = addon.getDirectorySizeByGlobSync(patTxt);
    assert.strictEqual(rt.totalSize, 800, `glob txt totalSize ${rt.totalSize} != 800`);

    const ra = await addon.getDirectorySizeByGlobAsync(pat, undefined, 2);
    assert.strictEqual(ra.totalSize, 3000, 'async glob total');

    assert.throws(() => addon.getDirectorySizeByGlobSync('['), /glob|pattern/i);
    console.log('OK glob: matched-file sums correct, bad pattern rejected');
  } finally {
    h.rmFixture(root);
  }
})();
