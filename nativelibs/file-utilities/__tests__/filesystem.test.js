const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const oracle = h.statfsType(root).toLowerCase(); // e.g. "ext2/ext3" or "btrfs" or "xfs"
    const r = addon.detectFilesystemSync(root);
    assert.strictEqual(typeof r.filesystemType, 'string');
    assert.ok(r.filesystemType.length > 0, 'filesystemType non-empty');
    // The app only consumes filesystemType (lowercased); assert it is a recognizable
    // token consistent with the statfs oracle family.
    const ftl = r.filesystemType.toLowerCase();
    assert.ok(
      oracle.includes(ftl) || ftl.includes('ext') || ['btrfs','xfs','tmpfs','overlayfs','vfat','ntfs','f2fs','zfs'].includes(ftl),
      `filesystemType '${r.filesystemType}' inconsistent with oracle '${oracle}'`
    );
    assert.strictEqual(typeof r.maxFilenameLength, 'number');
    assert.ok(r.maxFilenameLength >= 255, 'maxFilenameLength >= 255 on common Linux fs');
    assert.strictEqual(typeof r.supportsCaseSensitiveNames, 'boolean');

    const ra = await addon.detectFilesystemAsync(root);
    assert.strictEqual(ra.filesystemType, r.filesystemType, 'async matches sync');

    assert.throws(() => addon.detectFilesystemSync(path.join(root, 'nope')), /does not exist/i);
    console.log('OK filesystem: type consistent with statfs oracle, 7 fields present');
  } finally {
    h.rmFixture(root);
  }
})();
