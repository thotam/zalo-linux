#!/usr/bin/env node
// Standalone SQLCipher verifier for the installed Zalo sqlite3 binding.
// Proves the built node_sqlite3.node has a WORKING SQLCipher codec — not vanilla sqlite3,
// which silently ignores `PRAGMA key` and would store the Zalo DB in PLAINTEXT.
//
//   node scripts/patches/verify-sqlite3.js
//
// Runs under plain Node: the binding is pure N-API v6 (ABI-stable), so a napi-v6 module
// built against Electron 22 headers loads fine under Node 18+. To verify under the exact
// Electron runtime instead: xvfb-run -a npx electron scripts/patches/verify-sqlite3.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SLOT = path.join(ROOT, 'app', 'native', 'nativelibs', 'sqlite3',
  'binding', 'napi-v6-linux-x64', 'node_sqlite3.node');
const WRAPPER = path.join(ROOT, 'app', 'native', 'nativelibs', 'sqlite3', 'index.js');
const KEY = 'zalo-sqlcipher-verify-key';

function fail(msg) {
  console.error('\n\x1b[1m\x1b[31mSQLCIPHER VERIFY FAILED:\x1b[0m ' + msg + '\n');
  process.exit(1);
}

// [1/4] The binding must exist and be an ELF (Linux) shared object.
if (!fs.existsSync(SLOT)) fail('node_sqlite3.node missing at ' + SLOT);
const head4 = Buffer.alloc(4);
const fd = fs.openSync(SLOT, 'r');
fs.readSync(fd, head4, 0, 4, 0);
fs.closeSync(fd);
if (!(head4[0] === 0x7f && head4[1] === 0x45 && head4[2] === 0x4c && head4[3] === 0x46)) {
  fail('binding is not an ELF object (magic=' + head4.toString('hex') + ')');
}
console.log('[1/4] ELF magic OK: ' + SLOT);

// [2/4] Load it through the REAL Zalo code path (the bundle's own wrapper + loader).
let sqlite3;
try {
  sqlite3 = require(WRAPPER);
} catch (e) {
  fail('failed to load node_sqlite3.node via Zalo wrapper (' + WRAPPER + '): ' + e.message +
    '\n(A load error here usually means an N-API/ABI mismatch or a missing shared library — ' +
    'e.g. libsqlcipher0 not installed for the primary/system-linked build.)');
}
console.log('[2/4] Loaded binding through Zalo sqlite3 wrapper');

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-sqlcipher-')), 'probe.db');

function probe() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) reject(new Error('open failed: ' + err.message));
    });
    // serialize() guarantees PRAGMA key runs before any read/write.
    db.serialize(() => {
      db.exec("PRAGMA key='" + KEY + "'", (e) => {
        if (e) reject(new Error('PRAGMA key failed: ' + e.message));
      });
      db.get('PRAGMA cipher_version', (e, row) => {
        if (e) return reject(new Error('PRAGMA cipher_version errored: ' + e.message));
        const ver = row && row.cipher_version;
        if (!ver || String(ver).trim() === '') return reject(new Error('CIPHER_ABSENT'));
        db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42);', (e2) => {
          if (e2) return reject(new Error('encrypted write failed: ' + e2.message));
          db.close((e3) => (e3 ? reject(e3) : resolve(ver)));
        });
      });
    });
  });
}

probe().then((ver) => {
  console.log('[3/4] PRAGMA cipher_version => ' + JSON.stringify(ver));
  // [4/4] The file on disk must NOT start with the plaintext SQLite header.
  const magic = fs.readFileSync(dbPath).subarray(0, 16).toString('latin1');
  if (magic.startsWith('SQLite format 3')) {
    fail('DB on disk is PLAINTEXT ("SQLite format 3") — the codec did not encrypt. Build lacks SQLCipher.');
  }
  console.log('[4/4] On-disk header is not plaintext SQLite => database is encrypted');
  console.log('\n\x1b[1m\x1b[32mSQLCIPHER VERIFY PASSED\x1b[0m (codec active, DB encrypted)\n');
  process.exit(0);
}).catch((err) => {
  if (err.message === 'CIPHER_ABSENT') {
    fail('PRAGMA cipher_version returned EMPTY.\n' +
      'The built node_sqlite3.node is VANILLA sqlite3 with NO SQLCipher codec.\n' +
      'A vanilla build silently ignores "PRAGMA key" and would store the Zalo DB in PLAINTEXT.\n' +
      'Rebuild against libsqlcipher (see scripts/patches/patch-sqlite3.js) or set ' +
      'ZALO_SQLCIPHER_FALLBACK=1 to use the @journeyapps/sqlcipher static build.');
  }
  fail(err.message);
});
