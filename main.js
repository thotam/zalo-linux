const { app } = require('electron');
const path = require('path');
const fs = require('fs');

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
