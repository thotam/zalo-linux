const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Windows-style titlebar window controls on Linux.
//
// The macOS bundle we port renders the title bar with a hardcoded "DARWIN"
// platform class and NO window-control buttons (macOS draws native traffic
// lights via titleBarStyle:"hidden"). On Windows the SAME React component
// (identical minified source, only the platform-conditional branch differs)
// renders a `titlebar__btns` block: lock + minimize + maximize/restore + close,
// wired to the component's own methods (this._showAppLock / minimize / maximize
// / quit). Every CSS class, icon glyph (fa-Lock_24_Line, fa-Minus_24_Line, ...)
// and handler ALREADY exists in the mac bundle — only the JSX that renders them
// is compiled out.
//
// This patch splices the exact Windows control block (see
// data/titlebar-controls-win32.txt, extracted verbatim from the Windows build)
// into the mac bundle's empty `pendingUpdate ? <update> : null` slot, and flips
// the titlebar platform class DARWIN -> WIN32 so the Windows layout CSS applies.
//
// The control template references three minified locals that differ per bundle
// (React namespace, the className theme-suffix var, and the style var). We
// DETECT them per file and substitute, so the splice is correct in every chunk
// (compact-app-pc uses r/s/t; the login-main-startup lazy chunk uses i/o/t).
//
// Photo/media viewer is a separate Cocos window and is intentionally NOT handled
// here (its page context exposes no reachable window-control API).
// ---------------------------------------------------------------------------

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const TEMPLATE_FILE = path.join(__dirname, 'data', 'titlebar-controls-win32.txt');

// The `null` slot the mac build renders instead of the Windows controls. Unique
// (the pendingUpdate ternary's else branch, right after the update button).
const NULL_ANCHOR = 'STR_NEW_VER"})))):null))';
// Marker proving a file was already patched (idempotency).
const DONE_MARKER = 'fa-Lock_24_Line btn titlebar__menu__btn';
// The titlebar platform class (DARWIN on the mac build).
const DARWIN_CLASS = '?" locked ":"")+"DARWIN"';
const WIN32_CLASS = '?" locked ":"")+"WIN32"';

function listBundles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    const st = fs.statSync(fp);
    if (st.isDirectory()) {
      if (entry === 'lazy') out.push(...listBundles(fp));
      continue;
    }
    if (entry.endsWith('.js')) out.push(fp);
  }
  return out;
}

// Adapt the reference template (r/s/t) to a bundle's detected locals.
function buildControls(template, reactVar, styleVar, suffixVar) {
  return template
    .split('r.a.createElement').join(reactVar + '.a.createElement')
    .split(',style:t}').join(',style:' + styleVar + '}')
    .split('${s}').join('${' + suffixVar + '}');
}

// Patch one bundle if it hosts the title bar component. Returns 'patched',
// 'already', or 'skip' (no title bar here).
function patchFile(file, template) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('id:"titleBar"')) return 'skip';
  if (s.includes(DONE_MARKER)) return 'already';
  if (!s.includes(NULL_ANCHOR)) {
    throw new Error(
      `patch-titlebar-controls: ${path.basename(file)} has the title bar but not the ` +
      `'${NULL_ANCHOR}' anchor — bundle format changed, re-derive the splice.`
    );
  }
  const reactVar = (s.match(/([A-Za-z_$])\.a\.createElement\("div",\{id:"titleBar"/) || [])[1];
  const styleVar = (s.match(/titlebar__btns clickable",style:([A-Za-z_$])\}/) || [])[1];
  const suffixVar = (s.match(/\.c,\{className:([A-Za-z_$])\}\)/) || [])[1];
  if (!reactVar || !styleVar || !suffixVar) {
    throw new Error(
      `patch-titlebar-controls: ${path.basename(file)} — could not detect locals ` +
      `(react=${reactVar}, style=${styleVar}, suffix=${suffixVar}). Update detection regexes.`
    );
  }
  const controls = buildControls(template, reactVar, styleVar, suffixVar);
  // 1. render the Windows controls instead of null
  s = s.replace(NULL_ANCHOR, 'STR_NEW_VER"})))):' + controls);
  // 2. platform class DARWIN -> WIN32 (so the win32 titlebar CSS applies)
  if (s.includes(DARWIN_CLASS)) s = s.replace(DARWIN_CLASS, WIN32_CLASS);
  // 3. drop the mac-only "macos" title-name class (left-pads for traffic lights)
  s = s.split('`title-name + macos ${').join('`title-name + ${');
  fs.writeFileSync(file, s, 'utf8');
  return 'patched';
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-titlebar-controls: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }
  if (!fs.existsSync(TEMPLATE_FILE)) {
    throw new Error(`patch-titlebar-controls: control template missing at ${TEMPLATE_FILE}`);
  }
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8').trim();

  let patched = 0, already = 0, hosts = 0;
  for (const file of listBundles(PC_DIST)) {
    const r = patchFile(file, template);
    if (r === 'skip') continue;
    hosts++;
    if (r === 'patched') { patched++; logger.dim(`titlebar controls -> ${path.basename(file)}`); }
    else already++;
  }

  if (hosts === 0) {
    throw new Error('patch-titlebar-controls: no bundle contains the title bar component — pc-dist layout changed.');
  }
  if (patched === 0 && already === 0) {
    throw new Error('patch-titlebar-controls: found the title bar but patched nothing — anchor drift.');
  }
  logger.success(`titlebar controls: ${patched} patched, ${already} already (of ${hosts} title-bar bundles)`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, buildControls, patchFile };
