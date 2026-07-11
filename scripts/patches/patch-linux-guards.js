const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP = path.join(__dirname, '..', '..', 'app');
const MAIN = path.join(APP, 'main-dist', 'main.js');

// ---------------------------------------------------------------------------
// main.js: short-circuit checkAppSigned() on Linux.
// Original (bundle 26.6.11) spawns macOS `codesign --verify <app>`; on Linux that
// fails. We return isAppSigned=false immediately (no spawn). Effect per spec §7:
// isAppSigned=false => secure key stored via safeStorage/libsecret if present,
// otherwise raw (accepted for v1).
//
// NB: the zwalker/mp4thumb native loaders used to be guarded here too (stubbed for
// "out of v1 scope"). Both are now real Linux addons that own their own load — see
// patch-zwalker.js and patch-mp4thumb.js — so this patch is codesign-only.
// ---------------------------------------------------------------------------
const CAS_ANCHOR = 'async checkAppSigned(){return null!=this.isAppSigned?';
const CAS_PATCHED = "async checkAppSigned(){if(process.platform==='linux')return this.isAppSigned=!1,!1;return null!=this.isAppSigned?";
const CAS_MARKER = "async checkAppSigned(){if(process.platform==='linux')";

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
  logger.success('linux-guards: codesign short-circuited');
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main };
