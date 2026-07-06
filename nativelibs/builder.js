const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../scripts/utils/logger');

const ROOT_PKG = require(path.join(__dirname, '..', 'package.json'));
const ELECTRON_VERSION = ROOT_PKG.devDependencies.electron.replace(/^[\^~]/, '');

const libDir = path.resolve(process.argv[2]);
const releaseDir = path.join(libDir, 'build', 'Release');

logger.dim(`Lib dir: ${libDir}`);
logger.dim(`Electron: ${ELECTRON_VERSION}`);

if (!fs.existsSync(path.join(libDir, 'node_modules'))) {
  execSync('npm install --ignore-scripts --no-audit --no-fund --loglevel=error', { cwd: libDir, stdio: 'inherit' });
}

execSync(
  `npx node-gyp rebuild --target=${ELECTRON_VERSION} --arch=x64 --dist-url=https://electronjs.org/headers`,
  { cwd: libDir, stdio: 'inherit' }
);

const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
if (nodeFiles.length === 0) throw new Error(`Build produced no .node in ${releaseDir}`);
logger.success(`Built ${nodeFiles[0]} (${(fs.statSync(path.join(releaseDir, nodeFiles[0])).size / 1024).toFixed(1)} KB)`);
