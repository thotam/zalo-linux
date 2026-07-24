'use strict';
// Operator-run full-duplex audio call on Linux (own account / own phone). Same connect flow as
// live-call.js, but the mic drives outbound opus and inbound opus plays to the speaker.
// Use headphones to avoid echo.
const os = require('os');
const path = require('path');
const { invokeRequestCall } = require('../zcall-signaling/cdp-invoke.js');
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { ring, endCall, answerAck, buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');
const { readAnswer } = require('../zcall-signaling/read-answer.js');
const { MediaSession } = require('./media-session.js');
const { ZAudio } = require('./zaudio.js');

function flag(n, d) { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-media/live-audio.js <calleeId> [--talk 30000]');
  const talkMs = Number(flag('--talk', '30000'));
  const micGain = Number(flag('--gain', '2'));   // mild boost — phone-side was a bit quiet at 1x
  const logPath = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');

  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));
  const key = srtpMasterKey(config.sessId);

  const s = new MediaSession({ key, ssrc: config.fromId });
  const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain });
  const diag = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20 }); // separate decoder for RMS
  let inOk = 0, dec = 0, decFail = 0, sumRms = 0, logged = 0, prevTs = null;
  s.on('media', (m) => {
    inOk++;
    let pcm = null;
    try { pcm = diag.decodeFrame(m.payload); dec++; } catch (_) { decFail++; }
    if (pcm) {
      let e = 0; const n = pcm.length / 2;
      for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); e += v * v; }
      const rms = Math.sqrt(e / n); sumRms += rms;
      const dts = prevTs == null ? 0 : (m.rtp.timestamp - prevTs) >>> 0; prevTs = m.rtp.timestamp;
      if (logged < 15) { logged++; console.log('[in] pt=' + m.rtp.pt + ' plLen=' + m.payload.length + ' tsDelta=' + dts + ' decRMS=' + rms.toFixed(0)); }
    }
    try { audio.play(m.payload); } catch (_) {}   // inbound opus -> speaker
  });

  const selHost = config.rtpIP ? parseAddr(config.rtpIP).host : null;
  const servers = config.servers.slice();
  if (config.rtpIP) servers.push({ rtpaddr: config.rtpIP });
  const opened = await s.open({ servers, fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, preferHost: selHost });
  if (!opened) throw new Error('no relay replied to InitZRTP');

  // MediaSession auto-retargets outbound to the actively-bridging relay (where the phone's media
  // arrives from). Just log it.
  const maskH = (h) => String(h).replace(/[0-9A-Za-z]/g, '*');
  s.on('retarget', (host) => console.log('[live-audio] outbound retargeted -> bridging relay ' + maskH(host)));

  const sport = s.sock.address().port;
  const p2p = [];
  const nets = os.networkInterfaces();
  for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
  const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });

  await ring({ calleeId, callId, config, rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData });
  console.log('[live-audio] ringing — ANSWER on your phone and talk (headphones recommended)…');

  // Mic -> opus -> outbound media (replaces the silent filler).
  let outN = 0, outVoiced = 0, outLogged = 0;
  audio.start((opus) => {
    outN++;
    if (opus.length > 20) outVoiced++;   // >20B ≈ real speech; ~8B = DTX/silence
    if (outLogged < 15) { outLogged++; console.log('[out] opusLen=' + opus.length); }
    try { s.send(opus); } catch (_) {}
  });

  // answerAck on the first answer event for this call.
  let ackSent = false;
  const poll = setInterval(async () => {
    const a = readAnswer(logPath, callId);
    if (a && a.rtpSerIp && !ackSent) { ackSent = true; try { await answerAck({ calleeId, callId }); } catch (_) {} console.log('[live-audio] answer (status ' + a.status + ') -> answerAck'); }
  }, 500);

  await sleep(talkMs);

  clearInterval(poll);
  audio.stop();
  s.close();
  try { await endCall({ uidTo: config.toId, callId }); } catch (_) {}
  console.log('[live-audio] done — inbound frames ' + inOk + '  decoded ' + dec + ' (fail ' + decFail + ')  avgRMS ' + (dec ? (sumRms / dec).toFixed(0) : 0));
  console.log('[live-audio] outbound frames ' + outN + '  voiced(>20B) ' + outVoiced + '  sendTo ' + maskH(s.relay && s.relay.host));
  process.exit(inOk ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('[live-audio] FAILED:', e.message); process.exit(1); });
module.exports = { main };
