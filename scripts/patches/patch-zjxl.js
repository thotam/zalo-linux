const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'zjxl');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'build', 'linux_x64');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'zjxl', 'index.js');

// The mac bundle ships dylibs next to the addon; on Linux we bundle the pinned .so
// closure next to jxl.node and set RPATH=$ORIGIN so it loads those, not any system
// libjxl/opencv (which likely don't exist or are the wrong version/ABI).
const MIN_BUNDLED_LIBS = 9; // known closure today: jxl, jxl_threads, jxl_cms, turbojpeg,
                            // opencv_core, opencv_imgproc, brotlidec, brotlienc, brotlicommon

// Resolve the full recursive .so closure of `binaryPath` that lives under `libDir`
// (our pinned deps-prefix/lib), skipping system libs (libc, libstdc++, ld-linux, ...).
// Returns a map of soname -> absolute real path (symlinks dereferenced).
function resolvePinnedClosure(binaryPath, libDir) {
  const seen = new Map(); // soname -> real path
  const queue = [binaryPath];
  const visited = new Set();

  while (queue.length) {
    const target = queue.shift();
    if (visited.has(target)) continue;
    visited.add(target);

    const out = execSync(`ldd "${target}"`, { env: { ...process.env, LD_LIBRARY_PATH: libDir } }).toString();
    for (const line of out.split('\n')) {
      // e.g. "  libjxl.so.0.9 => /path/to/lib/libjxl.so.0.9 (0x...)"
      const m = line.match(/^\s*(\S+)\s+=>\s+(\S+)\s+\(/);
      if (!m) continue;
      const [, soname, resolved] = m;
      if (!resolved.startsWith(libDir + path.sep) && resolved !== libDir) continue; // system lib, skip
      if (seen.has(soname)) continue;
      const real = fs.realpathSync(resolved); // dereference symlinks -> the real file
      seen.set(soname, real);
      queue.push(resolved); // recurse into this lib's own deps
    }
  }
  return seen;
}

// Splice the linux branch into the `else { return { error: 'not support' } }` block.
// Whitespace-tolerant (the "}"/"else" can be same-line or wrapped) so it matches both
// the real extracted index.js and a minimal stub used for testing.
const ANCHOR_RE = /\}\s*else\s*\{\s*return\s*\{\s*error:\s*'not support'\s*\}\s*;\s*\}/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("require('./build/linux_x64/jxl.node')")) return; // idempotent
  if (!ANCHOR_RE.test(c)) {
    throw new Error("patch-zjxl: 'not support' anchor not found in index.js — bundle format changed, update the splice");
  }
  const replacement =
    "} else if (process.platform === 'linux') {\n" +
    "    nodeAddon = require('./build/linux_x64/jxl.node');\n" +
    "  } else {\n    return { error: 'not support' };\n  }";
  fs.writeFileSync(indexPath, c.replace(ANCHOR_RE, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) throw new Error(`zjxl source missing at ${LIB_DIR}/binding.gyp`);

  // 1. Heavy deps (cache hit after first build).
  logger.info('Ensuring zjxl deps-prefix...');
  execSync(`bash "${path.join(LIB_DIR, 'scripts', 'build-deps.sh')}"`, { cwd: LIB_DIR, stdio: 'inherit' });
  // deps-hash.js only prints the prefix when run as a CLI (require.main check) — must execSync, not require.
  const prefix = execSync(`node "${path.join(LIB_DIR, 'scripts', 'deps-hash.js')}"`, { cwd: LIB_DIR }).toString().trim();
  const libDir = path.join(prefix, 'lib');
  if (!fs.existsSync(libDir)) throw new Error(`patch-zjxl: deps-prefix lib dir missing: ${libDir}`);

  // 2. Addon (rebuilt every patch, like db-cross-v4).
  logger.info('Building zjxl addon...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  const releaseNode = path.join(LIB_DIR, 'build', 'Release', 'jxl.node');
  if (!fs.existsSync(releaseNode)) throw new Error('zjxl build produced no jxl.node');

  // 3. Bundle .node + its full pinned .so closure into linux_x64/ (mirror mac layout).
  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'jxl.node');
  fs.copyFileSync(releaseNode, destNode);

  const closure = resolvePinnedClosure(releaseNode, libDir);
  if (closure.size < MIN_BUNDLED_LIBS) {
    throw new Error(`patch-zjxl: computed .so closure has only ${closure.size} libs, expected >= ${MIN_BUNDLED_LIBS} — deps-prefix or build changed unexpectedly`);
  }
  const bundledSonames = [];
  for (const [soname, realPath] of closure) {
    fs.copyFileSync(realPath, path.join(DEST_DIR, soname));
    bundledSonames.push(soname);
  }
  logger.dim(`Bundled ${bundledSonames.length} .so: ${bundledSonames.join(', ')}`);

  // Set RPATH=$ORIGIN on the addon AND every bundled .so, so inter-library refs
  // (e.g. libjxl -> libbrotli*) resolve within linux_x64/ without LD_LIBRARY_PATH.
  const elfFiles = [destNode, ...bundledSonames.map(s => path.join(DEST_DIR, s))];
  for (const f of elfFiles) {
    execSync(`patchelf --set-rpath '$ORIGIN' "${f}"`, { stdio: 'inherit' });
  }

  // 4. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error(`zjxl/index.js not found — did extraction overlay app.asar.unpacked?`);
  spliceLinuxBranch(INDEX_JS);

  // 5. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) throw new Error('patch-zjxl: jxl.node missing/empty');
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-zjxl: jxl.node is not an ELF file');
  }
  for (const soname of bundledSonames) {
    const p = path.join(DEST_DIR, soname);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) throw new Error(`patch-zjxl: bundled lib missing/empty: ${p}`);
  }
  const dynSection = execSync(`readelf -d "${destNode}"`).toString();
  if (!/(RUNPATH|RPATH\)).*\$ORIGIN/.test(dynSection)) {
    throw new Error('patch-zjxl: jxl.node has no RUNPATH/RPATH=$ORIGIN after patchelf');
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("require('./build/linux_x64/jxl.node')")) {
    throw new Error('patch-zjxl: linux require not present in index.js after splice');
  }

  logger.success('zjxl installed');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
