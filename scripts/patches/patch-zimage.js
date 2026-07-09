const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'zimage');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'index.js');
// Unlike zjxl (require('./build/linux_x64/jxl.node')), the real zimage index.js
// resolves the addon as `${__dirname}/${os}/zimage.node` (no "build/" segment) — see
// getOS()/getLib() below. So the linux addon must live directly under linux_x64/,
// i.e. DEST_DIR = app/native/nativelibs/zimage/linux_x64, not .../build/linux_x64.
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zimage', 'linux_x64');

// The mac bundle ships dylibs next to the addon; on Linux we bundle the pinned .so
// closure next to zimage.node and set RPATH=$ORIGIN so it loads those, not any
// system libvips (which likely doesn't exist or is the wrong version/ABI).
// zimage.cc only calls the libvips C API (no vips::VImage C++ symbols), so the
// linker's --as-needed drops the otherwise-linked libvips-cpp.so.42 from NEEDED —
// the real closure is libvips.so.42 + its glib/gio/gobject/gmodule/ffi/z deps.
const MIN_BUNDLED_LIBS = 5;

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
      // e.g. "  libvips.so.42 => /path/to/lib/libvips.so.42 (0x...)"
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

// Splice a linux branch into getOS(). Unlike zjxl's getLib() (which returns the
// require'd addon directly), zimage's getOS() assigns a module-scoped `os` variable
// and has no return value; getLib() later does `require(`${__dirname}/${os}/zimage.node`)`.
// Anchor on the darwin branch (nested arch check, no return statements):
//   } else if (process.platform === 'darwin') {
//     if (process.arch === 'arm64') { os = 'darwin_arm64'; } else { os = 'darwin_x64'; }
//   }
// and append an `else if (process.platform === 'linux') { os = 'linux_x64'; }` right
// after it, still inside getOS().
const ANCHOR_RE = /else if\s*\(\s*process\.platform === 'darwin'\s*\)\s*\{\s*if\s*\(\s*process\.arch === 'arm64'\s*\)\s*\{\s*os = 'darwin_arm64';\s*\}\s*else\s*\{\s*os = 'darwin_x64';\s*\}\s*\}/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("os = 'linux_x64'")) return; // idempotent
  if (!ANCHOR_RE.test(c)) {
    throw new Error("patch-zimage: darwin getOS anchor not found in index.js — bundle format changed, update the splice");
  }
  const replacement = (m) => m + " else if (process.platform === 'linux') {\n\t\tos = 'linux_x64';\n\t}";
  fs.writeFileSync(indexPath, c.replace(ANCHOR_RE, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) throw new Error(`zimage source missing at ${LIB_DIR}/binding.gyp`);

  // 1. Heavy deps (cache hit after first build).
  logger.info('Ensuring zimage deps-prefix...');
  execSync(`bash "${path.join(LIB_DIR, 'scripts', 'build-deps.sh')}"`, { cwd: LIB_DIR, stdio: 'inherit' });
  // deps-hash.js only prints the prefix when run as a CLI (require.main check) — must execSync, not require.
  const prefix = execSync(`node "${path.join(LIB_DIR, 'scripts', 'deps-hash.js')}"`, { cwd: LIB_DIR }).toString().trim();
  const libDir = path.join(prefix, 'lib');
  if (!fs.existsSync(libDir)) throw new Error(`patch-zimage: deps-prefix lib dir missing: ${libDir}`);

  // 2. Addon (rebuilt every patch, like db-cross-v4).
  logger.info('Building zimage addon...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  const releaseNode = path.join(LIB_DIR, 'build', 'Release', 'zimage.node');
  if (!fs.existsSync(releaseNode)) throw new Error('zimage build produced no zimage.node');

  // 3. Bundle .node + its full pinned .so closure into linux_x64/ (mirror mac layout).
  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'zimage.node');
  fs.copyFileSync(releaseNode, destNode);

  const closure = resolvePinnedClosure(releaseNode, libDir);
  if (closure.size < MIN_BUNDLED_LIBS) {
    throw new Error(`patch-zimage: computed .so closure has only ${closure.size} libs, expected >= ${MIN_BUNDLED_LIBS} — deps-prefix or build changed unexpectedly`);
  }
  const bundledSonames = [];
  for (const [soname, realPath] of closure) {
    fs.copyFileSync(realPath, path.join(DEST_DIR, soname));
    bundledSonames.push(soname);
  }
  logger.dim(`Bundled ${bundledSonames.length} .so: ${bundledSonames.join(', ')}`);

  // Set RPATH=$ORIGIN on the addon AND every bundled .so, so inter-library refs
  // (e.g. libvips -> libglib/libgobject/libgio) resolve within linux_x64/ without
  // LD_LIBRARY_PATH. The bundled glib is a single shared copy (Task 3 fixed the
  // static-glib double-registration issue) — under Electron the system glib (loaded
  // first for GTK) wins SONAME resolution and the bundled one just sits unused;
  // under plain Node the bundled one is used. No conflict either way.
  const elfFiles = [destNode, ...bundledSonames.map(s => path.join(DEST_DIR, s))];
  for (const f of elfFiles) {
    execSync(`patchelf --set-rpath '$ORIGIN' "${f}"`, { stdio: 'inherit' });
  }

  // 4. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error(`zimage/index.js not found — did extraction overlay app.asar.unpacked?`);
  spliceLinuxBranch(INDEX_JS);

  // 5. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) throw new Error('patch-zimage: zimage.node missing/empty');
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-zimage: zimage.node is not an ELF file');
  }
  for (const soname of bundledSonames) {
    const p = path.join(DEST_DIR, soname);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) throw new Error(`patch-zimage: bundled lib missing/empty: ${p}`);
  }
  const dynSection = execSync(`readelf -d "${destNode}"`).toString();
  if (!/(RUNPATH|RPATH\)).*\$ORIGIN/.test(dynSection)) {
    throw new Error('patch-zimage: zimage.node has no RUNPATH/RPATH=$ORIGIN after patchelf');
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("os = 'linux_x64'")) {
    throw new Error('patch-zimage: linux branch not present in index.js after splice');
  }

  logger.success('zimage installed');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
