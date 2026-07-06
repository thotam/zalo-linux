const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const MAIN = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

async function main() {
  if (!fs.existsSync(MAIN)) {
    throw new Error(`patch-platform-id: ${MAIN} not found — did extraction run (asar.extractAll -> app/)?`);
  }
  let c = fs.readFileSync(MAIN, 'utf8');
  if (c.includes('case"LINUX":return 25;')) {
    c = c.replace(/case"LINUX":return 25;/g, 'case"LINUX":return 24;');
    fs.writeFileSync(MAIN, c, 'utf8');
    logger.dim('platform-id: LINUX 25 -> 24 (client-type WIN32, enables E2EE history sync)');
  } else if (c.includes('case"LINUX":return 24;')) {
    logger.dim('platform-id: already patched (LINUX -> 24)');
  } else {
    throw new Error('patch-platform-id: pattern case"LINUX":return 25; not found in main.js — Zalo bundle format changed, update the regex');
  }
  // Post-condition (fail loud): the LINUX branch must now return 24 and never 25.
  const after = fs.readFileSync(MAIN, 'utf8');
  if (after.includes('case"LINUX":return 25;')) {
    throw new Error('patch-platform-id: post-condition failed — case"LINUX":return 25; still present');
  }
  if (!after.includes('case"LINUX":return 24;')) {
    throw new Error('patch-platform-id: post-condition failed — case"LINUX":return 24; not present');
  }
  logger.success('platform-id patched (getClientType LINUX -> 24)');
}

if (require.main === module) main();
module.exports = { main };
