const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'file-utilities');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'linux_x64');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'index.js');
const BUILT_SO = path.join(LIB_DIR, 'target', 'release', 'libfile_utilities.so');

// Splice a `case 'linux':` returning the linux_x64 addon, right before `default:`.
const ANCHOR_RE = /(\n\s*)default:\s*\n\s*throw new Error\(`Unsupported OS/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("'linux_x64', 'file-utilities.node'")) return; // idempotent
  if (!ANCHOR_RE.test(c)) {
    throw new Error("patch-file-utilities: getPlatformPath() default branch not found — bundle format changed, update the splice");
  }
  const replacement =
    "$1case 'linux':$1  return join(__dirname, 'linux_x64', 'file-utilities.node');$1default:\n      throw new Error(`Unsupported OS";
  fs.writeFileSync(indexPath, c.replace(ANCHOR_RE, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'Cargo.toml'))) {
    throw new Error(`file-utilities source missing at ${LIB_DIR}/Cargo.toml`);
  }

  // 1. Build the Rust addon (N-API ABI-stable; no Electron headers needed).
  logger.info('Building file-utilities addon (cargo)...');
  execSync('cargo build --release', { cwd: LIB_DIR, stdio: 'inherit' });
  if (!fs.existsSync(BUILT_SO)) throw new Error(`file-utilities build produced no ${BUILT_SO}`);

  // 2. Deploy: rename the cdylib to <name>.node under linux_x64/.
  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'file-utilities.node');
  fs.copyFileSync(BUILT_SO, destNode);

  // 3. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error('file-utilities/index.js not found — did extraction overlay app.asar.unpacked?');
  spliceLinuxBranch(INDEX_JS);

  // 4. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) throw new Error('patch-file-utilities: .node missing/empty');
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-file-utilities: .node is not an ELF file');
  }
  // Reject any non-system shared-lib dependency.
  const ldd = execSync(`ldd "${destNode}"`).toString();
  const bad = ldd.split('\n').filter((l) => /=>/.test(l) && !/\/(lib|lib64|usr\/lib)\S*\/(libc|libgcc_s|libm|libpthread|libdl|librt|ld-linux)/.test(l) && !/linux-vdso/.test(l));
  if (bad.length) {
    throw new Error(`patch-file-utilities: unexpected non-system deps:\n${bad.join('\n')}`);
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("'linux_x64', 'file-utilities.node'")) {
    throw new Error('patch-file-utilities: linux require not present in index.js after splice');
  }

  logger.success('file-utilities installed');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
