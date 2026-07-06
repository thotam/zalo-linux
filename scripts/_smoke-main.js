// Smoke-only Electron entry. Registers boot assertions, then loads the REAL shell
// (../main.js). Kept out of main.js so the shipped entry stays clean.
// Run indirectly via scripts/_smoke-boot.sh (needs xvfb + a prepared app/).
const { app } = require('electron');
const path = require('path');

const SETTLE_MS = parseInt(process.env.SMOKE_SETTLE_MS || '10000', 10); // renderer boot grace
const NO_WINDOW_MS = parseInt(process.env.SMOKE_WINDOW_MS || '45000', 10);

let done = false;
function finish(code, msg) {
  if (done) return;
  done = true;
  if (code === 0) console.log('SMOKE_OK:', msg);
  else console.error('SMOKE_FAIL:', msg);
  try { app.exit(code); } catch (_) { process.exit(code); }
}

// If no window ever appears, the boot path is broken -> fail.
const noWindowTimer = setTimeout(
  () => finish(1, `no BrowserWindow within ${NO_WINDOW_MS}ms`), NO_WINDOW_MS);

process.on('uncaughtException', (e) =>
  finish(1, 'uncaughtException: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) =>
  finish(1, 'unhandledRejection: ' + ((e && e.stack) || e)));

app.on('browser-window-created', (_e, win) => {
  clearTimeout(noWindowTimer);
  const wc = win.webContents;
  wc.on('render-process-gone', (_ev, d) =>
    finish(1, 'render-process-gone: ' + JSON.stringify(d)));
  // Let the renderer boot far enough to pull native modules (sqlite3 opens the
  // encrypted DB; db-cross-v4 loads in the shared worker), then declare success.
  setTimeout(() => finish(0, 'window created and stayed alive'), SETTLE_MS);
});

// Boot the real shell (registers Zalo's app.on('ready') synchronously). main.js
// resolves app/ from its own __dirname (repo root), regardless of this wrapper.
require(path.join(__dirname, '..', 'main.js'));
