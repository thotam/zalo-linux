const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP = path.join(__dirname, '..', '..', 'app');
const MAIN = path.join(APP, 'main-dist', 'main.js');
const NL = path.join(APP, 'native', 'nativelibs');
const ZWALKER = path.join(NL, 'zwalker', 'index.js');
const MP4THUMB = path.join(NL, 'mp4thumb', 'index.js');

// ---- (a) main.js: short-circuit checkAppSigned() on Linux -------------------
// Original (bundle 26.6.11) spawns macOS `codesign --verify <app>`; on Linux that
// fails. We return isAppSigned=false immediately (no spawn). Effect per spec §7:
// isAppSigned=false => secure key stored via safeStorage/libsecret if present,
// otherwise raw (accepted for v1).
const CAS_ANCHOR = 'async checkAppSigned(){return null!=this.isAppSigned?';
const CAS_PATCHED = "async checkAppSigned(){if(process.platform==='linux')return this.isAppSigned=!1,!1;return null!=this.isAppSigned?";
const CAS_MARKER = "async checkAppSigned(){if(process.platform==='linux')";

// ---- (b) native loaders: don't crash when the Linux binary is absent --------

// zwalker throws at LOAD via the final block when no linux .node exists.
const ZW_ANCHOR = [
  'if (!nativeBinding) {',
  '  if (loadError) {',
  '    throw loadError',
  '  }',
  '  throw new Error(`Failed to load native binding`)',
  '}',
].join('\n');
const ZW_PATCHED = [
  'if (!nativeBinding) {',
  '  if (process.platform === \'linux\') {',
  '    // Linux v1: no prebuilt zwalker binary (storage-GC out of scope). Stub so load does not crash.',
  '    nativeBinding = {',
  '      scanDirectory: () => [],',
  '      updateReferenceMessageId: () => {},',
  '      deleteHomelessFiles: () => [],',
  '      statUnmarkedFiles: () => [],',
  '      deleteEmptyFolders: () => [],',
  '    };',
  '  } else if (loadError) {',
  '    throw loadError',
  '  } else {',
  '    throw new Error(`Failed to load native binding`)',
  '  }',
  '}',
].join('\n');
const ZW_MARKER = 'no prebuilt zwalker binary';

// mp4thumb already installs a stub in its catch; force Linux straight into it
// (avoids require()-ing a Mach-O .node on Linux and the noisy console.error path).
const MP_ANCHOR = '    let thumbModule = null;\n    try {';
const MP_PATCHED = '    let thumbModule = null;\n    try {\n        if (process.platform === \'linux\') throw new Error("mp4thumb: no Linux prebuilt (video thumbnails out of v1 scope)");';
const MP_MARKER = 'mp4thumb: no Linux prebuilt';

// NB: v8-profiles is NOT guarded here — patch-v8-profiles builds a real native
// profiler for Linux and splices its require into the binding chain (no fallback
// stub, by request). If that .node ever fails to load, the module throws.

// Apply one anchor->replacement edit, idempotently and fail-loud.
function applyGuard(file, anchor, replacement, marker, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`patch-linux-guards: ${logger.formatPath(file)} not found (run extract + .unpacked overlay first)`);
  }
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes(marker)) {
    logger.dim(`${label}: already patched`);
    return;
  }
  if (!content.includes(anchor)) {
    throw new Error(`patch-linux-guards: anchor for ${label} not found in ${logger.formatPath(file)}. Bundle format changed — patch must be re-derived.`);
  }
  content = content.split(anchor).join(replacement);
  fs.writeFileSync(file, content, 'utf8');
  logger.success(`${label}: guarded`);
}

async function main() {
  applyGuard(MAIN, CAS_ANCHOR, CAS_PATCHED, CAS_MARKER, 'checkAppSigned (Linux skip)');
  applyGuard(ZWALKER, ZW_ANCHOR, ZW_PATCHED, ZW_MARKER, 'zwalker loader');
  applyGuard(MP4THUMB, MP_ANCHOR, MP_PATCHED, MP_MARKER, 'mp4thumb loader');
  logger.success('linux-guards: codesign short-circuited + zwalker/mp4thumb loaders guarded');
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main };
