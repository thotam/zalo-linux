const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// DIAGNOSTICS-ONLY patch. Instruments the Linux call path to find why voice/video
// calls don't work, WITHOUT changing the remote voicecall-wpa web app:
//   1. copy the instrumentation module -> app/main-dist/__call_diag.js
//   2. prepend `require("./__call_diag.js")` to main.js (runs it in the main process)
//   3. enable webviewTag on the app windows (partition:"persist:zalo") so the call
//      <webview> can attach and be observed.
// The module logs webview lifecycle + media permission requests (grants media) +
// renderer console to ~/zalo-call-diag.log. NOT part of the shipping build.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'app', 'main-dist', 'main.js');
const SRC_MODULE = path.join(__dirname, 'data', 'call-diag.js');
const DST_MODULE = path.join(ROOT, 'app', 'main-dist', '__call_diag.js');

const REQUIRE_LINE = 'require("./__call_diag.js");';
const BUNDLE_ANCHOR = '__ZaBUNDLENAME__="main"';
const WV_PERSIST = 'partition:"persist:zalo"';

async function main() {
  if (!fs.existsSync(MAIN)) {
    throw new Error(`patch-call-diagnostics: ${logger.formatPath(MAIN)} not found (run extract first)`);
  }
  if (!fs.existsSync(SRC_MODULE)) {
    throw new Error(`patch-call-diagnostics: instrumentation module missing at ${logger.formatPath(SRC_MODULE)}`);
  }

  // 1. Copy the instrumentation module next to main.js.
  fs.copyFileSync(SRC_MODULE, DST_MODULE);

  let s = fs.readFileSync(MAIN, 'utf8');

  // 2. Prepend the require (idempotent).
  if (!s.startsWith(REQUIRE_LINE)) {
    if (!s.includes(BUNDLE_ANCHOR)) {
      throw new Error('patch-call-diagnostics: main.js bundle anchor `__ZaBUNDLENAME__="main"` not found — bundle changed.');
    }
    s = REQUIRE_LINE + s;
  } else {
    logger.dim('call-diagnostics: require already present');
  }

  // 3. Enable webviewTag on every persist:zalo webPreferences (idempotent).
  if (!s.includes(WV_PERSIST)) {
    throw new Error('patch-call-diagnostics: no `partition:"persist:zalo"` webPreferences found — bundle changed.');
  }
  // Insert `webviewTag:!0,` right before the `partition:"persist:zalo"` key of each
  // webPreferences block, skipping blocks already carrying webviewTag (idempotent). The
  // negative lookahead on the preceding block body keeps re-runs from double-inserting.
  s = s.replace(new RegExp('(webPreferences:\\{(?:(?!webviewTag)[^}])*?)' + 'partition:"persist:zalo"', 'g'),
    (m0, pre) => pre + 'webviewTag:!0,' + WV_PERSIST);

  fs.writeFileSync(MAIN, s, 'utf8');

  // Post-conditions (fail loud).
  if (!s.startsWith(REQUIRE_LINE)) throw new Error('patch-call-diagnostics: require not prepended');
  if (!s.includes('webviewTag:!0,' + WV_PERSIST)) throw new Error('patch-call-diagnostics: webviewTag not applied');
  if (!fs.existsSync(DST_MODULE)) throw new Error('patch-call-diagnostics: module not copied');

  logger.success('call-diagnostics installed (webviewTag + main-process instrumentation)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
