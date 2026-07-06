const { execSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');

// mapbox/TryGhost node-sqlite3 — its v6 N-API wrapper matches the bundle's own sqlite3.js.
const SQLITE_VERSION = '6.0.1';
// Fallback fork: statically bundles the SQLCipher amalgamation (no libsqlcipher0 runtime dep).
const FALLBACK_SPEC = '@journeyapps/sqlcipher@6.0.0';

// Electron shell version (ABI = N-API v6), pinned in root package.json.
const ELECTRON_VERSION = require(path.join(ROOT, 'package.json'))
  .devDependencies.electron.replace(/^[\^~]/, '');

const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding', 'napi-v6-linux-x64');
const DEST_NODE = path.join(DEST_DIR, 'node_sqlite3.node');
const SQLCIPHER_HEADER = '/usr/include/sqlcipher/sqlite3.h';

function sh(cmd, opts = {}) {
  logger.dim('$ ' + cmd);
  execSync(cmd, Object.assign({ stdio: 'inherit' }, opts));
}

// Isolated build dir anchored with a package.json so `npm install` installs HERE,
// never walking up into the repo's node_modules.
function mkScratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'zalo-native-build', private: true }) + '\n');
  return dir;
}

function nodeGyp(cwd, extraArgs, env) {
  const cmd = ['npx node-gyp rebuild', ...extraArgs,
    `--target=${ELECTRON_VERSION}`, '--arch=x64',
    '--dist-url=https://electronjs.org/headers'].join(' ');
  sh(cmd, { cwd, env: Object.assign({}, process.env, env || {}) });
}

// System dep: libsqlcipher-dev (headers under /usr/include/sqlcipher).
function ensureSqlcipherDev() {
  if (fs.existsSync(SQLCIPHER_HEADER)) { logger.dim('libsqlcipher headers: ' + SQLCIPHER_HEADER); return; }
  logger.info('Installing libsqlcipher-dev (requires sudo)...');
  try {
    sh('sudo apt-get update -qq');
    sh('sudo apt-get install -y libsqlcipher-dev');
  } catch (e) {
    throw new Error('Install libsqlcipher-dev manually: sudo apt-get install -y libsqlcipher-dev\n' + e.message);
  }
  if (!fs.existsSync(SQLCIPHER_HEADER)) {
    throw new Error('libsqlcipher-dev installed but header missing at ' + SQLCIPHER_HEADER);
  }
}

// PRIMARY: node-sqlite3 built from source, dynamically linking system libsqlcipher.
function buildPrimary() {
  ensureSqlcipherDev();
  const scratch = mkScratch('zalo-sqlite3-');
  logger.info(`PRIMARY: node-sqlite3@${SQLITE_VERSION} linked against system libsqlcipher`);
  sh(`npm install --no-save --ignore-scripts sqlite3@${SQLITE_VERSION}`, { cwd: scratch });
  const pkgDir = path.join(scratch, 'node_modules', 'sqlite3');
  if (!fs.existsSync(path.join(pkgDir, 'binding.gyp'))) throw new Error('node-sqlite3 source not fetched');

  // SQLCipher's sqlite3.h is in /usr/include/sqlcipher, NOT /usr/include. node-gyp folds env
  // CPPFLAGS into every compile (make.py: CXXFLAGS.target ?= $(CPPFLAGS) $(CXXFLAGS)), so this
  // makes `#include <sqlite3.h>` resolve. Prefer pkg-config; fall back to the fixed path.
  let cflags = '-I/usr/include/sqlcipher';
  try {
    const pc = execSync('pkg-config --cflags sqlcipher', { encoding: 'utf8' }).trim();
    if (pc) cflags = pc;
  } catch (_) { /* pkg-config or sqlcipher.pc absent — keep the fixed include path */ }

  nodeGyp(pkgDir, [
    '--napi_build_version=6',      // node-gyp 12.x won't set it; binding.gyp needs NAPI_VERSION=<(napi_build_version)
    '--sqlite=/usr',               // switch node-sqlite3 to external-link mode
    '--sqlite_libname=sqlcipher',  // -> links -lsqlcipher instead of -lsqlite3
  ], { CPPFLAGS: `${cflags} ${process.env.CPPFLAGS || ''}`.trim() });

  return path.join(pkgDir, 'build', 'Release', 'node_sqlite3.node');
}

// FALLBACK: @journeyapps/sqlcipher — binding.gyp hardcodes NAPI_VERSION=6 and compiles the
// bundled SQLCipher amalgamation with SQLITE_HAS_CODEC + SQLCIPHER_CRYPTO_OPENSSL (-lcrypto).
// No --napi/--sqlite flags needed; only runtime dep is libcrypto/OpenSSL.
function buildFallback() {
  const scratch = mkScratch('zalo-sqlcipher-');
  logger.info(`FALLBACK: ${FALLBACK_SPEC} (static SQLCipher amalgamation, links libcrypto)`);
  sh(`npm install --no-save --ignore-scripts ${FALLBACK_SPEC}`, { cwd: scratch });
  const jdir = path.join(scratch, 'node_modules', '@journeyapps', 'sqlcipher');
  if (!fs.existsSync(path.join(jdir, 'binding.gyp'))) throw new Error('@journeyapps/sqlcipher source not fetched');
  nodeGyp(jdir, []);
  return path.join(jdir, 'build', 'Release', 'node_sqlite3.node');
}

async function main() {
  let built;
  if (process.env.ZALO_SQLCIPHER_FALLBACK === '1') {
    built = buildFallback();
  } else {
    try {
      built = buildPrimary();
    } catch (e) {
      logger.warn('Primary SQLCipher build failed: ' + e.message);
      logger.warn('Falling back to ' + FALLBACK_SPEC + '...');
      built = buildFallback();
    }
  }
  if (!fs.existsSync(built)) throw new Error('SQLCipher build produced no node_sqlite3.node at ' + built);

  fs.ensureDirSync(DEST_DIR);
  fs.copyFileSync(built, DEST_NODE);
  logger.success('Installed SQLCipher node_sqlite3.node -> ' + DEST_NODE);

  // Fail-loud codec verification (child process so its exit code is captured, not our own).
  logger.info('Verifying SQLCipher codec is active...');
  try {
    sh(`node "${path.join(__dirname, 'verify-sqlite3.js')}"`, { cwd: ROOT });
  } catch (e) {
    throw new Error('SQLCipher verification FAILED — the built node_sqlite3.node lacks a working codec.');
  }
  logger.success('sqlite3 (SQLCipher) ready');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
