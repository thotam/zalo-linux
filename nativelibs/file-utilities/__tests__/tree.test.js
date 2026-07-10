const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const t = addon.getDirectorySizeTreeSync(root, { maxDepth: 3 });
    assert.strictEqual(t.depth, 0, 'root depth 0');
    assert.strictEqual(t.size, 3800, `root subtree size ${t.size} != 3800`);
    assert.ok(Array.isArray(t.children), 'children is array');
    // find the 'sub' child
    const sub = t.children.find((c) => c.name === 'sub');
    assert.ok(sub, 'sub child present');
    assert.strictEqual(sub.depth, 1, 'sub depth 1');
    // sub subtree = c.txt(500)+d.txt(300)+a-link(dedup with a.bin at root: counted at whichever visited first)
    assert.ok(sub.size >= 800, `sub size ${sub.size} >= 800`);
    assert.strictEqual(sub.relativePath, 'sub', 'relativePath');

    // maxDepth 0 -> no children expanded
    const t0 = addon.getDirectorySizeTreeSync(root, { maxDepth: 0 });
    assert.strictEqual(t0.children.length, 0, 'maxDepth 0 -> no children');
    assert.strictEqual(t0.size, 3800, 'maxDepth 0 size still full subtree');

    const ta = await addon.getDirectorySizeTreeAsync(root, { maxDepth: 2 }, 3);
    assert.strictEqual(ta.size, 3800, 'async tree size');

    assert.throws(() => addon.getDirectorySizeTreeSync(root, { maxDepth: -1 }), /max_depth|>= 0/i);
    console.log('OK tree: recursive sizes + depth + relativePath + maxDepth clamp');
  } finally {
    h.rmFixture(root);
  }
})();
