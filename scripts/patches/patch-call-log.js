const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// The render writes the chat call-log entry in the call controller's handleUpdate `case "bubble"`,
// but (1) it is gated behind `if(<cfg>.call.sync_call_message.ui)return;` (flag defaults ON, so the
// app expects a server-synced message instead — which the Linux caller never gets), and (2) the
// message template hard-codes the outcome, so every outgoing call would render "Cuộc gọi thoại đi".
//
// The active call controller runs in the `default-login-main-startup-shared-worker-znotification`
// chunk (not compact-app-pc). We patch EVERY pc-dist bundle that carries this code (var-agnostic,
// keyed on the stable data-param `t`/`n`) so whichever chunk is active is covered:
//   1. neutralize the sync_call_message.ui bubble-guard
//   2. thread reason/calltype/missed from our engine's bubble update into the message payload
//   3. build content.action from `t.missed`  (misscall vs calling/receivecall)
//   4. build content.params from `t.caller/reason/calltype`  (the render DERIVES the label from
//      action + params.reason; title/description are dead) so each outcome renders its real label:
//      answered -> "Cuộc gọi thoại đi" + duration; reason 4 -> "Bạn đã hủy"; 3 -> "Người nhận từ chối";
//      1 -> "Người nhận bận".
const REPO = path.join(__dirname, '..', '..');
const PC_DIST = path.join(REPO, 'app', 'pc-dist');

// Each transform: [alreadyDone marker, find, replace]. Applied per file, only if the find anchor is
// present and the marker absent (idempotent). Missing anchors in a given file are fine (that file
// simply doesn't carry that snippet); global coverage is asserted after.
const GUARD_DONE = 'sync_call_message.ui&&0)return;';
const GUARD_FIND = 'sync_call_message.ui)return;';

const BUBBLE_DONE = ',reason:n.reason,calltype:n.calltype,missed:n.missed}';
const BUBBLE_FIND = 'const e={caller:n.role,duration:1e3*n.duration,userId:n.partnerId}';
const BUBBLE_REPL = 'const e={caller:n.role,duration:1e3*n.duration,userId:n.partnerId,reason:n.reason,calltype:n.calltype,missed:n.missed}';

const ACTION_DONE = '"recommened.misscall":t.caller?';
const ACTION_RE = /[A-Za-z_$][\w$]*\?"recommened\.calling":"recommened\.receivecall"/g;
const ACTION_REPL = 't.missed?"recommened.misscall":t.caller?"recommened.calling":"recommened.receivecall"';

const PARAMS_DONE = 'isCaller:t.caller?1:0';
const PARAMS_FIND = 'params:\'{"isEnableCallback":1}\'';
const PARAMS_REPL = 'params:JSON.stringify({isCaller:t.caller?1:0,calltype:t.calltype||0,reason:t.reason||0,isEnableCallback:1})';

// Pure: apply all four transforms to one bundle's source. Returns { src, applied } where `applied`
// counts the transforms that fired (0 = this bundle carries none of the anchors).
function applyCallLogPatch(src) {
  let applied = 0;
  if (!src.includes(GUARD_DONE) && src.includes(GUARD_FIND)) { src = src.split(GUARD_FIND).join(GUARD_DONE); applied++; }
  if (!src.includes(BUBBLE_DONE) && src.includes(BUBBLE_FIND)) { src = src.split(BUBBLE_FIND).join(BUBBLE_REPL); applied++; }
  if (!src.includes(ACTION_DONE) && ACTION_RE.test(src)) { src = src.replace(ACTION_RE, ACTION_REPL); applied++; }
  if (!src.includes(PARAMS_DONE) && src.includes(PARAMS_FIND)) { src = src.split(PARAMS_FIND).join(PARAMS_REPL); applied++; }
  return { src, applied };
}

function listBundles() {
  const out = [];
  for (const f of fs.readdirSync(PC_DIST)) if (/\.js$/.test(f)) out.push(path.join(PC_DIST, f));
  const lazy = path.join(PC_DIST, 'lazy');
  if (fs.existsSync(lazy)) for (const f of fs.readdirSync(lazy)) if (/\.js$/.test(f)) out.push(path.join(lazy, f));
  return out;
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error('patch-call-log: ' + logger.formatPath(PC_DIST) + ' not found (run extract first)');
  }
  let guarded = 0, templated = 0, files = 0;
  for (const fp of listBundles()) {
    const before = fs.readFileSync(fp, 'utf8');
    const { src, applied } = applyCallLogPatch(before);
    if (applied > 0) { fs.writeFileSync(fp, src, 'utf8'); files++; }
    if (src.includes(GUARD_DONE)) guarded++;
    if (src.includes(PARAMS_DONE)) templated++;
  }
  // The bubble-guard and the message template must each have been patched in at least one bundle,
  // else the render layout changed — fail loud so pins get updated instead of silently shipping
  // the always-"Cuộc gọi thoại đi" behaviour.
  if (guarded === 0) throw new Error('patch-call-log: sync_call_message bubble-guard anchor not found in any bundle — render layout changed.');
  if (templated === 0) throw new Error('patch-call-log: call-message template anchor (params) not found in any bundle — render layout changed.');
  logger.success('call-log: patched ' + files + ' bundle(s) (guard neutralized + per-outcome label action/params)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, applyCallLogPatch };
