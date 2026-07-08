const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');
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
const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const ICON_SRC = path.join(PC_DIST, 'apple-icon-57x57.png');
const ICON_UNREAD = path.join(PC_DIST, 'favicon-tray-unread.png');
const MAKE_ICON_PY = path.join(__dirname, 'data', 'make-unread-icon.py');

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
    // The app's real show/restore-window function (`Ae`), reached on Linux via the
    // tray "Mở Zalo" -> en() -> here (verified by logging: J()=24 != K=23, so en's
    // mac `J()===K` branch is skipped). After show(), a maximized frameless window
    // stays blank under XWayland — force one native reconfigure (unmaximize->maximize,
    // deferred; isMaximized() checked inside since it can read false right after show).
    name: 'show-from-tray reveal',
    marker: '"linux"===process.platform&&setTimeout(function(){try{!Ae.isDestroyed()&&Ae.isMaximized()&&(Ae.unmaximize(),Ae.maximize(),Ae.focus())',
    anchor: 'if(Ae){Ae.isMinimized()?Ae.restore():Ae.show(),Ae.focus();',
    replacement: 'if(Ae){Ae.isMinimized()?Ae.restore():Ae.show(),Ae.focus();' +
      '"linux"===process.platform&&setTimeout(function(){' +
      'try{!Ae.isDestroyed()&&Ae.isMaximized()&&(Ae.unmaximize(),Ae.maximize(),Ae.focus())}catch(_){}},60);',
  },
  {
    // Unread indicator on the tray ICON (Linux). The badge method sets the tray
    // image only in the win32 branch; Linux falls into the darwin||linux branch
    // (app.setBadgeCount, which does not touch the GNOME tray icon), and the
    // renderer never produces the composited count image on this build. So on
    // Linux, swap the tray icon between the base icon `l` and a red-dot "unread"
    // icon `_u` (see edits 5-6) based on whether there are unread messages (t>0).
    name: 'tray unread badge',
    marker: '"linux"===process.platform&&m&&m.setImage(t>0&&_u?_u:l)',
    anchor: '"darwin"===process.platform&&!o&&t&&e<t&&h.dock.bounce()',
    replacement: '"darwin"===process.platform&&!o&&t&&e<t&&h.dock.bounce(),' +
      '"linux"===process.platform&&m&&m.setImage(t>0&&_u?_u:l)',
  },
  {
    // Create the red-dot "unread" tray image in the tray module (j6F3, where
    // te()=pc-dist and Nt is built) and export it, so the badge method can use it.
    name: 'unread tray image export',
    marker: 'unreadTrayImage:p.createFromPath(c.join(te(),"favicon-tray-unread.png"))',
    anchor: 'getTray:function(){return xe},defaultTrayImage:Nt',
    replacement: 'getTray:function(){return xe},defaultTrayImage:Nt,' +
      'unreadTrayImage:p.createFromPath(c.join(te(),"favicon-tray-unread.png")).resize({width:44,height:44})',
  },
  {
    // Import the unread image (as `_u`) into the badge method alongside getTray/defaultTrayImage.
    name: 'unread tray image import',
    marker: '{getTray:d,defaultTrayImage:l,unreadTrayImage:_u}=n("j6F3")',
    anchor: '{getTray:d,defaultTrayImage:l}=n("j6F3")',
    replacement: '{getTray:d,defaultTrayImage:l,unreadTrayImage:_u}=n("j6F3")',
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

// Composite the red-dot "unread" tray icon from the app's current icon, at SETUP,
// so it follows the app icon on version bumps. Needs python3 + Pillow.
function generateUnreadIcon() {
  if (!fs.existsSync(ICON_SRC)) {
    throw new Error(`patch-tray: tray icon source ${logger.formatPath(ICON_SRC)} not found`);
  }
  try {
    execFileSync('python3', [MAKE_ICON_PY, ICON_SRC, ICON_UNREAD], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      'patch-tray: failed to generate the unread tray icon via python3/Pillow — ' +
      'install it (e.g. `pip3 install Pillow`). ' + (e.stderr ? e.stderr.toString() : e.message)
    );
  }
  if (!fs.existsSync(ICON_UNREAD)) throw new Error('patch-tray: unread icon was not created');
  logger.dim('unread tray icon -> ' + path.basename(ICON_UNREAD));
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-tray: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  generateUnreadIcon();
  const r = patchMainJs(MAIN_JS);
  logger.success(`linux tray: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
