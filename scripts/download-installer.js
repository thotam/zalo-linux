const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('./utils/logger');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DOWNLOAD_PAGE = 'https://zalo.me/download/zalo-pc?utm=90000';

function parseVersionFromLocation(loc) {
  const m = String(loc).match(/ZaloSetup-universal-([0-9.]+)\.dmg/);
  if (!m) throw new Error(`Cannot parse version from: ${loc}`);
  return m[1];
}

function buildDmgUrl(version) {
  return `https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-${version}.dmg`;
}

function assertValidVersion(v) {
  if (!/^[0-9.]+$/.test(v)) throw new Error(`Invalid ZALO_VERSION: ${v}`);
  return v;
}

function getLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(DOWNLOAD_PAGE, { headers: { 'User-Agent': MAC_UA } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try { resolve(parseVersionFromLocation(res.headers.location)); }
        catch (e) { reject(e); }
      } else {
        reject(new Error(`Unexpected HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const version = (process.env.ZALO_VERSION && process.env.ZALO_VERSION.trim()) || await getLatestVersion();
  assertValidVersion(version);
  const url = buildDmgUrl(version);
  const dest = path.join(TEMP_DIR, `ZaloSetup-universal-${version}.dmg`);

  if (fs.existsSync(dest) && !process.env.FORCE_DOWNLOAD) {
    logger.info(`Installer already present: ZaloSetup-universal-${version}.dmg`);
  } else {
    logger.info(`Downloading ZaloSetup-universal-${version}.dmg ...`);
    execSync(`wget --progress=bar:force --user-agent="${MAC_UA}" "${url}" -O "${dest}"`, { stdio: 'inherit' });
  }

  process.env.ZALO_DMG = dest;
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `ZALO_DMG=${dest}\n`);
  logger.success(`Ready: ${dest}`);
  return { version, dest };
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main, getLatestVersion, parseVersionFromLocation, buildDmgUrl, assertValidVersion };
