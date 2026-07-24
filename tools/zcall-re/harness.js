'use strict';
// SP1 harness. MODE=sanity: load the addon and dump non-call info.
// Loaded on a macOS runner where the mac frameworks exist.
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT_DIR || 'scratch/zcall-analysis';
// Node 8 (the ABI-57 runtime that loads zcall_mac.node) lacks mkdirSync({recursive}).
function mkdirp(dir) {
  const parts = path.resolve(dir).split(path.sep);
  let cur = path.sep;
  for (const seg of parts) {
    if (!seg) continue;
    cur = path.join(cur, seg);
    try { fs.mkdirSync(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
mkdirp(OUT);
const BIN = process.env.ZCALL_NODE ||
  path.resolve('app/native/nativelibs/zcall/zcall_mac.node');

function safe(fn, label) { try { return fn(); } catch (e) { return { __error: label + ': ' + e.message }; } }

// Load the addon. A dlopen/ABI failure is the key go/no-go signal — record it to
// the artifact (loaded:false + the error + the runtime's ABI/electron version) and
// exit deterministically, rather than throwing uncaught (which under Electron's main
// process can hang instead of exiting).
let addon, app;
try {
  addon = require(BIN);
  app = addon.MainApp();
} catch (e) {
  const v = process.versions || {};
  fs.writeFileSync(path.join(OUT, 'zcall-sanity.json'), JSON.stringify({
    loaded: false, loadError: String(e && e.message || e),
    modulesAbi: v.modules || null, node: v.node || null, electron: v.electron || null,
  }, null, 2));
  console.error('LOAD FAILED:', String(e && e.message || e));
  process.exit(2);
}
const out = {
  loaded: true,
  node: (process.versions || {}).node || null,
  electron: (process.versions || {}).electron || null,
  test123: safe(() => app.test(123), 'test'),
  listDevices: safe(() => app.getListDevices(), 'getListDevices'),
  activeAudioCodecs: safe(() => app.getActiveAudioCodecs(), 'getActiveAudioCodecs'),
  callInfo: safe(() => app.getCallInfo(), 'getCallInfo'),
};
fs.writeFileSync(path.join(OUT, 'zcall-sanity.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

// Electron keeps the main process alive after the script body ends; exit explicitly
// in sanity mode. Call mode (below) exits from its own poll loop.
if (process.env.MODE !== 'call') process.exit(0);

// appended: MODE=call drives a controlled outbound call against loopback.
if (process.env.MODE === 'call') {
  const CAP_PORT = 59000; // loopback port we point RTP/RTCP at
  const cfg = {
    fromId: 111, toId: 222, protocol: 3, status: 3, callId: 10,
    sessId: 'SP1CAPTURE',
    settings: { logDebug: 1, dynamicBitrate: 1, checkTimeOut: 1500 },
    changeZRTP: { enable: 1, threshold: 5 },
    rtpIP: '127.0.0.1:' + CAP_PORT,
    rtcpIP: '127.0.0.1:' + (CAP_PORT + 1),
    servers: [{ rtpaddr: '127.0.0.1:' + CAP_PORT, rtcpaddr: '127.0.0.1:' + (CAP_PORT + 1) }],
    fec: { enable: 2, tableLookup: [[-1,3,1],[15,0,0]] },
  };
  const events = [];
  app.setCallback(() => {});
  // setConfig signature per vcmac.js setConfigData -> instance.setConfig(...)
  app.setConfig(JSON.stringify(cfg.settings), cfg.fromId, cfg.toId, cfg.protocol,
    cfg.callId, cfg.sessId, JSON.stringify({}), true, true,
    path.join(OUT, 'call.log'), 'linux x64', 0);
  app.setListServers(JSON.stringify(cfg.servers));
  app.makeCall();
  const t0 = Date.now();
  const timer = setInterval(() => {
    const m = safe(() => app.getEventMessage(), 'getEventMessage');
    if (m && m !== -100) events.push({ t: Date.now() - t0, m });
    if (Date.now() - t0 > 15000) {
      clearInterval(timer);
      fs.writeFileSync(path.join(OUT, 'events.jsonl'),
        events.map(e => JSON.stringify(e)).join('\n'));
      safe(() => app.stop(), 'stop');
      process.exit(0);
    }
  }, 100);
}
