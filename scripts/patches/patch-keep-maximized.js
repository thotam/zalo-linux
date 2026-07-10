const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Keep the window maximized across hide/close on Linux (so it opens maximized).
//
// Zalo persists its window state (a "size" config with a `maximize` flag) and its
// startup reveal maximizes when that flag is set. But on NON-macOS platforms its
// close/hide handler runs unmaximize() BEFORE hide():
//
//     Ae.isMaximized() && "darwin" !== process.platform && Ae.unmaximize(), Ae.hide()
//
// so by the time the state is recorded isMaximized() is already false — the
// persisted flag is never "maximized", and the app always reopens at a normal
// size. That unmaximize() was almost certainly a workaround for the old XWayland
// blank-on-reveal bug (a maximized frameless window hidden then shown went blank);
// on Electron 39 / native Wayland that bug is gone, so the workaround only harms.
//
// Drop the unmaximize() call so Zalo's own maximized-state memory works: hide()
// keeps the window maximized, the state records maximize=1, and the next launch
// (and tray reveal) restores maximized via Zalo's native path. No forcing, no
// timers — the app just remembers whether it was maximized.
// ---------------------------------------------------------------------------

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

const ANCHOR = 'Ae.isMaximized()&&"darwin"!==process.platform&&Ae.unmaximize(),Ae.hide()';
const PATCHED = 'Ae.hide()';

function patchMainJs(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes(ANCHOR)) {
    if (s.includes('Ae.unmaximize()')) {
      // The unmaximize()->hide() shape moved; re-derive rather than silently skip.
      throw new Error(
        'patch-keep-maximized: unmaximize-before-hide anchor not found but ' +
        'Ae.unmaximize() still present — the hide handler changed, re-derive the anchor.'
      );
    }
    return 'already';
  }
  const n = s.split(ANCHOR).length - 1;
  if (n !== 1) {
    throw new Error(`patch-keep-maximized: expected exactly 1 unmaximize-before-hide, found ${n} — re-derive.`);
  }
  s = s.replace(ANCHOR, PATCHED);
  fs.writeFileSync(file, s, 'utf8');
  return 'patched';
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-keep-maximized: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  const r = patchMainJs(MAIN_JS);
  logger.success(`keep maximized across hide: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
