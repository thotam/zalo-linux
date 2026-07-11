const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Force Zalo's client-side video-thumbnail feature ON in the renderer bundles.
//
// mp4thumb (our RE'd native video->JPEG addon) is only reached through
// `genVideoThumbFromFile()`, which is gated:
//     if (!Object(J.l)()) throw { error_code: "NOT_SUPPORT", "Version not support" };
// where `J.l` reads the remote-config feature flag
//     zalo_cloud.z_cloud.feats.gen_video_thumb.enable
// whose bundled DEFAULT is `{enable:!1}` (false) — Zalo's gradual server rollout.
// So on a fresh install the app NEVER calls mp4thumb, exactly like zjxl/zimage were
// dormant before patch-native-image-flags. The native addon loads + runs fine
// (verified via the aggregator logging harness); only the flag keeps it dormant.
//
// Two forces (belt + suspenders), because the gate reads REMOTE config first
// (`a.default...enable`) and only falls back to the bundled default:
//   1. flip the default literal `{enable:!1}` -> `{enable:!0}`, and
//   2. hard-neutralize the gate call itself: `Object(X.l)()` -> `!0` at every
//      `if(!Object(X.l)())throw{error_code:"NOT_SUPPORT"...}` site, so the throw
//      never fires even if a cached/remote value is false (same spirit as
//      patch-native-image-flags forcing jxlNativeSupported()->(!0)).
// This unblocks the video-thumb queue (runByVideoPath -> runByFile ->
// mp4thumb.generateThumbnail) on Linux. Idempotent; fail-loud if neither anchor
// is present (config shape changed).
// ---------------------------------------------------------------------------

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const ANCHOR = 'gen_video_thumb:{enable:!1';
const FORCED = 'gen_video_thumb:{enable:!0';
// `Object(<var>.l)()` immediately followed by `)throw{error_code:"NOT_SUPPORT"`.
const GATE_RE = /Object\([A-Za-z_$][\w$]*\.l\)\(\)(?=\)throw\{error_code:"NOT_SUPPORT")/g;

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
  const before = s;
  // 1. flip default literal.
  const flagHits = s.split(ANCHOR).length - 1;
  if (flagHits) s = s.split(ANCHOR).join(FORCED);
  // 2. neutralize the gate call so the NOT_SUPPORT throw never fires.
  let gateHits = 0;
  s = s.replace(GATE_RE, () => { gateHits++; return '!0'; });
  const n = flagHits + gateHits;
  if (s !== before) fs.writeFileSync(file, s, 'utf8');
  // "already" = no work this run but the forced default is present (prior apply).
  const already = n === 0 && s.includes(FORCED);
  return { n, already };
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-video-thumb-flag: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }
  let total = 0, files = 0, already = 0;
  for (const file of listBundles(PC_DIST)) {
    const r = patchFile(file);
    if (r.n > 0) { files++; total += r.n; logger.dim(`gen_video_thumb -> ON in ${path.basename(file)} (${r.n})`); }
    else if (r.already) already++;
  }
  if (total === 0 && already === 0) {
    throw new Error(
      'patch-video-thumb-flag: `gen_video_thumb:{enable:!1}` not found in any pc-dist bundle — ' +
      'the video-thumb feature-flag config changed, re-derive the anchor.'
    );
  }
  logger.success(`video-thumb flag forced ON: ${total} sites across ${files} bundles (${already} already)`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchFile };
