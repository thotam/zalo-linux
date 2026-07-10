const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Linux port of the `file-utils` C++ node-addon-api addon (getDiskUsage).
//
// Distinct from `file-utilities` (Rust napi-rs, patch-file-utilities.js). The
// mac/win binary's Linux branch returns `{error:'not support'}`, so the app's
// Data-Management/Storage `getDiskUsage(path)` call degrades. This patch:
//   1. builds nativelibs/file-utils via node-gyp (builder.js),
//   2. installs the .node to app/.../file-utils/linux/,
//   3. splices a `process.platform === 'linux'` branch into index.js,
//   4. gates on ELF magic + system-only ldd (fail loud).
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'file-utils');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'linux');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'file-utils', 'index.js');

// Insert a linux branch right before the `else { return {error:'not support'} }`
// stub. Whitespace-tolerant so a reformat of the bundle still matches.
const ANCHOR_RE = /\}\s*else\s*\{\s*\n?\s*return\s*\{\s*error:\s*'not support'\s*\}\s*;/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("process.platform === 'linux'")) return; // idempotent
  if (!ANCHOR_RE.test(c)) {
    throw new Error("patch-file-utils: `else { return {error:'not support'} }` stub not found in file-utils/index.js — bundle format changed, update the splice");
  }
  const replacement =
    "} else if (process.platform === 'linux') {\n" +
    "    return require('./linux/file-utils-native.node');\n" +
    "  } else {\n" +
    "    return {error: 'not support'};";
  fs.writeFileSync(indexPath, c.replace(ANCHOR_RE, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
    throw new Error(`file-utils source missing at ${LIB_DIR}/binding.gyp`);
  }

  // 1. Build via node-gyp (node-addon-api, C++ exceptions ON — see binding.gyp).
  logger.info('Building file-utils-native from source...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  const releaseDir = path.join(LIB_DIR, 'build', 'Release');
  const nodeFiles = fs.readdirSync(releaseDir).filter((f) => f.endsWith('.node'));
  if (nodeFiles.length === 0) throw new Error('file-utils build produced no .node');

  // 2. Deploy.
  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'file-utils-native.node');
  fs.copyFileSync(path.join(releaseDir, nodeFiles[0]), destNode);
  logger.dim('Installed Linux file-utils-native.node');

  // 3. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) {
    throw new Error('file-utils/index.js not found — did extraction overlay app.asar.unpacked?');
  }
  spliceLinuxBranch(INDEX_JS);

  // 4. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) {
    throw new Error('patch-file-utils: .node missing/empty');
  }
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-file-utils: .node is not an ELF file');
  }
  // Reject any non-system shared-lib dependency (C++ addon → libstdc++ allowed).
  const ldd = execSync(`ldd "${destNode}"`).toString();
  const bad = ldd.split('\n').filter((l) =>
    /=>/.test(l) &&
    !/\/(lib|lib64|usr\/lib)\S*\/(libc|libstdc\+\+|libgcc_s|libm|libpthread|libdl|librt|ld-linux)/.test(l) &&
    !/linux-vdso/.test(l));
  if (bad.length) {
    throw new Error(`patch-file-utils: unexpected non-system deps:\n${bad.join('\n')}`);
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("process.platform === 'linux'")) {
    throw new Error('patch-file-utils: linux branch not present in index.js after splice');
  }
  // Load index.js the way the app does and assert getDiskUsage works.
  delete require.cache[require.resolve(INDEX_JS)];
  const lib = require(INDEX_JS);
  if (!lib || typeof lib.getDiskUsage !== 'function') {
    throw new Error('patch-file-utils: file-utils/index.js did not expose getDiskUsage on linux');
  }
  const probe = lib.getDiskUsage(process.cwd());
  if (!probe || typeof probe.total !== 'number' || probe.total <= 0) {
    throw new Error('patch-file-utils: getDiskUsage() returned no usable data');
  }

  logger.success('file-utils installed');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
