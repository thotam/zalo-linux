const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Linux port of the `mp4thumb` C++ node-addon-api addon (video -> JPEG thumbnail),
// built on a pinned FFmpeg 5.1 (libavcodec 59.37.100) STATICALLY linked into the .node.
//
//   1. build the pinned FFmpeg static libs (scripts/build-deps.sh, content-addressed),
//   2. build the addon (node-gyp) — links the .a with -Wl,--exclude-libs,ALL so every
//      ffmpeg symbol is LOCAL to the .node. That is essential in Electron: the renderer/
//      utility processes preload Electron's own libffmpeg.so (RTLD_GLOBAL) which exports
//      the same av*/avformat_* symbols; a shared/bundled ffmpeg would be interposed onto
//      Chromium's ffmpeg (no `file` protocol) -> every call fails "Protocol not found".
//      Hidden static symbols make the .node self-contained and immune to that.
//   3. install the single self-contained .node into app/.../mp4thumb/linux/,
//   4. splice a linux branch into mp4thumb/index.js,
//   5. gate: ELF + ldd shows only base system libs (ffmpeg is static; libssl/libcrypto are
//      system OpenSSL 3 for the http/https video URLs the mac binary also supports).
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'mp4thumb');
const BUILD_DEPS = path.join(LIB_DIR, 'scripts', 'build-deps.sh');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'linux');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'mp4thumb', 'index.js');

// The mac index.js falls through to a darwin require on linux (then a throwing stub).
// Anchor directly on the pristine getLib() try-block and inject an exclusive linux
// branch loading our .node — self-contained, no dependency on patch-linux-guards.
const ANCHOR = `    try {\n        if(process.platform === 'win32') {`;
const REPLACEMENT = `    try {\n        if (process.platform === 'linux') {\n            thumbModule = require('./linux/mp4thumb.node');\n        } else if(process.platform === 'win32') {`;

function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("require('./linux/mp4thumb.node')")) return; // idempotent
  if (!c.includes(ANCHOR)) {
    throw new Error("patch-mp4thumb: linux-throw anchor not found in mp4thumb/index.js — bundle format changed, update the splice");
  }
  fs.writeFileSync(indexPath, c.replace(ANCHOR, REPLACEMENT), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
    throw new Error(`mp4thumb source missing at ${LIB_DIR}/binding.gyp`);
  }

  // 1. Build pinned FFmpeg static libs (idempotent, cached by content hash).
  logger.info('Building pinned FFmpeg for mp4thumb (build-deps.sh)...');
  execSync(`bash "${BUILD_DEPS}"`, { cwd: ROOT, stdio: 'inherit' });

  // 2. Build the addon (statically links ffmpeg, symbols hidden via --exclude-libs,ALL).
  logger.info('Building mp4thumb addon (node-gyp)...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });
  const releaseDir = path.join(LIB_DIR, 'build', 'Release');
  const built = path.join(releaseDir, 'mp4thumb.node');
  if (!fs.existsSync(built)) throw new Error('mp4thumb build produced no .node');

  // 3. Deploy the single self-contained .node. Clean any stale bundled .so from an
  //    earlier shared-ffmpeg approach (the static .node needs none).
  fs.ensureDirSync(DEST_DIR);
  for (const f of fs.readdirSync(DEST_DIR)) {
    if (/\.so(\.\d+)*$/.test(f)) fs.removeSync(path.join(DEST_DIR, f));
  }
  const destNode = path.join(DEST_DIR, 'mp4thumb.node');
  fs.copyFileSync(built, destNode);
  logger.dim('Installed self-contained mp4thumb.node (ffmpeg static, symbols hidden)');

  // 4. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error('mp4thumb/index.js not found — did extraction overlay app.asar.unpacked?');
  spliceLinuxBranch(INDEX_JS);

  // 5. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) {
    throw new Error('patch-mp4thumb: .node missing/empty');
  }
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-mp4thumb: .node is not an ELF file');
  }
  // ffmpeg is static -> no libav*/libsw* in ldd; only base system libs (libssl/libcrypto =
  // system OpenSSL 3 for http/https). Reject anything else (incl. a stray libav* = not static).
  const ldd = execSync(`ldd "${destNode}"`).toString();
  const bad = ldd.split('\n').filter((l) => {
    if (!/=>/.test(l) || /linux-vdso/.test(l)) return false;
    return !/\/(lib|lib64|usr\/lib)\S*\/(libc|libstdc\+\+|libgcc_s|libm|libz|libpthread|libdl|librt|libssl|libcrypto|ld-linux)/.test(l);
  });
  if (bad.length) {
    throw new Error(`patch-mp4thumb: unexpected non-system deps (ffmpeg should be static):\n${bad.join('\n')}`);
  }
  // No exported ffmpeg symbols (they must be hidden/local, else Electron's libffmpeg would
  // interpose them). Assert the .node does NOT export avformat_open_input.
  const exported = execSync(`nm -D "${destNode}" 2>/dev/null || true`).toString();
  if (/\bT (avformat_open_input|avcodec_send_packet)\b/.test(exported)) {
    throw new Error('patch-mp4thumb: ffmpeg symbols are EXPORTED by the .node — --exclude-libs,ALL failed, Electron libffmpeg would interpose them');
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("require('./linux/mp4thumb.node')")) {
    throw new Error('patch-mp4thumb: linux branch not present in index.js after splice');
  }
  // Load index.js the way the app does and assert the facade is exposed.
  delete require.cache[require.resolve(INDEX_JS)];
  const lib = require(INDEX_JS);
  if (!lib || typeof lib.generateThumbnail !== 'function' || typeof lib.cancel !== 'function') {
    throw new Error('patch-mp4thumb: mp4thumb/index.js did not expose generateThumbnail/cancel on linux');
  }

  logger.success('mp4thumb installed');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
