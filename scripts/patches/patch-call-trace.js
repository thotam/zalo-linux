const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// DIAGNOSTIC (Linux call gap #4). The call button now renders, but clicking it produces
// nothing (no call window, callee doesn't ring). This patch traces the outgoing-call chain
// in the renderer with console.ERROR probes (captured by the main-process CONSOLE hook) so
// one click reveals exactly how far it gets before dying:
//   videoCall-click   — the header onClick reached this._videoCall
//   past-isSupport    — passed the isSupport() gate (not an early return)
//   pre-managerMakeCall— reached j.d.makeCall(...) (the call-manager)
//   sendToNative      — $zcall.sendDataToNative IPC fired (signaling attempt)
//   callMainInit      — $zcall.initCall IPC fired
// If sendToNative/callMainInit fire, the renderer did its job and the gap is worker/main
// side (native engine). If we stop earlier, the renderer handler itself is the gap.
// Idempotent; only patches bundles that carry the chain.
// ---------------------------------------------------------------------------

const PCDIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');
const MARKER = '[CALLDIAG] videoCall-click';

const PROBES = [
  [
    'this._videoCall=async(e=!0,t=null)=>{',
    'this._videoCall=async(e=!0,t=null)=>{try{console.error("[CALLDIAG] videoCall-click")}catch(_e){}',
  ],
  [
    '!j.d.isSupport())return;',
    '!j.d.isSupport())return;try{console.error("[CALLDIAG] past-isSupport")}catch(_e){}',
  ],
  [
    ';j.d.makeCall(t,e,i,(e=>{',
    ';try{console.error("[CALLDIAG] pre-managerMakeCall")}catch(_e){}j.d.makeCall(t,e,i,(e=>{',
  ],
  [
    '_sendToNative(e){',
    '_sendToNative(e){try{console.error("[CALLDIAG] sendToNative");console.error("[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e))}catch(_e){}',
  ],
  [
    '_callMainInit(e){',
    '_callMainInit(e){try{console.error("[CALLDIAG] callMainInit");console.error("[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e))}catch(_e){}',
  ],
];

// In-place upgrades: an older build injected reach-only probes (no payload). Map each to the
// current payload-dumping form so re-running on an already-traced tree adds the dumps.
const UPGRADES = [
  [
    '_sendToNative(e){try{console.error("[CALLDIAG] sendToNative")}catch(_e){}',
    '_sendToNative(e){try{console.error("[CALLDIAG] sendToNative");console.error("[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e))}catch(_e){}',
  ],
  [
    '_callMainInit(e){try{console.error("[CALLDIAG] callMainInit")}catch(_e){}',
    '_callMainInit(e){try{console.error("[CALLDIAG] callMainInit");console.error("[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e))}catch(_e){}',
  ],
];

function candidateBundles() {
  const files = [];
  for (const f of fs.readdirSync(PCDIST)) if (f.endsWith('.js')) files.push(path.join(PCDIST, f));
  const lazy = path.join(PCDIST, 'lazy');
  if (fs.existsSync(lazy)) for (const f of fs.readdirSync(lazy)) if (f.endsWith('.js')) files.push(path.join(lazy, f));
  return files;
}

function patchOne(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes('this._videoCall=async(e=!0,t=null)=>{')) return null; // no call chain here
  let changed = false;

  // Upgrade earlier reach-only probes (no payload dump) to the current payload-dumping form,
  // so a tree already traced by an older build gains the [CALLDIAG-PAYLOAD] dumps in place.
  for (const [oldForm, newForm] of UPGRADES) {
    if (s.includes(oldForm) && !s.includes(newForm)) {
      s = s.split(oldForm).join(newForm);
      changed = true;
    }
  }

  const firstTime = !s.includes(MARKER);
  if (firstTime) {
    for (const [anchor, replacement] of PROBES) {
      if (s.includes(anchor) && !s.includes(replacement)) {
        s = s.replace(anchor, replacement);
        changed = true;
      }
    }
  }
  if (changed) fs.writeFileSync(file, s, 'utf8');
  return changed;
}

async function main() {
  const patched = [];
  for (const file of candidateBundles()) {
    const r = patchOne(file);
    if (r === true) patched.push(path.basename(file));
  }
  if (!patched.length) {
    logger.dim('call-trace: no bundle to patch (already traced or chain absent)');
    return;
  }
  logger.success('call-trace: click-path probes added in ' + patched.length + ' bundle(s): ' + patched.join(', '));
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
