const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');

// Exact literals from bundle 26.6.11 (verified by grep). Load-bearing for the win32
// titlebar the renderer draws on Zalo's frameless (frame:false) Linux windows:
//   - platform prop: the login title bar renders min/close only on `"WIN32"===platform`
//     (q.a.createElement("div",{className:"login-title-bar"},"WIN32"===e&&...fa-Minus/fa-Close))
//   - getClientType: renderer client-type, 23=DARWIN -> 24=WIN32
// The many COSMETIC "DARWIN" occurrences (CSS classNames via "DARWIN".toLowerCase(),
// OS:{DARWIN:"DARWIN"} const map, platform:["WEB","DARWIN","WIN32"] arrays, os/os_name
// logging, parseKeyFromUrl("DARWIN",...)) are intentionally NOT matched — we only replace
// the two prefixed literals below, never a bare "DARWIN".
const REPLACEMENTS = [
  { name: 'platform prop', from: 'platform:"DARWIN"', to: 'platform:"WIN32"', expected: 2 },
  { name: 'getClientType', from: 'getClientType(){return 23}', to: 'getClientType(){return 24}', expected: 6 },
];

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-renderer-win32: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }

  const files = collectJsFiles(PC_DIST);
  if (files.length === 0) {
    throw new Error(`patch-renderer-win32: no .js files under ${logger.formatPath(PC_DIST)}`);
  }

  for (const rep of REPLACEMENTS) {
    let replaced = 0;
    let alreadyPatched = 0;

    for (const file of files) {
      let content = fs.readFileSync(file, 'utf8');
      const hitsOld = countOccurrences(content, rep.from);
      // Count existing target markers BEFORE we touch this file (idempotency signal).
      alreadyPatched += countOccurrences(content, rep.to);
      if (hitsOld > 0) {
        content = content.split(rep.from).join(rep.to);
        fs.writeFileSync(file, content, 'utf8');
        replaced += hitsOld;
        logger.dim(`${rep.name}: ${hitsOld}x in ${logger.formatPath(file)}`);
      }
    }

    if (replaced === 0 && alreadyPatched === 0) {
      // Fail loud: anchor vanished => Zalo changed the bundle. Do not ship a titlebar-less build.
      throw new Error(
        `patch-renderer-win32: anchor for "${rep.name}" (${rep.from}) not found in any pc-dist .js, ` +
        `and no already-patched marker (${rep.to}) present. Bundle format changed — patch must be re-derived.`
      );
    }

    // Total target markers after this pass (freshly replaced + already patched).
    // Fail loud if it drifts from the known count for this Zalo build, so a
    // bundle change that adds/removes occurrences is caught in CI, not shipped.
    const total = replaced + alreadyPatched;
    if (total !== rep.expected) {
      throw new Error(
        `patch-renderer-win32: "${rep.name}" — expected ${rep.expected} occurrences for 26.6.11 ` +
        `but found ${total} (replaced ${replaced}, already ${alreadyPatched}). ` +
        `Bundle format changed — re-verify and update the expected count.`
      );
    }
    if (replaced === 0) logger.dim(`${rep.name}: already patched (${alreadyPatched}x ${rep.to} present)`);
    else logger.success(`${rep.name}: replaced ${replaced}x -> ${rep.to}`);
  }

  logger.success('renderer-win32: platform+client-type spoofed to WIN32 (Zalo draws min/max/close on frameless Linux windows)');
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main };
