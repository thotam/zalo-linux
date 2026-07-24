const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Linux call ENABLER (gap #1). The 1-1 call buttons are gated by
//   isSupport() = enable_mac_call && (enableCall && <osOk>)
// where `<osOk> = ae()` and `ae()` returns false when `os.release()`'s major version is
// < 17 (a macOS Darwin>=17 / macOS 10.13+ check). On Linux, os.release() is the Linux
// kernel version (e.g. "7.0.0-...") whose major (7) is < 17, so ae() is false and the
// call buttons never render.
//
// The call/chat code is duplicated across SEVERAL webpack bundles with per-bundle minified
// variable names (compact-app-pc uses A.default/ie; the real running bundle
// lazy/default-login-main-startup-shared-worker-znotification uses u.default/se; the search
// and sync workers have their own). The ORIGINAL patch only touched compact-app-pc — which
// belongs to compact-app.html and is never loaded by the main window (index.html) — so it
// had no effect. This version patches EVERY bundle that carries the gate, matching the
// os-version check and isSupport() generically (regex-captured var names).
//
//   1. neutralize the `<17` check so ae() is true on Linux (buttons can render), and
//   2. wrap isSupport() to console.ERROR its components ([CALLDIAG] ...) — captured by the
//      main-process CONSOLE diagnostics hook — so we see whether enableCall / enableVideoCall
//      (server-driven) are the next gap. (Electron 39's console-message only forwards
//      warning/error level; console.log/info is dropped.)
// Idempotent per file; fail-loud if NO bundle carries the gate (bundle format changed).
// ---------------------------------------------------------------------------

const PCDIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');

// ae() os-version check. `e` is the arrow param in every bundle, so this literal is stable.
const AE_ANCHOR = 'Number(e.split(".")[0])<17';
const AE_PATCHED = '!1/*call-linux*/';

// isSupport() with per-bundle var names captured:
//   original:            isSupport(){return!!<OBJ>.default.enable_mac_call&&(<OBJ>.default.enableCall&&<OSOK>)}
//   prior instrumented:  isSupport(){var _s=!!<OBJ>.default.enable_mac_call&&(<OBJ>.default.enableCall&&<OSOK>);...return _s}
const IS_RE = /isSupport\(\)\{return!!(\w+)\.default\.enable_mac_call&&\((\w+)\.default\.enableCall&&(\w+)\)\}/;
const IS_PRIOR_RE = /isSupport\(\)\{var _s=!!(\w+)\.default\.enable_mac_call&&\((\w+)\.default\.enableCall&&(\w+)\);try\{console\.error\("\[CALLDIAG\] isSupport[\s\S]*?return _s\}/;
const IS_MARKER = '[CALLDIAG] isSupport';
const FORCED_MARKER = '/*mac-forced*/';

// isSupport() with the `enable_mac_call` requirement DROPPED — that flag is the macOS
// build/entitlement gate the server keeps 0 for this account, but the actual call feature
// (enableCall && osOk) is on. Returns enableCall && osOk; still logs the real enable_mac_call.
function instrumentedIsSupport(obj, osOk) {
  return (
    'isSupport(){' + FORCED_MARKER + 'var _mc=' + obj + '.default.enable_mac_call;' +
    'var _s=!!(' + obj + '.default.enableCall&&' + osOk + ');' +
    'try{console.error("[CALLDIAG] isSupport="+_s+" enable_mac_call="+_mc+' +
    '" enableCall="+' + obj + '.default.enableCall+" enableVideoCall="+' + obj + '.default.enableVideoCall+' +
    '" osOk="+' + osOk + ')}catch(_e){}return _s}'
  );
}

// Every top-level *.js and lazy/*.js bundle. We patch whichever ones carry the gate.
function candidateBundles() {
  const files = [];
  for (const f of fs.readdirSync(PCDIST)) {
    if (f.endsWith('.js')) files.push(path.join(PCDIST, f));
  }
  const lazy = path.join(PCDIST, 'lazy');
  if (fs.existsSync(lazy)) {
    for (const f of fs.readdirSync(lazy)) {
      if (f.endsWith('.js')) files.push(path.join(lazy, f));
    }
  }
  return files;
}

function patchOne(file) {
  let s = fs.readFileSync(file, 'utf8');
  const hasAe = s.includes(AE_ANCHOR) || s.includes(AE_PATCHED);
  const hasIs = IS_RE.test(s) || s.includes(IS_MARKER);
  if (!hasAe && !hasIs) return null; // bundle doesn't carry the call gate — skip.

  let changed = false;

  // 1. ae() <17 -> always pass (all occurrences; idempotent).
  if (s.includes(AE_ANCHOR)) {
    s = s.split(AE_ANCHOR).join(AE_PATCHED);
    changed = true;
  }

  // 2. isSupport(): drop the enable_mac_call gate + instrument. Idempotent via FORCED_MARKER;
  //    upgrades either the original form OR a prior (non-forced) instrumented form.
  if (!s.includes(FORCED_MARKER)) {
    let m = s.match(IS_RE);
    let re = IS_RE;
    if (!m) { m = s.match(IS_PRIOR_RE); re = IS_PRIOR_RE; }
    if (m) {
      const [, obj, obj2, osOk] = m;
      if (obj !== obj2) {
        // Extremely unlikely (both are the same config module); bail rather than mis-patch.
        throw new Error('patch-call-support-linux: isSupport() object mismatch (' + obj + ' vs ' + obj2 + ') in ' + path.basename(file));
      }
      s = s.replace(re, instrumentedIsSupport(obj, osOk));
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(file, s, 'utf8');
  return changed;
}

async function main() {
  const bundles = candidateBundles();
  const patched = [];
  for (const file of bundles) {
    const r = patchOne(file);
    if (r === true) patched.push(path.basename(file));
  }

  if (!patched.length) {
    // Either nothing carried the gate (format drift) or all were already patched.
    const anyGate = bundles.some((f) => {
      const s = fs.readFileSync(f, 'utf8');
      return s.includes(AE_PATCHED) || s.includes(IS_MARKER);
    });
    if (!anyGate) {
      throw new Error('patch-call-support-linux: no bundle carries the call gate (ae()<17 / isSupport) — bundle format changed.');
    }
    logger.dim('call-support-linux: all call-gate bundles already patched');
    return;
  }

  logger.success('call-support-linux: ae()<17 bypassed + isSupport() instrumented in ' + patched.length + ' bundle(s): ' + patched.join(', '));
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
