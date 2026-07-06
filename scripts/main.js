const logger = require('./utils/logger');

async function main() {
  logger.step('Zalo for Linux workflow');
  try {
    if (process.env.SETUP === 'true') {
      // 1. Download the macOS DMG unless a local one is provided via ZALO_DMG.
      //    download-installer sets process.env.ZALO_DMG so extract picks it up.
      if (!process.env.ZALO_DMG) {
        logger.step('Downloading installer');
        await require('./download-installer.js').main();
      }

      // 2. Extract app.asar -> app/, overlay app.asar.unpacked, rename package.json.
      logger.step('Extracting installer');
      await require('./extract-installer.js').main();

      // 3. Patches, in fixed order. Each is idempotent; critical ones throw on
      //    pattern drift (fail loud when Zalo bumps version).
      //      platform-id   : main-dist -> client-type LINUX 25 -> 24 (unlocks E2EE sync)
      //      renderer-win32: pc-dist   -> DARWIN->WIN32 + getClientType 23->24
      //                      (renderer draws native win32 min/max/close on frameless win)
      //      sqlite3       : build SQLCipher .node -> napi-v6-linux-x64 slot
      //      db-cross-v4   : build .node + splice linux branch into dist/binding.js
      //      zfile         : build .node + splice linux branch into index.js (parity)
      //      linux-guards  : short-circuit codesign() + guard zwalker/mp4thumb/v8-profiles
      logger.step('Applying patches');
      await require('./patches/patch-platform-id.js').main();
      await require('./patches/patch-renderer-win32.js').main();
      await require('./patches/patch-sqlite3.js').main();
      await require('./patches/patch-db-cross-v4.js').main();
      await require('./patches/patch-zfile.js').main();
      await require('./patches/patch-linux-guards.js').main();
      logger.success('All patches applied');
    }

    if (process.env.BUILD === 'true') {
      logger.step('Building .deb');
      await require('./build.js').main();
    }
  } catch (e) {
    logger.error('Workflow failed:', e.message);
    process.exit(1);
  }
}

main();
