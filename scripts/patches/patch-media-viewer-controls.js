const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Windows-style window controls on the media / photo viewer WINDOW.
//
// Opening an image spawns a separate frameless viewer window. Its title bar is
// rendered by a distinct React component (`g.a`, className "image-show__title
// MediaViewer") — NOT the main app title bar. On the macOS bundle that component
// renders only the title (class "titlebar__title mac"), no window buttons; the
// identical Windows build renders a `titlebar__btns` block (minimize /
// maximize-restore / close) wired to the component's own this.minimize /
// this.maximize / this.quit, which call `$zwindow.<action>(this.props.windowType)`
// — i.e. they target the viewer window by its windowType.
//
// Two things are needed on Linux:
//   1. Splice the Windows control block (data/media-viewer-controls-win32.txt,
//      verbatim from the Windows build) into the mac `image-show__title` branch,
//      and drop the mac-only "mac" title class.
//   2. The viewer window ships with NO preload, so `$zwindow` is undefined in it
//      and the handlers no-op. Give it the same preload the notification window
//      uses (preload-noti.js exposes $zwindow) via the media-viewer window
//      options in main.js.
// ---------------------------------------------------------------------------

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');
const TEMPLATE_FILE = path.join(__dirname, 'data', 'media-viewer-controls-win32.txt');

// The mac `image-show__title` branch renders `...},null,e,<drag div>,null))` — the
// leading null (Windows: a resize div) and the trailing null (Windows: the btns
// block). We match the whole tail and swap in the Windows layout.
const DRAG = '.a.createElement("div",{className:"draggable w100 title-drag",style:{position:"absolute",left:0},onDoubleClick:this.maximize.bind(this)})';
const DONE_MARKER = 'titlebar__menu__btnPreviewPhoto';           // proves the splice ran
// How many pc-dist bundles host the media-viewer title bar in the current Zalo
// build (26.6.11). Asserted so a bundle split/merge that changes this count fails
// loud (even a legit reduction needs review — bump after verifying the new layout).
const EXPECTED_HOSTS = 3;
const MV_PRELOAD_MARKER = '__MVPRELOAD__';                       // proves main.js was patched
const MV_OPTS_ANCHOR = 'return zconsole.debug("main:getOptionsInitMediaViewerBrowserWindow",e),{action:"allow",overrideBrowserWindowOptions:e}';
const MV_PRELOAD_INJECT =
  '/*__MVPRELOAD__*/e.webPreferences=Object.assign({},e.webPreferences,' +
  '{preload:require("path").join(__dirname,"preload-noti.js"),contextIsolation:!0,sandbox:!1,nodeIntegration:!1});';

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

// Splice the Windows controls into one bundle's image-show title bar. Returns
// 'patched', 'already', or 'skip' (no media-viewer title bar here).
function patchBundle(file, template) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(DONE_MARKER)) return 'already';   // idempotent: check before the (now-consumed) anchor
  const m = s.match(/className\|\|" titlebar rel flx"\},null,e,([A-Za-z_$])\.a\.createElement\("div",\{className:"draggable w100 title-drag"/);
  if (!m) return 'skip';
  const R = m[1]; // this bundle's React namespace (r or i)
  const drag = R + DRAG;
  const macTail = 'className||" titlebar rel flx"},null,e,' + drag + ',null))';
  if (!s.includes(macTail)) {
    throw new Error(`patch-media-viewer-controls: ${path.basename(file)} has the image-show title bar but not the expected null-slot tail — bundle format changed.`);
  }
  const btns = template.split('r.a.createElement').join(R + '.a.createElement');
  const winTail = 'className||" titlebar rel flx"},' + R + '.a.createElement("div",{className:"titlebar__resize"}),e,' + drag + ',' + btns + '))';
  s = s.replace(macTail, winTail).split('"titlebar__title mac"').join('"titlebar__title "');
  fs.writeFileSync(file, s, 'utf8');
  return 'patched';
}

// Give the media-viewer window a preload that exposes $zwindow.
function patchMainJs() {
  if (!fs.existsSync(MAIN_JS)) throw new Error(`patch-media-viewer-controls: ${logger.formatPath(MAIN_JS)} not found`);
  let s = fs.readFileSync(MAIN_JS, 'utf8');
  if (s.includes(MV_PRELOAD_MARKER)) return 'already';
  if (!s.includes(MV_OPTS_ANCHOR)) {
    throw new Error('patch-media-viewer-controls: media-viewer window-options anchor not found in main.js — re-derive the preload injection.');
  }
  s = s.replace(MV_OPTS_ANCHOR, MV_PRELOAD_INJECT + MV_OPTS_ANCHOR);
  fs.writeFileSync(MAIN_JS, s, 'utf8');
  return 'patched';
}

async function main() {
  if (!fs.existsSync(PC_DIST)) throw new Error(`patch-media-viewer-controls: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  if (!fs.existsSync(TEMPLATE_FILE)) throw new Error(`patch-media-viewer-controls: control template missing at ${TEMPLATE_FILE}`);
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8').trim();

  let patched = 0, already = 0, hosts = 0;
  for (const file of listBundles(PC_DIST)) {
    const r = patchBundle(file, template);
    if (r === 'skip') continue;
    hosts++;
    if (r === 'patched') { patched++; logger.dim(`media-viewer controls -> ${path.basename(file)}`); }
    else already++;
  }
  if (hosts !== EXPECTED_HOSTS) {
    throw new Error(
      `patch-media-viewer-controls: expected ${EXPECTED_HOSTS} media-viewer title-bar bundles, found ${hosts} — ` +
      `pc-dist layout changed (bundle split/merge). Re-verify and update EXPECTED_HOSTS.`
    );
  }

  const mainR = patchMainJs();
  logger.dim(`media-viewer window preload: ${mainR}`);
  logger.success(`media-viewer controls: ${patched} patched, ${already} already (of ${hosts}); preload ${mainR}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchBundle, patchMainJs };
