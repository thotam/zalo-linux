const fs = require('fs');
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    // match only *.bin at top level: a.bin (1000) + b.bin (2000) = 3000, count 2
    // (sub/a-link.bin is a hardlink of a.bin, so it dedups away and does not
    // add a 3rd match here — this state is captured BEFORE extra.bin exists)
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

    // Add a DISTINCT (non-hardlinked) nested .bin file, deep under root, so the
    // top-level `*.bin` pattern is re-checked against a match that can only be
    // found if a single `*` crosses `/`. globset::Glob::new(pat).compile_matcher()
    // is used with its default literal_separator=false, so `*` DOES match
    // recursively across path separators — this is intended/faithful behavior
    // matching the mac binary's use of the same globset crate (verify on Mac).
    // Previously the only nested .bin (sub/a-link.bin) was a hardlink of a.bin,
    // so dedup coincidentally hid whether recursion actually happened. This new
    // file has distinct content/inode, so it must show up as its own match.
    fs.writeFileSync(path.join(root, 'sub', 'deep', 'extra.bin'), Buffer.alloc(7, 9));
    const r2 = addon.getDirectorySizeByGlobSync(pat);
    assert.strictEqual(r2.totalSize, 3007, `glob totalSize (post-extra) ${r2.totalSize} != 3007`);
    assert.strictEqual(r2.fileCount, 3, `glob fileCount (post-extra) ${r2.fileCount} != 3`);

    console.log('OK glob: matched-file sums correct, recursive * across / confirmed, bad pattern rejected');
  } finally {
    h.rmFixture(root);
  }
})();
