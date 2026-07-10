const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const expBytes = h.expectedFileBytes(root);  // 3800
    const expCount = h.findFileCount(root);      // 4

    // sync
    const s = addon.getDirectorySizeSync(root);
    assert.strictEqual(s.totalSize, expBytes, `sync totalSize ${s.totalSize} != ${expBytes}`);
    assert.strictEqual(s.fileCount, expCount, `sync fileCount ${s.fileCount} != ${expCount}`);
    assert.strictEqual(typeof s.durationMs, 'number', 'durationMs is a number');

    // async (jobId is 3rd arg per the JS wrapper contract)
    const a = await addon.getDirectorySizeAsync(root, undefined, 1);
    assert.strictEqual(a.totalSize, expBytes, `async totalSize ${a.totalSize} != ${expBytes}`);
    assert.strictEqual(a.fileCount, expCount, `async fileCount ${a.fileCount} != ${expCount}`);

    // workers option must not change the result
    const w = addon.getDirectorySizeSync(root, { workers: 4 });
    assert.strictEqual(w.totalSize, expBytes, 'workers:4 same total');
    console.log('OK directory-size: sync+async match du/find oracle, dedup hardlink, skip symlink');
  } finally {
    h.rmFixture(root);
  }
})();
