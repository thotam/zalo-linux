const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Linux port of the `zwalker` NAPI-RS Rust addon (storage garbage collector for the
// media download directory). Reconstructed from scratch (nativelibs/zwalker) from the
// mac binary's leaked crate layout + struct fields + the JS facade/orchestrator that
// drives it (see nativelibs/zwalker/RE-PARAMS.md).
//
//   1. cargo build --release -> target/release/libzwalker.so (N-API, ABI-stable),
//   2. deploy it as zwalker.linux-x64-gnu.node — the exact slot the addon's own
//      auto-generated napi loader (index.js) already probes on linux/glibc. No index.js
//      splice is needed: the loader require()s ./zwalker.linux-x64-gnu.node when present,
//      so simply dropping the real binary in place lights up all 5 functions and the
//      `if (!nativeBinding)` fallthrough is never reached.
//   3. gate: ELF + ldd shows only base system libs (Rust statically links everything
//      else) + the module actually loads and exports the 5 expected functions.
//
// NB: patch-linux-guards no longer touches zwalker — with the real binding present, the
// stub it used to inject would be dead code. This is the "real addon owns its own load"
// split (same as mp4thumb), leaving linux-guards to only short-circuit codesign.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'zwalker');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zwalker');
const BUILT_SO = path.join(LIB_DIR, 'target', 'release', 'libzwalker.so');
const DEST_NODE = path.join(DEST_DIR, 'zwalker.linux-x64-gnu.node');

const EXPECTED_EXPORTS = [
  'scanDirectory',
  'updateReferenceMessageId',
  'statUnmarkedFiles',
  'deleteHomelessFiles',
  'deleteEmptyFolders',
];

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'Cargo.toml'))) {
    throw new Error(`zwalker source missing at ${LIB_DIR}/Cargo.toml`);
  }

  // 1. Build the Rust addon (N-API ABI-stable; no Electron headers needed).
  logger.info('Building zwalker addon (cargo)...');
  execSync('cargo build --release', { cwd: LIB_DIR, stdio: 'inherit' });
  if (!fs.existsSync(BUILT_SO)) throw new Error(`zwalker build produced no ${BUILT_SO}`);

  // 2. Deploy: rename the cdylib into the napi loader's glibc slot.
  fs.ensureDirSync(DEST_DIR);
  fs.copyFileSync(BUILT_SO, DEST_NODE);
  logger.dim('Installed zwalker.linux-x64-gnu.node');

  // 3. Post-conditions (fail loud).
  if (!fs.existsSync(DEST_NODE) || fs.statSync(DEST_NODE).size === 0) {
    throw new Error('patch-zwalker: .node missing/empty');
  }
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(DEST_NODE, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-zwalker: .node is not an ELF file');
  }
  // Reject any non-system shared-lib dependency (Rust statics everything but libc/libgcc).
  const ldd = execSync(`ldd "${DEST_NODE}"`).toString();
  const bad = ldd.split('\n').filter((l) => /=>/.test(l) && !/linux-vdso/.test(l) &&
    !/\/(lib|lib64|usr\/lib)\S*\/(libc|libgcc_s|libm|libpthread|libdl|librt|ld-linux)/.test(l));
  if (bad.length) {
    throw new Error(`patch-zwalker: unexpected non-system deps:\n${bad.join('\n')}`);
  }
  // Load the addon exactly as the app will and assert the full API surface is present.
  const probe = path.join(require('os').tmpdir(), `zwalker-probe-${process.pid}.node`);
  fs.copyFileSync(DEST_NODE, probe);
  try {
    const mod = require(probe);
    for (const fn of EXPECTED_EXPORTS) {
      if (typeof mod[fn] !== 'function') {
        throw new Error(`patch-zwalker: addon does not export ${fn}()`);
      }
    }
  } finally {
    fs.removeSync(probe);
  }

  logger.success('zwalker installed');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
