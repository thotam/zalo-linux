'use strict';
// Operator-run live CONNECTED call on Linux (own account / own phone). Full flow:
//   requestCall -> ring (sendRequestCall, phone rings) -> read the callee's ANSWER from the diag
//   log (server pushes it via JS polling -> _sendToNative -> ~/zalo-call-diag.log) -> InitZRTP +
//   media to the answer's rtpSerIp keyed with the answer's sessId -> answerAck -> receive/decrypt
//   the peer's real media -> endCall.
// Payload sent is synthetic (opus = step 3). Own traffic only. Redacted output.
const os = require('os');
const path = require('path');
const { invokeRequestCall } = require('../zcall-signaling/cdp-invoke.js');
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { ring, endCall, answerAck, buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');
const { readAnswer, findCallEvents } = require('../zcall-signaling/read-answer.js');
const { MediaSession } = require('./media-session.js');

function flag(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }
function maskHost(a) { return a ? (String(a.host || a.ip).replace(/[0-9A-Za-z]/g, '*') + ':' + (a.port || '')) : '-'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollAnswer(logPath, callId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    const a = readAnswer(logPath, callId);
    if (a && a.rtpSerIp) { seen = a; if (String(a.status) === '3') return a; }  // wait for answered (status 3)
    await sleep(500);
  }
  return seen;
}

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-media/live-call.js <calleeId> [--wait 30000] [--talk 15000]');
  const waitMs = Number(flag('--wait', '30000'));   // time to wait for you to answer
  const talkMs = Number(flag('--talk', '15000'));   // time to stream after answer
  const logPath = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');

  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));

  // Media keyed with the call's sessId (shared by both ends per GO verdict). Open the media socket
  // + InitZRTP to the server-selected relay (config.rtpIP) FIRST so we have the relay + its
  // flowToken before ringing.
  const key = srtpMasterKey(config.sessId);
  const s = new MediaSession({ key, ssrc: config.fromId });
  let inOk = 0, inFail = 0, seenFlow = null;
  const rawIn = [];
  s.on('media', (m) => { inOk++; if (!seenFlow) seenFlow = m.flowToken; });
  s.on('authfail', () => { inFail++; });
  s.on('wire', (m) => { if (rawIn.length < 20) rawIn.push(Buffer.from(m)); });

  const selHost = config.rtpIP ? parseAddr(config.rtpIP).host : null;
  const servers = config.servers.slice();
  if (config.rtpIP) servers.push({ rtpaddr: config.rtpIP });
  const opened = await s.open({ servers, fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, preferHost: selHost });
  if (!opened) { console.error('[live-call] no relay replied to InitZRTP'); process.exit(1); }
  console.log('[live-call][diag] mediaRelay ' + maskHost(s.relay) + '  flowToken ' + (opened.flowToken && opened.flowToken.toString('hex') !== '00000000' ? 'set' : '<NONE>') + '  relaysProbed ' + opened.results.length);

  // Build request.extendData from the InitZRTP probe results (§I): serverResult (each replying relay
  // + recv/rtt), serverAddr (selected), p2p (local candidates on our media source port). This is
  // what makes the server build the relay bridge and push status→3.
  const sport = s.sock.address().port;
  const p2p = [];
  const nets = os.networkInterfaces();
  for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
  const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });
  const rtpAddress = opened.host + ':4200';

  // Ring the callee's phone WITH the real connect payload (selected relay + opus codec + extendData).
  let rang = '?';
  try { await ring({ calleeId, callId, config, rtpAddress, codec: OPUS_CODEC, extendData }); rang = 'ok'; }
  catch (e) { rang = 'err:' + e.message; }
  console.log('[live-call] rang ' + rang + ' (callId ' + callId + ') — ANSWER on your phone…');

  // Stream media IMMEDIATELY during ringing (Windows caller starts ~0.4s in, before answer). This
  // presence of caller media is likely what lets the call complete to connected.
  const filler = Buffer.alloc(80, 0);
  const timer = setInterval(() => { try { s.send(filler); } catch (_) {} }, 20);

  // Poll for the answer; answerAck as soon as we see any answer (don't wait for status 3).
  let ackSent = false; let ans = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const a = readAnswer(logPath, callId);
    if (a && a.rtpSerIp) {
      ans = a;
      if (!ackSent) { try { await answerAck({ calleeId, callId }); } catch (_) {} ackSent = true; console.log('[live-call] answer seen (status ' + a.status + ') -> answerAck sent'); }
      if (String(a.status) === '3' || inOk > 0) break;   // connected or media flowing
    }
    await sleep(500);
  }

  // Keep streaming a bit after answer/media.
  await sleep(talkMs);
  clearInterval(timer);
  s.close();
  try { await endCall({ uidTo: config.toId, callId }); } catch (_) {}

  // Diagnostic: if libsrtp rejected inbound, try the proven pure-Node decrypter on the raw bytes.
  if (inOk === 0 && rawIn.length) {
    try {
      const { run } = require('./decrypt-capture.js');
      const hex = rawIn.map((b) => b.toString('hex'));
      for (const [label, sid] of [['answer', ans && ans.sessId], ['requestcall', config.sessId]]) {
        if (!sid) continue;
        const res = run(sid, hex); const ok = res.filter((r) => r.authOk); const s0 = ok[0];
        console.log('[live-call][diag] decrypt(' + label + '): ' + ok.length + '/' + res.length + ' authOk' +
          (s0 ? ' (zrtcPrefix=' + s0.zrtcPrefix + ' tagLen=' + s0.tagLen + ' pt=' + s0.pt + ')' : ''));
      }
    } catch (e) { console.log('[live-call][diag] decrypt failed: ' + e.message); }
    console.log('[live-call][diag] first inbound head8=' + rawIn[0].subarray(0, 8).toString('hex') + ' len=' + rawIn[0].length);
  }

  // Full control-event sequence for this callId (what the server pushed during the call).
  try {
    const fs = require('fs');
    const evs = findCallEvents(fs.readFileSync(logPath, 'utf8'), callId);
    console.log('[live-call][seq] ' + (evs.length ? evs.map((e) => e.act + '(st' + e.status + (e.hasSessId ? ',sess' : '') + ')').join(' -> ') : 'no events'));
  } catch (_) {}

  console.log('[live-call] mediaPkts ' + rawIn.length + '  relayRespEchoes ' + s.rxResp);
  console.log('[live-call] inboundAuthOk ' + inOk + '  authfail ' + inFail);
  console.error('[live-call] ' + (inOk ? 'OK — decrypted peer real media on Linux 🎉' : 'no media decrypted (mediaPkts ' + rawIn.length + ')'));
  process.exit(inOk ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('[live-call] FAILED:', e.message); process.exit(1); });
module.exports = { main, pollAnswer };
