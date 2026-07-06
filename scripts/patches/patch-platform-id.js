const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const MAIN_DIST = path.join(__dirname, '..', '..', 'app', 'main-dist');
const OLD = 'case"LINUX":return 25;';
const NEW = 'case"LINUX":return 24;';

async function main() {
  if (!fs.existsSync(MAIN_DIST)) {
    throw new Error(`patch-platform-id: ${MAIN_DIST} not found — did extraction run (asar.extractAll -> app/)?`);
  }
  const files = fs.readdirSync(MAIN_DIST).filter(f => f.endsWith('.js')).map(f => path.join(MAIN_DIST, f));
  let filesPatched = 0, totalRepl = 0, filesAlready = 0;
  for (const file of files) {
    let c = fs.readFileSync(file, 'utf8');
    const hits = c.split(OLD).length - 1;
    if (hits > 0) {
      c = c.split(OLD).join(NEW);
      fs.writeFileSync(file, c, 'utf8');
      filesPatched++; totalRepl += hits;
      logger.dim(`platform-id: ${hits}x LINUX 25->24 in ${path.basename(file)}`);
    } else if (c.includes(NEW)) {
      filesAlready++;
    }
  }
  if (filesPatched === 0 && filesAlready === 0) {
    throw new Error('patch-platform-id: pattern case"LINUX":return 25; not found in any app/main-dist/*.js — Zalo bundle format changed, update the pattern');
  }
  // Post-condition (fail loud): no main-dist bundle may still return 25 for LINUX.
  for (const file of files) {
    if (fs.readFileSync(file, 'utf8').includes(OLD)) {
      throw new Error(`patch-platform-id: post-condition failed — ${path.basename(file)} still has case"LINUX":return 25;`);
    }
  }
  logger.success(`platform-id patched (getClientType LINUX -> 24 across ${filesPatched} file(s), ${totalRepl} occurrence(s); ${filesAlready} already patched)`);
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
