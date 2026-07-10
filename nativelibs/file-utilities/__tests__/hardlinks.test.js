const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const linked = path.join(root, 'a.bin');       // nlink == 2 (a.bin + sub/a-link.bin)
    const plain = path.join(root, 'b.bin');        // nlink == 1
    assert.strictEqual(h.statNlink(linked), 2);
    assert.strictEqual(h.statNlink(plain), 1);

    const r1 = addon.detectHardlinksSync(linked);
    assert.strictEqual(r1.isHardlink, true, 'a.bin isHardlink');
    assert.strictEqual(r1.linkCount, 2, 'a.bin linkCount');

    const r2 = addon.detectHardlinksSync(plain);
    assert.strictEqual(r2.isHardlink, false, 'b.bin isHardlink false');
    assert.strictEqual(r2.linkCount, 1, 'b.bin linkCount 1');

    const r3 = await addon.detectHardlinksAsync(linked);
    assert.strictEqual(r3.isHardlink, true, 'async isHardlink');

    // error path: a directory is not a regular file
    assert.throws(() => addon.detectHardlinksSync(root), /not a file|is not a file/i);
    console.log('OK hardlinks: nlink matches stat -c %h, dir rejected');
  } finally {
    h.rmFixture(root);
  }
})();
