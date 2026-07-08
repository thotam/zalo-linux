const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Relaunch reveal repaint (Linux / XWayland).
//
// Zalo already has its OWN single-instance mechanism: a second launch runs the
// tiny `second-instance.js` entry, which connects to the primary's IPC socket
// and quits; the primary then app.emit("second-instance", ...) to reveal its
// window. (Verified: relaunching fires the `second-instance` handler with NO new
// main process — so Electron's app.requestSingleInstanceLock() is NOT needed and
// must not be added; it competes with the app's socket mechanism.)
//
// The only Linux bug is the reveal itself: Electron 22 runs as an X11 client
// under XWayland. A maximized, frameless window hidden via hide() is NOT
// re-composited by GNOME/mutter after show() — the surface stays blank (window
// "visible" but no content). Neither a renderer repaint nor size/position nudges
// help while the window is WM-maximized (those are ignored). The only thing that
// forces a fresh frame is a native reconfigure, so in the second-instance reveal
// branch, after show() we toggle unmaximize()->maximize() once (deferred a tick
// so show() maps first). Costs one brief flash on reveal; it is the floor of
// what Electron 22 + XWayland allows here. Native Wayland (--ozone-platform=
// wayland) was rejected: it crashes on this reveal path on E22.
// ---------------------------------------------------------------------------

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

// The non-win32 reveal branch of the second-instance handler; `r` is the main
// window local. `}),100)}` is the tail of the win32 hidden branch just before it.
const REVEAL_ANCHOR = '}),100)}else r.show();';
const REVEAL_MARKER = 'r.isMaximized()){r.unmaximize();r.maximize()';
const REVEAL_NEW =
  '}),100)}else{r.show();r.focus();"linux"===process.platform&&setTimeout((function(){' +
  'try{if(!r.isDestroyed()&&r.isMaximized()){r.unmaximize();r.maximize();r.focus()}}catch(_){}' +
  '}),60)}';

function patchMainJs(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(REVEAL_MARKER)) return 'already';
  if (!s.includes(REVEAL_ANCHOR)) {
    throw new Error(
      'patch-relaunch-reveal: second-instance reveal branch not found in main.js — ' +
      'bundle format changed, re-derive REVEAL_ANCHOR.'
    );
  }
  s = s.replace(REVEAL_ANCHOR, REVEAL_NEW);
  fs.writeFileSync(file, s, 'utf8');
  return 'patched';
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-relaunch-reveal: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  const r = patchMainJs(MAIN_JS);
  logger.success(`relaunch reveal repaint: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
