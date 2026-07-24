'use strict';
// SP2 step-1 orchestrator: standalone Linux program that obtains a real requestcall config +
// derives the SRTP master key, by invoking the app's own requestCall via CDP. Live; own
// account/own phone only. Prints a REDACTED summary (never the raw sessId/key).
const os = require('os');
const fs = require('fs');
const path = require('path');
const { parseConfig, srtpMasterKey } = require('./requestcall.js');
const { invokeRequestCall } = require('./cdp-invoke.js');

function summarize(config, keyBuf) {
  return {
    sessIdLen: config.sessId ? config.sessId.length : 0,
    keyLen: keyBuf ? keyBuf.length : 0,
    servers: (config.servers || []).map((s) => s.rtpaddr).filter(Boolean),
    changeZRTP: config.changeZRTP,
    fromId: config.fromId,
    toId: config.toId,
  };
}

// Pull the most recent makeCall callee id out of a diag log (the app's makeCall intent).
function latestCalleeId(logText) {
  // The payload JSON is embedded (escaped) inside the diag CONSOLE line, so quotes may be
  // backslash-escaped (\"id\":\"123\"). Match makeCall then the first partner id, tolerating
  // the optional backslash before each quote.
  const re = /\[CALLDIAG-PAYLOAD\] sendToNative[^\n]*?makeCall[^\n]*?\\?"id\\?":\\?"(\d+)/g;
  let m, last = null;
  while ((m = re.exec(String(logText)))) last = m[1];
  return last;
}

async function main() {
  let calleeId = process.argv[2];
  if (!calleeId) {
    const logPath = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');
    try { calleeId = latestCalleeId(fs.readFileSync(logPath, 'utf8')); } catch (_) { /* no log */ }
    if (!calleeId) throw new Error('no calleeId: pass one as argv[2], or click call once so the diag log records a makeCall intent');
  }
  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));
  const key = srtpMasterKey(config.sessId);
  console.log(JSON.stringify(summarize(config, key), null, 2));
  console.error('[prototype] OK — Linux obtained real config + 30-byte SRTP master key (callee ' + calleeId + ').');
}

if (require.main === module) main().catch((e) => { console.error('[prototype] FAILED:', e.message); process.exit(1); });

module.exports = { summarize, latestCalleeId, main };
