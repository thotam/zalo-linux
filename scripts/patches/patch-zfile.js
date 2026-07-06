const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'zfile');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zfile', 'linux');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'zfile', 'index.js');

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
    throw new Error('zfile source not found at nativelibs/zfile — cannot build');
  }

  logger.info('Building zfile-native from source...');
  execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });

  const releaseDir = path.join(LIB_DIR, 'build', 'Release');
  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
  if (nodeFiles.length === 0) throw new Error('zfile build produced no .node');

  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'zfile-native.node');
  fs.copyFileSync(path.join(releaseDir, nodeFiles[0]), destNode);
  logger.dim('Installed Linux zfile-native.node');

  // Splice a linux branch into index.js that requires the native .node DIRECTLY
  // (no JS wrapper). The native addon exports exactly the methods getLib() calls
  // (getInfo/getDiskInfo/copyFolder/cancelCopy/canRead/canWrite/canReadAndWrite),
  // so index.js uses it unwrapped. zfile has 0 call sites in this bundle; it is
  // built only for parity, so the renderer's by-path disk lookup never runs here.
  if (!fs.existsSync(INDEX_JS)) {
    throw new Error('zfile/index.js not found — did extraction overlay app.asar.unpacked?');
  }
  let c = fs.readFileSync(INDEX_JS, 'utf8');
  if (!c.includes("process.platform === 'linux'")) {
    const before = c;
    // matches the stub: `}else{ return { stat... }` (whitespace-tolerant)
    c = c.replace(
      /\}\s*else\s*\{\s*return\s*\{\s*\n?\s*stat:/,
      "}else if(process.platform === 'linux'){\n        addon = require('./linux/zfile-native.node');\n    }else{\n        return {\n            stat:"
    );
    if (c === before) {
      throw new Error("patch-zfile: could not insert linux branch — zfile/index.js format changed, update the regex");
    }
    fs.writeFileSync(INDEX_JS, c, 'utf8');
    logger.dim('Patched zfile/index.js with linux branch (requires zfile-native.node directly)');
  } else {
    logger.dim('zfile/index.js already has linux branch');
  }

  // Post-conditions: fail hard if the native lib or the branch did not land.
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) {
    throw new Error(`patch-zfile: post-condition failed — ${destNode} missing/empty`);
  }
  const after = fs.readFileSync(INDEX_JS, 'utf8');
  if (!after.includes("process.platform === 'linux'")) {
    throw new Error('patch-zfile: post-condition failed — linux branch not present in index.js');
  }
  // Load index.js the way the app does and assert diskInfo() works against the
  // native addon (mount-keyed) without throwing.
  delete require.cache[require.resolve(INDEX_JS)];
  const zfile = require(INDEX_JS);
  const disks = await zfile.diskInfo();
  if (!disks || typeof disks !== 'object' || Object.keys(disks).length === 0) {
    throw new Error('patch-zfile: post-condition failed — zfile.diskInfo() returned no drives');
  }

  logger.success('zfile installed');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
