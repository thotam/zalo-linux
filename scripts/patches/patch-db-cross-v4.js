const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'db-cross-v4');

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
    // Critical patch: the vendored source is mandatory in the clean port — fail loud.
    throw new Error(`db-cross-v4 source missing at ${LIB_DIR}/binding.gyp`);
  }

  logger.info('Building db-cross-v4 from source...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });

  const releaseDir = path.join(LIB_DIR, 'build', 'Release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
  if (nodeFiles.length === 0) throw new Error('db-cross-v4 build produced no .node');

  const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'prebuilt', 'linux', 'electron', 'x64');
  fs.ensureDirSync(destDir);
  // The Zalo binding.js requires the file named exactly db-cross-v4-native.node
  fs.copyFileSync(path.join(releaseDir, nodeFiles[0]), path.join(destDir, 'db-cross-v4-native.node'));
  logger.dim('Installed Linux db-cross-v4-native.node');

  const bindingJs = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'dist', 'binding.js');
  if (!fs.existsSync(bindingJs)) {
    // Critical: binding.js only exists if extraction overlaid app.asar.unpacked — fail loud.
    throw new Error(`binding.js not found at ${bindingJs} — did extraction overlay app.asar.unpacked?`);
  }

  let c = fs.readFileSync(bindingJs, 'utf8');
  if (c.includes("process.platform === 'linux'")) {
    logger.dim('binding.js already has linux branch');
  } else {
    const before = c;
    c = c.replace(
      /else \{\s*if \(process\.arch === 'x64'\)/,
      `else if (process.platform === 'linux') {\n    addon = require('../prebuilt/linux/electron/x64/db-cross-v4-native.node');\n}\nelse {\n    if (process.arch === 'x64')`
    );
    if (c === before) {
      // Critical fail-loud: upstream binding.js format changed; do NOT ship a broken splice.
      throw new Error("binding.js linux branch NOT inserted — the /else { if (process.arch === 'x64')/ pattern no longer matches; update the regex in patch-db-cross-v4.js");
    }
    fs.writeFileSync(bindingJs, c, 'utf8');
    logger.dim('Patched binding.js with linux branch');
  }

  logger.success('db-cross-v4 installed');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
