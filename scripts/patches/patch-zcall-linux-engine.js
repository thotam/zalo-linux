const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// Replace the Linux $zcall stub with the real engine, and copy the engine + reused modules + the
// two built native addons into the app's zcall dir (preserving the ../zcall-signaling and
// ../zcall-media layout engine.js requires). Idempotent, fail-loud.
const ZCALL_DIR = path.join(__dirname, '..', '..', 'app', 'native', 'nativelibs', 'zcall');
const BINDING = path.join(ZCALL_DIR, 'binding.js');
const MARKER = '/*linux-zcall-engine*/';
const REPO = path.join(__dirname, '..', '..');

const COPY = [
  ['tools/zcall-engine/engine.js', 'engine.js'],
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

// Pure: rewrite the binding.js Linux else-branch body to require the engine. Fail-loud if the
// getLib/MainApp anchor is gone.
function applyBindingPatch(src) {
  if (src.includes(MARKER)) return src;
  if (!src.includes('function getLib()')) {
    throw new Error('patch-zcall-linux-engine: binding.js anchor (getLib) not found — layout changed.');
  }
  const re = /(\}\s*else\s*\{)([\s\S]*?)(\}\s*\})(?=\s*module\.exports)/;
  if (!re.test(src)) throw new Error('patch-zcall-linux-engine: could not locate the Linux else-branch anchor.');
  return src.replace(re, (_m, open, _body, close) => open + MARKER + "return require('./engine.js');" + close);
}

const BUILDER = path.join(REPO, 'nativelibs', 'builder.js');

async function main() {
  if (!fs.existsSync(BINDING)) {
    throw new Error('patch-zcall-linux-engine: ' + logger.formatPath(BINDING) + ' not found (run extract first)');
  }
  // Build both addons against the Electron ABI (builder.js uses --target=<ELECTRON_VERSION>), like
  // patch-mp4thumb. static libsrtp2 / libopus + dlopen miniaudio → no new deb Depends.
  for (const addon of ['zsrtp', 'zaudio']) {
    const libDir = path.join(REPO, 'nativelibs', addon);
    const bd = path.join(libDir, 'scripts', 'build-deps.sh');
    if (fs.existsSync(bd)) execSync('bash "' + bd + '"', { cwd: REPO, stdio: 'inherit' });
    logger.info('Building ' + addon + ' addon (Electron ABI)...');
    execSync('node "' + BUILDER + '" "' + libDir + '"', { cwd: REPO, stdio: 'inherit' });
    if (!fs.existsSync(path.join(libDir, 'build', 'Release', addon + '.node'))) {
      throw new Error('patch-zcall-linux-engine: ' + addon + ' build produced no .node');
    }
  }
  for (const [from, to] of COPY) {
    const dst = path.join(ZCALL_DIR, to);
    fs.ensureDirSync(path.dirname(dst));
    fs.copySync(path.join(REPO, from), dst);
  }
  for (const addon of ['zsrtp', 'zaudio']) {
    const built = path.join(REPO, 'nativelibs', addon, 'build', 'Release', addon + '.node');
    if (!fs.existsSync(built)) {
      throw new Error('patch-zcall-linux-engine: missing built addon ' + addon + '.node (build it against Electron first)');
    }
    fs.copySync(built, path.join(ZCALL_DIR, addon + '.node'));
  }
  let s = fs.readFileSync(BINDING, 'utf8');
  s = applyBindingPatch(s);
  fs.writeFileSync(BINDING, s, 'utf8');
  if (!s.includes(MARKER)) throw new Error('patch-zcall-linux-engine: marker not applied');
  logger.success('zcall-linux-engine: binding.js -> engine.js + modules/addons copied');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyBindingPatch };
