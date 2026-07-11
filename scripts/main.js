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
      //      tray          : main-dist -> un-gate the macOS tray on Linux + resize the
      //                      app icon at runtime (reveal needs no fix on E39/Wayland)
      //      renderer-win32: pc-dist   -> DARWIN->WIN32 + getClientType 23->24
      //                      (renderer draws native win32 min/max/close on frameless win)
      //      sqlite3       : build SQLCipher .node -> napi-v6-linux-x64 slot
      //      db-cross-v4   : build .node + splice linux branch into dist/binding.js
      //      zfile         : build .node + splice linux branch into index.js (parity)
      //      linux-guards  : short-circuit codesign() (zwalker/mp4thumb now own their load)
      //      v8-profiles   : build native CPU profiler .node + splice linux require
      //                      (real native; no fallback stub, by request)
      //      zjxl          : build native JPEG-XL addon (pinned libjxl 0.9.3 +
      //                      libjpeg-turbo 3.1.1 + OpenCV 4.12) + bundle .so +
      //                      splice linux branch (images render/send)
      //      zimage        : build native libvips thumbnail addon (libvips 8.14.2
      //                      + mozjpeg 4.1.1, mac backend parity) + bundle .so
      //                      closure w/ RPATH=$ORIGIN + splice linux branch
      // Notify (non-fatally) if this Zalo build changed any bundled/linked native
      // library version vs our tracked baseline — so pins (e.g. zjxl libjxl /
      // libjpeg-turbo) can be updated to stay byte-identical. Never blocks SETUP.
      logger.step('Checking native library versions');
      try {
        require('child_process').execSync(
          'node "' + require('path').join(__dirname, '..', 'nativelibs', 'scripts', 'check-native-versions.js') + '" --notice',
          { stdio: 'inherit' }
        );
      } catch (e) {
        logger.dim('native-version check skipped: ' + e.message);
      }

      logger.step('Applying patches');
      await require('./patches/patch-platform-id.js').main();
      await require('./patches/patch-tray.js').main();
      await require('./patches/patch-keep-maximized.js').main();
      await require('./patches/patch-window-state.js').main();
      await require('./patches/patch-renderer-win32.js').main();
      await require('./patches/patch-titlebar-controls.js').main();
      await require('./patches/patch-media-viewer-controls.js').main();
      await require('./patches/patch-sqlite3.js').main();
      await require('./patches/patch-db-cross-v4.js').main();
      await require('./patches/patch-zfile.js').main();
      await require('./patches/patch-linux-guards.js').main();
      await require('./patches/patch-v8-profiles.js').main();
      await require('./patches/patch-zjxl.js').main();
      await require('./patches/patch-zimage.js').main();
      await require('./patches/patch-file-utilities.js').main();
      await require('./patches/patch-file-utils.js').main();
      await require('./patches/patch-mp4thumb.js').main();
      await require('./patches/patch-zwalker.js').main();
      await require('./patches/patch-native-image-flags.js').main();
      await require('./patches/patch-video-thumb-flag.js').main();
      await require('./patches/patch-clipboard-image-paste.js').main();
      await require('./patches/patch-native-lib-logging.js').main();
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
