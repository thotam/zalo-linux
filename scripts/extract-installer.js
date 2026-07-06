const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const TEMP_DIR = path.join(ROOT, 'temp');

function commandExists(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function resolveDmg() {
  if (process.env.ZALO_DMG) {
    const p = path.resolve(process.env.ZALO_DMG);
    if (!fs.existsSync(p)) throw new Error(`ZALO_DMG not found: ${p}`);
    return p;
  }
  if (!fs.existsSync(TEMP_DIR)) throw new Error('No ZALO_DMG and temp/ is empty');
  const dmgs = fs.readdirSync(TEMP_DIR).filter(f => f.toLowerCase().endsWith('.dmg'));
  if (dmgs.length === 0) throw new Error('No .dmg in temp/ and no ZALO_DMG');
  dmgs.sort();
  return path.join(TEMP_DIR, dmgs[dmgs.length - 1]);
}

async function main() {
  if (!commandExists('7z')) {
    throw new Error('7z not installed. Run: sudo apt-get install -y p7zip-full');
  }

  const dmgPath = resolveDmg();
  logger.info('Installer (DMG):', dmgPath);

  fs.removeSync(APP_DIR);
  fs.ensureDirSync(TEMP_DIR);
  const work = path.join(TEMP_DIR, 'extract');
  fs.removeSync(work);
  fs.ensureDirSync(work);

  // DMG -> app.asar + app.asar.unpacked (macOS layout: Zalo*/Zalo.app/Contents/Resources/).
  // 7z reads the compressed DMG directly. The top folder name contains a space
  // ("Zalo <ver>-universal"), so the glob keeps a wildcard before Zalo.app.
  logger.info('Extracting app.asar and app.asar.unpacked from DMG...');
  execSync(
    `7z x "${dmgPath}" "Zalo*/Zalo.app/Contents/Resources/app.asar" "Zalo*/Zalo.app/Contents/Resources/app.asar.unpacked/*" -o"${work}" -y`,
    { stdio: 'pipe' }
  );

  const resources = execSync(`find "${work}" -path "*/Resources/app.asar" -type f`, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)[0];
  if (!resources) throw new Error('app.asar not found after DMG extraction');
  const resourcesDir = path.dirname(resources);

  // asar extractAll -> app/
  logger.info('Unpacking app.asar to app/...');
  const asar = require('@electron/asar');
  await asar.extractAll(path.join(resourcesDir, 'app.asar'), APP_DIR);

  // overlay app.asar.unpacked (real native loader JS + prebuilt dirs)
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    logger.info('Overlaying app.asar.unpacked...');
    fs.copySync(unpacked, APP_DIR, { overwrite: true });
  } else {
    logger.warn('app.asar.unpacked not found — native loaders may be missing');
  }

  // rename package.json so our shell package.json wins at runtime
  const pkg = path.join(APP_DIR, 'package.json');
  if (fs.existsSync(pkg)) fs.renameSync(pkg, path.join(APP_DIR, 'package.json.bak'));

  logger.success('app/ prepared');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
