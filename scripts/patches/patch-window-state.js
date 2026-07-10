const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Fix Zalo's broken main-window size/maximized persistence on Linux.
//
// Two independent bugs, both verified at runtime:
//
// (1) SAVE is a no-op. Zalo saves geometry+maximized via fe("size",Mt,e) from its
//     resize/maximize/blur/moved handlers, but fe() writes nothing to its store
//     (he.get("size") stayed `undefined` across every session; Mt.maximize was
//     stale). The store `he` itself works and persists to disk. Fix: alongside
//     each fe() call, write the correct LIVE state to `he` ourselves, debounced
//     250ms so a resize drag doesn't thrash the store. getNormalBounds() gives the
//     un-maximized geometry; isMaximized() the flag (both reliable here).
//
// (2) RESTORE only handles the maximized case. On the "show" event Zalo restores
//     from he.get("size") but only calls setSize()+maximize() when maximize===1;
//     for a non-maximized window it does nothing, so the saved width/height are
//     never applied and the window opens at its default (minimum) size. Fix:
//     restore the SIZE for BOTH cases (and still maximize when the flag is set).
//     Only on the FIRST show (cold start) — a per-window flag skips it on later
//     shows so a tray reveal doesn't re-apply geometry and shove the window around;
//     the window already keeps its state across hide/show. Position is only
//     re-applied when it's non-zero: Wayland doesn't
//     expose or accept absolute window position (getBounds().x/y read 0 and the
//     compositor places the window itself), so posX/posY are 0 there and a
//     setPosition(0,0) would just re-center the window on every tray reveal; the
//     guard skips it on Wayland while still restoring position under X11/XWayland.
//
// Together these give true "remember" behaviour through Zalo's own store and
// startup path: maximize -> reopens maximized; resize/move -> reopens at that
// size and position. No shell timers, no forcing.
// ---------------------------------------------------------------------------

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

// --- Edit 1: make the save actually persist -------------------------------
const SAVE_ANCHOR = 'fe("size",Mt,e)';
const SAVE_MARKER = 'Ae.__zSizeT';
const SAVE_REPLACEMENT =
  '(clearTimeout(Ae.__zSizeT),Ae.__zSizeT=setTimeout((function(){try{if(!Ae.isDestroyed()){' +
  'var _b=Ae.getNormalBounds();he.set("size",{width:_b.width,height:_b.height,posX:_b.x,posY:_b.y,' +
  'maximize:Ae.isMaximized()?1:0})}}catch(_){}}),250),fe("size",Mt,e))';

// --- Edit 2: restore geometry for the non-maximized case too --------------
const RESTORE_ANCHOR = 'Ae.isMaximized()||1!=e.maximize||(Ae.setSize(e.width,e.height),Ae.maximize())';
const RESTORE_REPLACEMENT =
  'Ae.__zRestored||(Ae.__zRestored=1,Ae.isMaximized()||(Ae.setSize(e.width,e.height),' +
  '(e.posX||e.posY)&&Ae.setPosition(e.posX,e.posY),1==e.maximize&&Ae.maximize()))';

function patchMainJs(file) {
  let s = fs.readFileSync(file, 'utf8');
  let did = [];

  // Edit 1
  if (s.includes(SAVE_MARKER)) {
    did.push('save:already');
  } else {
    const n = s.split(SAVE_ANCHOR).length - 1;
    if (n < 1) {
      throw new Error('patch-window-state: no fe("size",Mt,e) save calls found — save shape changed, re-derive.');
    }
    s = s.split(SAVE_ANCHOR).join(SAVE_REPLACEMENT);
    did.push('save:' + n + ' sites');
  }

  // Edit 2
  if (s.includes(RESTORE_REPLACEMENT)) {
    did.push('restore:already');
  } else {
    const n = s.split(RESTORE_ANCHOR).length - 1;
    if (n !== 1) {
      throw new Error(`patch-window-state: expected exactly 1 on("show") restore condition, found ${n} — re-derive.`);
    }
    s = s.split(RESTORE_ANCHOR).join(RESTORE_REPLACEMENT);
    did.push('restore:1 site');
  }

  fs.writeFileSync(file, s, 'utf8');
  return did.join(', ');
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-window-state: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  const r = patchMainJs(MAIN_JS);
  logger.success(`window-state persistence fix: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
