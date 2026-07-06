const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');

async function main() {
  let version = '0.0.0';
  const bak = path.join(APP_DIR, 'package.json.bak');
  if (fs.existsSync(bak)) {
    version = JSON.parse(fs.readFileSync(bak, 'utf8')).version || version;
  } else {
    logger.warn('package.json.bak not found; version unknown');
  }
  logger.info('Zalo version:', version);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${version}\n`);
  }

  const artifact = `Zalo-${version}.deb`;
  const cmd = `npx electron-builder --linux deb ` +
    `--config.linux.artifactName="${artifact}" ` +
    `-c.extraMetadata.version=${version} --publish=never`;
  logger.dim(cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

  const out = path.join(ROOT, 'dist', artifact);
  if (fs.existsSync(out)) {
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    logger.success(`Built ${artifact} (${mb} MB)`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `deb_name=${artifact}\ndeb_file=dist/${artifact}\n`);
    }
  } else {
    throw new Error(`Expected artifact missing: ${out}`);
  }
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
