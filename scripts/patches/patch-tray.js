const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Enable Zalo's system tray on Linux. The tray (icon + tooltip + context menu +
// unread badge + status switching + show/quit) is fully implemented in the ported
// macOS main bundle but wrapped in a macOS-only gate, so no Tray is created on
// Linux. See docs/superpowers/specs/2026-07-08-linux-tray-design.md.
//
//   1. un-gate : the tray IIFE body is `if(J()===q){…}` (q=MAC_CLIENT_TYPE);
//                also run it on Linux.
//   2. icon    : load the app's apple-icon-57x57.png and nativeImage.resize() it
//                to 44x44 at runtime (follows the app icon on version bumps; .ico
//                renders poorly on Linux trays).
//   3. reveal  : the show helper `en()` calls e.show() on Linux -> a maximized
//                frameless window stays blank under XWayland; force one native
//                reconfigure (unmaximize->maximize), same fix as patch-relaunch-reveal.
// ---------------------------------------------------------------------------

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

const EDITS = [
  {
    name: 'un-gate tray',
    marker: 'J()===q||"linux"===process.platform',
    anchor: 'G.requestQuitApp()};if(J()===q){const t=s.Menu;',
    replacement: 'G.requestQuitApp()};if(J()===q||"linux"===process.platform){const t=s.Menu;',
  },
  {
    name: 'tray icon',
    marker: 'apple-icon-57x57.png',
    anchor: 'Nt=p.createFromPath(c.join(te(),"favicon.ico"))',
    replacement: 'Nt=p.createFromPath(c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})',
  },
  {
    name: 'show-from-tray reveal',
    marker: 'e.isMaximized()&&setTimeout(function(){try{!e.isDestroyed()&&e.isMaximized()&&(e.unmaximize(),e.maximize())',
    anchor: 'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),void e.focus();',
    replacement: 'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),' +
      '"linux"===process.platform&&e.isMaximized()&&setTimeout(function(){' +
      'try{!e.isDestroyed()&&e.isMaximized()&&(e.unmaximize(),e.maximize())}catch(_){}},60),' +
      'void e.focus();',
  },
];

function patchMainJs(file) {
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const e of EDITS) {
    if (s.includes(e.marker)) continue; // idempotent
    const n = s.split(e.anchor).length - 1;
    if (n !== 1) {
      throw new Error(`patch-tray: ${e.name}: expected exactly 1 anchor, found ${n} — bundle format changed, re-derive.`);
    }
    s = s.replace(e.anchor, e.replacement);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, s, 'utf8');
  return changed ? 'patched' : 'already';
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-tray: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  const r = patchMainJs(MAIN_JS);
  logger.success(`linux tray: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
