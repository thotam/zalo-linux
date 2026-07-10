const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Force Zalo's native image libs (zjxl / zimage) ON in the renderer bundles.
//
// Zalo routes image decode/resize through several strategies (Canvas 2D, WASM,
// native RE'd libs) and picks between them via remote-config feature flags that
// all DEFAULT to false — so on a fresh install the app uses Chromium/canvas/WASM
// and never calls the native libs (Zalo's gradual server-side rollout).
//
// That was fine on Electron 22 (Chromium 108 could decode JPEG-XL natively), but
// Chromium REMOVED JPEG-XL in 110 and only restored it in 145. Electron 39 ships
// Chromium 142 — squarely in the no-JXL window — so images that Zalo stores as
// .jxl (all received photos) can no longer be decoded by Chromium's <img>/Image,
// and messages show only a blurred placeholder. The native zjxl decoder DOES work
// on E39 (verified: all zjxl/zimage APIs pass end-to-end), so force the app to use
// it by flipping the feature flags on in the bundles:
//   - Object(<X>.jxlNativeSupported)()                         -> (!0)
//   - !<X>.image_resizer.enable_libvips_macos                  -> !1
//   - nestedKey("offload_config.enable_offload_*")             -> append ||!0
// (decode_jxl + jxl_resize display/thumbnail the received JXL; libvips/lipvips
// resize jpeg/png thumbnails; encode_jxl keeps upload on the same native path.)
// Output is byte-identical (these are the RE'd libs), so this only changes WHICH
// decoder runs, not the pixels.
// ---------------------------------------------------------------------------

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const MARKER = '/*__zjxl_native_forced__*/';

const OFFLOAD_FLAGS = [
  'offload_config.enable_offload_decode_jxl',
  'offload_config.enable_offload_jxl_resize',
  'offload_config.enable_offload_lipvips_resize', // (Zalo's typo, kept verbatim)
  'offload_config.enable_offload_encode_jxl',
];

function listBundles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const st = fs.statSync(fp);
    if (st.isDirectory()) { if (entry === 'lazy') out.push(...listBundles(fp)); continue; }
    if (entry.endsWith('.js')) out.push(fp);
  }
  return out;
}

function patchFile(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(MARKER)) return { n: 0, already: true };
  let n = 0;
  // 1. jxlNativeSupported() -> (!0)
  s = s.replace(/Object\([A-Za-z_$]+\.jxlNativeSupported\)\(\)/g, () => { n++; return '(!0)'; });
  // 2. !<X>.image_resizer.enable_libvips_macos -> !1
  s = s.replace(/!\w[\w.]*\.image_resizer\.enable_libvips_macos/g, () => { n++; return '!1'; });
  // 3. offload flags -> always-true
  for (const f of OFFLOAD_FLAGS) {
    const anchor = 'nestedKey("' + f + '")';
    const forced = anchor + '||!0';
    if (s.includes(anchor) && !s.includes(forced)) {
      const c = s.split(anchor).length - 1;
      s = s.split(anchor).join(forced);
      n += c;
    }
  }
  if (n > 0) { fs.writeFileSync(file, s + '\n' + MARKER, 'utf8'); }
  return { n, already: false };
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-native-image-flags: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }
  let total = 0, files = 0, already = 0;
  for (const file of listBundles(PC_DIST)) {
    const r = patchFile(file);
    if (r.already) { already++; continue; }
    if (r.n > 0) { files++; total += r.n; logger.dim(`native image flags -> ${path.basename(file)} (${r.n})`); }
  }
  if (total === 0 && already === 0) {
    throw new Error(
      'patch-native-image-flags: no jxlNativeSupported / libvips / offload flags found in any ' +
      'pc-dist bundle — the image-strategy config changed, re-derive the anchors.'
    );
  }
  logger.success(`native image flags forced: ${total} sites across ${files} bundles (${already} already)`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchFile };
