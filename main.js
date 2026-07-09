const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// --- Electron 39 compatibility shims (bundle was built for Electron 22) -------
// Upgraded E22 -> E39 to fix the intermittent drag-drop bug (XWayland XDND on
// Chromium 108 dropped file data on fast drags; E39 runs native Wayland).
// E39 (Chromium 142) is the CEILING for this bundle: it still serves storage to
// the file:// origin the app loads from, but E40+ (Chromium 144+) no longer do —
// their IndexedDB/quota on file:// hangs, so login never completes. Verified by
// bisection: E39 works; E40, E41, E42, E43 all hang at "Đang đăng nhập".

// webContents.incrementCapturerCount()/decrementCapturerCount() were removed in
// Electron 25. Zalo calls incrementCapturerCount() ONCE on the main window and
// never decrements it — the old idiom for "pin this renderer active so Chromium
// never background-throttles it while the window is hidden/minimized to tray"
// (so a backgrounded chat window keeps rendering/timers alive). The faithful
// E25+ equivalent is setBackgroundThrottling(false), so map the shim to that
// instead of a no-op; decrement re-enables throttling (Zalo never calls it).
app.on('web-contents-created', (_e, contents) => {
  try {
    if (typeof contents.incrementCapturerCount !== 'function') {
      contents.incrementCapturerCount = function () {
        try { contents.setBackgroundThrottling(false); } catch (_) {}
      };
    }
    if (typeof contents.decrementCapturerCount !== 'function') {
      contents.decrementCapturerCount = function () {
        try { contents.setBackgroundThrottling(true); } catch (_) {}
      };
    }
  } catch (_) {}
});
// -----------------------------------------------------------------------------

// Resolve the extracted Zalo bundle. During dev, app/ sits next to this shell
// entry (repo root). Once packaged, electron-builder copies it via extraFiles to
// sit next to the Electron executable, so fall back to <execPath>/../app.
const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');

// Hide the GTK menu bar on every window. Zalo draws its own win32 titlebar in the
// renderer now (see patch-renderer-win32: client-type is spoofed to WIN32/24), so
// no native window chrome is wanted. Do NOT flip frame:false -> true and do NOT
// inject a custom titlebar — that path (old main.js) is dropped by design.
app.on('browser-window-created', (_e, win) => {
  try { win.setMenuBarVisibility(false); } catch (_) {}
});

// Zalo's bootstrap.js -> main-dist/main.js registers app.on('ready') at TOP LEVEL,
// so it MUST be required synchronously BEFORE 'ready' fires. Requiring it inside
// app.whenReady() would run after 'ready' and no window would ever open. This
// mirrors the bundle's original entry point (its package.json main == bootstrap.js).
const bootstrapPath = path.join(appDir, 'bootstrap.js');
if (!fs.existsSync(bootstrapPath)) {
  console.error('Zalo bootstrap.js not found at:', bootstrapPath);
  process.exit(1);
}
process.chdir(appDir);
try {
  require(bootstrapPath);
} catch (e) {
  console.error('Error loading Zalo:', e);
  process.exit(1);
}
