const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-fix-'));
  // top-level files
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(1000, 1));   // 1000 bytes
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.alloc(2000, 2));   // 2000 bytes
  // nested dirs
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'c.txt'), Buffer.alloc(500, 3));     // 500 bytes
  const deep = path.join(sub, 'deep');
  fs.mkdirSync(deep);
  fs.writeFileSync(path.join(deep, 'd.txt'), Buffer.alloc(300, 4));    // 300 bytes
  // hardlink to a.bin (must be counted ONCE)
  fs.linkSync(path.join(root, 'a.bin'), path.join(sub, 'a-link.bin'));
  // symlink (must NOT be summed)
  fs.symlinkSync(path.join(root, 'b.bin'), path.join(sub, 'b-symlink.bin'));
  return { root };
}

// Independent oracle matching the addon's walk semantics EXACTLY: regular files
// only (no directories, no symlinks — `find -type f`), hardlinks deduped by
// (device, inode), apparent sizes (st_size) summed. Do NOT use `du`: with
// --apparent-size it also counts each symlink's own size (the byte length of
// its stored target path) and directory inode sizes, which walk_size does not —
// making it both wrong and host-dependent (target length varies with tmpdir).
function expectedFileBytes(dir) {
  const rows = execSync(`find "${dir}" -type f -printf '%D:%i %s\\n'`).toString().trim().split('\n').filter(Boolean);
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const sp = row.lastIndexOf(' ');
    const key = row.slice(0, sp);        // "device:inode"
    const size = parseInt(row.slice(sp + 1), 10);
    if (seen.has(key)) continue;          // dedup hardlink (same device+inode)
    seen.add(key);
    total += size;
  }
  return total;
}

function findFileCount(dir) {
  // count regular files, deduping hardlinks by (device, inode) — one per inode
  const rows = execSync(`find "${dir}" -type f -printf '%D:%i\\n'`).toString().trim().split('\n').filter(Boolean);
  return new Set(rows).size;
}

function statNlink(file) {
  return parseInt(execSync(`stat -c %h "${file}"`).toString().trim(), 10);
}

function statfsType(p) {
  return execSync(`stat -f -c %T "${p}"`).toString().trim();
}

function rmFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { makeFixture, expectedFileBytes, findFileCount, statNlink, statfsType, rmFixture };
