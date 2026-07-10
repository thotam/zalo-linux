const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Fix pasting images (Ctrl+V) into the chat on Linux.
//
// Zalo's paste handler (the `paste_data_handler_version===2` path, function `z`)
// splits clipboard items into non-image files -> `uploadFileForMac(d)` and image
// files -> `W(A)`. Non-image files upload fine, but `W` (the image path) is
// macOS-centric: it ALWAYS round-trips through `$zscreencap.getClipboard()` — an
// IPC request to Zalo's native "screencap" pasteboard helper that only exists on
// macOS. On Linux that request never resolves, so its `.then()` never runs, the
// image is never handed to `uploadPhoto`, and the `G` ("getting clipboard") guard
// stays stuck true -> every subsequent image paste silently does nothing.
// (Runtime-verified on E39/Wayland: `getAsFile()` DOES yield the image bytes, and
// the drop path already uploads image blobs fine; only paste took the mac detour.)
//
// Fix: at the very start of `W`, before the screencap detour, read the clipboard
// image with Electron's cross-platform `clipboard.readImage()` (exposed by the
// preload as `$zelectronNative.getClipboardImage()` -> {isEmpty,toPNG,toJPEG};
// works on both Wayland and XWayland) and hand it straight to `e.uploadPhoto`. If
// the native read is empty, fall back to the image File blobs `t` we already have
// from `getAsFile()`. Either way we `return` before the dead macOS screencap code.
// `dt.c(e.uploadPhoto)` / `e.currentUserId` are the same refs `W`'s own fallback
// already uses, so nothing new is assumed about scope.
//
// Covers all three broken cases (screenshot bitmap, image copied from a viewer,
// image file copied in a file manager) — all arrive as image items in `W`.
// ---------------------------------------------------------------------------

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const MARKER = '/*__znative_clip_paste__*/';

const ANCHOR = 'W=(t,n="")=>{G||(G=!0,$zscreencap.getClipboard(e.currentUserId)';
const INJECT =
  'W=(t,n="")=>{' + MARKER +
  'try{var _zn=("undefined"!=typeof $zelectronNative&&$zelectronNative)||("undefined"!=typeof window&&window.$zelectronNative);' +
  'var _zimg=_zn&&_zn.getClipboardImage&&_zn.getClipboardImage();' +
  'if(_zimg&&!_zimg.isEmpty()){var _zmime=(t&&t[0]&&t[0].type)||"image/png";var _zpng=_zmime.indexOf("png")>=0;' +
  'var _zb=_zpng?_zimg.toPNG():_zimg.toJPEG(100);' +
  'if(_zb&&_zb.length&&dt.c(e.uploadPhoto)){var _zf=new File([new Uint8Array(_zb)],"clipboard."+(_zpng?"png":"jpg"),{type:_zpng?"image/png":"image/jpeg"});e.uploadPhoto([_zf],e.currentUserId);return}}}catch(_zerr){}' +
  'try{if(dt.c(e.uploadPhoto)&&Array.isArray(t)&&t.length>0){e.uploadPhoto(t,e.currentUserId);return}}catch(_zerr2){}' +
  'G||(G=!0,$zscreencap.getClipboard(e.currentUserId)';

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

function patchFile(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(MARKER)) return { patched: false, already: true, hasAnchor: true };
  const c = s.split(ANCHOR).length - 1;
  if (c === 0) return { patched: false, already: false, hasAnchor: false };
  if (c !== 1) {
    throw new Error(
      `patch-clipboard-image-paste: ${path.basename(file)}: expected exactly 1 paste-image anchor, ` +
      `found ${c} — bundle format changed, re-derive.`
    );
  }
  s = s.replace(ANCHOR, INJECT);
  fs.writeFileSync(file, s, 'utf8');
  return { patched: true, already: false, hasAnchor: true };
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-clipboard-image-paste: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }
  let patched = 0, already = 0, seen = 0;
  for (const file of listBundles(PC_DIST)) {
    const r = patchFile(file);
    if (r.hasAnchor) seen++;
    if (r.already) { already++; continue; }
    if (r.patched) { patched++; logger.dim('clipboard image paste -> ' + path.basename(file)); }
  }
  if (seen === 0) {
    throw new Error(
      'patch-clipboard-image-paste: paste-image handler (W/$zscreencap.getClipboard) not found in any ' +
      'pc-dist bundle — the paste flow changed, re-derive the anchor.'
    );
  }
  logger.success(`clipboard image paste: ${patched} patched, ${already} already (${seen} bundles have the handler)`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchFile };
