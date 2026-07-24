const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// Replace the main.js call-send-to-native handler (which forwards to the absent child-process native
// engine) with a route to OUR main-process JS engine, using `w` (webContents) for the emit path.
// Bypassing W()/S() also neuters the dead child spawn. Copies engine + modules + Electron addons.
const REPO = path.join(__dirname, '..', '..');
const MAIN_JS = path.join(REPO, 'app', 'main-dist', 'main.js');
const ENGINE_DIR = path.join(REPO, 'app', 'native', 'zcall-engine');
const UI_SRC = path.join(REPO, 'tools', 'zcall-ui');
const UI_DIR = path.join(REPO, 'app', 'native', 'zcall-ui');
const FONTS_DIR = path.join(REPO, 'app', 'pc-dist', 'fonts');
const BUILDER = path.join(REPO, 'nativelibs', 'builder.js');
const MARKER = '__zeng.handleSendToNative';
const REQCAP = 'globalThis.__zengRequire=require;';
const ANCHOR = '((e,t)=>{t._optional?delete t._optional:W(),S(t)})';
const REPLACEMENT =
  "((e,t)=>{try{if(t&&t._optional)delete t._optional;var _R=globalThis.__zengRequire;" +
  "if(!globalThis.__zeng){var _P=_R('path');var _b=_P.join(__dirname,'..','native');" +
  "var _mkUi=function(){try{var _el=_R('electron');var _u=_P.join(_b,'zcall-ui');" +
  "return _R(_P.join(_u,'call-ui.js')).createCallUI({BrowserWindow:_el.BrowserWindow,ipcMain:_el.ipcMain," +
  "htmlPath:_P.join(_u,'call.html'),preloadPath:_P.join(_u,'preload.js'),devicesHtmlPath:_P.join(_u,'devices.html')});}catch(_ue){try{console.error('[ZENGINE ui]',_ue&&_ue.stack||_ue)}catch(__){}return null;}};" +
  "globalThis.__zeng=_R(_P.join(_b,'zcall-engine','main-engine.js')).createMainEngine({" +
  "sendToRender:function(mm){w.webContents.send(mm.type==='update'?'call-update':'call-send-signal',mm.command,mm.data)}," +
  "ui:_mkUi()});}" +
  "globalThis.__zeng.handleSendToNative(t);}catch(_e){try{console.error('[ZENGINE]',_e&&_e.stack||_e)}catch(__){}}})";

const COPY = [
  ['tools/zcall-engine/main-engine.js', 'main-engine.js'],
  ['tools/zcall-signaling/requestcall.js', '../zcall-signaling/requestcall.js'],
  ['tools/zcall-signaling/call-control.js', '../zcall-signaling/call-control.js'],
  ['tools/zcall-signaling/cdp-invoke.js', '../zcall-signaling/cdp-invoke.js'],
  ['tools/zcall-signaling/zpw.js', '../zcall-signaling/zpw.js'],
  ['tools/zcall-media/media-session.js', '../zcall-media/media-session.js'],
  ['tools/zcall-media/initzrtp.js', '../zcall-media/initzrtp.js'],
  ['tools/zcall-media/rtp.js', '../zcall-media/rtp.js'],
  ['tools/zcall-media/media-frame.js', '../zcall-media/media-frame.js'],
  ['tools/zcall-media/srtp-kdf.js', '../zcall-media/srtp-kdf.js'],
  ['tools/zcall-media/srtp-decrypt.js', '../zcall-media/srtp-decrypt.js'],
  ['tools/zcall-media/zsrtp.js', '../zcall-media/zsrtp.js'],
  ['tools/zcall-media/zaudio.js', '../zcall-media/zaudio.js'],
];

// Pure: patch the main.js source. Fail-loud if the handler anchor is gone.
function applyMainPatch(src) {
  if (src.includes(MARKER)) return src;
  if (!src.includes(ANCHOR)) {
    throw new Error('patch-zcall-main-engine: call-send-to-native handler anchor not found — main.js layout changed.');
  }
  let out = src.replace(ANCHOR, REPLACEMENT);
  if (!out.startsWith(REQCAP)) out = REQCAP + out;
  return out;
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error('patch-zcall-main-engine: ' + logger.formatPath(MAIN_JS) + ' not found (run extract first)');
  }
  // Build both addons against the Electron ABI.
  for (const addon of ['zsrtp', 'zaudio']) {
    const libDir = path.join(REPO, 'nativelibs', addon);
    const bd = path.join(libDir, 'scripts', 'build-deps.sh');
    if (fs.existsSync(bd)) execSync('bash "' + bd + '"', { cwd: REPO, stdio: 'inherit' });
    logger.info('Building ' + addon + ' addon (Electron ABI)...');
    execSync('node "' + BUILDER + '" "' + libDir + '"', { cwd: REPO, stdio: 'inherit' });
    if (!fs.existsSync(path.join(libDir, 'build', 'Release', addon + '.node'))) {
      throw new Error('patch-zcall-main-engine: ' + addon + ' build produced no .node');
    }
  }
  // Copy engine + reused modules (preserving ../zcall-signaling / ../zcall-media layout).
  fs.ensureDirSync(ENGINE_DIR);
  for (const [from, to] of COPY) {
    const dst = path.join(ENGINE_DIR, to);
    fs.ensureDirSync(path.dirname(dst));
    fs.copySync(path.join(REPO, from), dst);
  }
  // Addons go NEXT TO the zsrtp.js/zaudio.js loaders (../zcall-media/), whose same-dir candidate
  // (`./<addon>.node`) then resolves.
  const mediaDir = path.join(ENGINE_DIR, '..', 'zcall-media');
  fs.ensureDirSync(mediaDir);
  for (const addon of ['zsrtp', 'zaudio']) {
    fs.copySync(path.join(REPO, 'nativelibs', addon, 'build', 'Release', addon + '.node'), path.join(mediaDir, addon + '.node'));
  }
  // Copy the call-window UI (minus its tests) to app/native/zcall-ui/.
  fs.ensureDirSync(UI_DIR);
  fs.copySync(UI_SRC, UI_DIR, { filter: (src) => !src.split(path.sep).includes('__tests__') });
  // Reuse the app's own icon font for the call glyphs (fail loud if the render bundle moved it).
  const fontMatch = fs.existsSync(FONTS_DIR)
    ? fs.readdirSync(FONTS_DIR).find((f) => /^zalo-font\..*\.ttf$/.test(f))
    : null;
  if (!fontMatch) {
    throw new Error('patch-zcall-main-engine: zalo-font.*.ttf not found in ' + logger.formatPath(FONTS_DIR) + ' — render bundle layout changed');
  }
  fs.ensureDirSync(path.join(UI_DIR, 'assets'));
  fs.copySync(path.join(FONTS_DIR, fontMatch), path.join(UI_DIR, 'assets', 'zalo-font.ttf'));

  // Patch main.js.
  let s = fs.readFileSync(MAIN_JS, 'utf8');
  s = applyMainPatch(s);
  fs.writeFileSync(MAIN_JS, s, 'utf8');
  if (!s.includes(MARKER)) throw new Error('patch-zcall-main-engine: marker not applied');
  logger.success('zcall-main-engine: main.js call handler -> main-process engine; modules/addons copied');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyMainPatch };
