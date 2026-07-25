'use strict';
// The $zcall engine (Linux) — implements MainApp() that the app's renderer JS call-controller uses.
// Drives the proven OUTGOING flow via onCallSignal; media via MediaSession + ZAudio. Runs in the
// preload/renderer (Node access). Own account / own phone only.
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');

function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }

// Engine trace. Always to console.error; the persistent ~/zalo-engine.log append (preload console
// isn't always visible) only when ZALO_CALL_DEBUG is set — opt-in debugging, off in shipping builds.
let LOGF = null;
function zlog() {
  const msg = '[ZENGINE ' + new Date().toISOString() + '] ' + Array.from(arguments).join(' ');
  try { console.error(msg); } catch (_) {}
  if (!process.env.ZALO_CALL_DEBUG) return;
  try {
    if (LOGF === null) LOGF = require('path').join(require('os').homedir(), 'zalo-engine.log');
    require('fs').appendFileSync(LOGF, msg + '\n');
  } catch (_) {}
}

function createEngine(deps = {}) {
  const getMediaSession = () => deps.MediaSession || require('../zcall-media/media-session.js').MediaSession;
  const getZAudio = () => deps.ZAudio || require('../zcall-media/zaudio.js').ZAudio;
  const os = deps.os || require('os');
  const randomCallId = deps.randomCallId || (() => Math.floor(Math.random() * 1e9));

  let signalCb = null, callbackCb = null, updateCb = null;
  const calls = new Map();   // callId(str) -> { session, audio, calleeId, toId }

  async function startOutgoing(calleeId, type) {
    const MediaSession = getMediaSession();
    const ZAudio = getZAudio();
    const callId = randomCallId();
    zlog('startOutgoing calleeId', calleeId, 'callId', callId, 'signalCb?', !!signalCb);
    if (!signalCb) { zlog('ERROR no onCallSignal registered'); return; }
    let config;
    try {
      const raw = await signalCb(401, { calleeId: String(calleeId), callId, codec: '[]', type: type || 1 });
      zlog('401 returned type', typeof raw, 'hasSessId', !!(raw && (raw.sessId || (typeof raw === 'string' && raw.includes('sessId')))));
      config = parseConfig(typeof raw === 'string' ? raw : JSON.stringify(raw));
      zlog('config OK sessIdLen', config.sessId.length, 'servers', config.servers.length, 'rtpIP', config.rtpIP);
    } catch (e) { zlog('ERROR 401/config:', String(e && e.message || e)); if (updateCb) updateCb({ callId, state: 'error', error: String(e && e.message || e) }); return; }

    const key = srtpMasterKey(config.sessId);
    const session = new MediaSession({ key, ssrc: config.fromId });
    const selHost = config.rtpIP ? parseAddr(config.rtpIP).host : null;
    const servers = config.servers.slice();
    if (config.rtpIP) servers.push({ rtpaddr: config.rtpIP });
    const opened = await session.open({ servers, fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, preferHost: selHost });
    zlog('open() ->', opened ? ('relay ' + opened.host + ' flowToken ' + (opened.flowToken && opened.flowToken.toString('hex'))) : 'NULL');
    if (!opened) { if (updateCb) updateCb({ callId, state: 'error', error: 'no-relay' }); return; }

    const sport = session.sock.address().port;
    const p2p = [];
    const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });

    zlog('sending 416 request (ring) to relay', opened.host);
    await signalCb(416, { calleeId: String(calleeId), rtcpAddress: opened.host + ':4200', rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(extendData), session: config.sessId, callId });
    zlog('416 sent — phone should ring');

    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    session.on('media', (m) => { try { audio.play(m.payload); } catch (_) {} });
    audio.start((opus) => { try { session.send(opus); } catch (_) {} });

    calls.set(String(callId), { session, audio, calleeId: String(calleeId), toId: config.toId });
    if (updateCb) updateCb({ callId, state: 'ringing' });
  }

  async function onAnswer(callId, _params) {
    const c = calls.get(String(callId));
    if (!c) return;
    try { await signalCb(408, { calleeId: c.calleeId, callId: Number(callId) }); } catch (_) {}
    if (updateCb) updateCb({ callId, state: 'connected' });
  }

  function teardown(callId) {
    const c = calls.get(String(callId));
    if (!c) return;
    try { c.audio.stop(); } catch (_) {}
    try { c.session.close(); } catch (_) {}
    calls.delete(String(callId));
    if (updateCb) updateCb({ callId, state: 'ended' });
  }

  zlog('createEngine()');
  return {
    test: (x) => x,
    initCall: (_config) => { zlog('initCall'); },
    onCallSignal: (cb) => { zlog('onCallSignal registered'); signalCb = cb; },
    onCallCallback: (cb) => { zlog('onCallCallback registered'); callbackCb = cb; },
    onCallUpdate: (cb) => { zlog('onCallUpdate registered'); updateCb = cb; },
    onCallRequest: (_cb) => {},          // 4b (incoming)
    onCallResponseDevices: (_cb) => {},
    removeListenCallDevices: () => {},
    getEventMessage: () => null,
    getListDevices: () => '[]',
    getCallInfo: () => '{}', getExtendData: () => '{}', getActiveAudioCodecs: () => '{}', getJsonStats406: () => '{}',
    getVideoFrame: () => null, getVideoFrameLocal: () => null,
    sendDataToNative: (msg) => {
      let m; try { m = typeof msg === 'string' ? JSON.parse(msg) : msg; } catch (e) { zlog('sendDataToNative parse err', String(e)); return; }
      if (!m) return;
      zlog('sendDataToNative type', m.type, 'command', m.command, 'act', m.data && m.data.act);
      if (m.type === 'request' && m.command === 'makeCall') {
        const p = m.data && m.data.partner && m.data.partner[0];
        if (p) startOutgoing(p.id, m.data.type).catch((e) => zlog('startOutgoing threw', String(e && e.message || e)));
      } else if (m.type === 'control' && m.data && m.data.act) {
        const d = m.data.data || {};
        if (m.data.act === 'answer') onAnswer(d.callId, d.params).catch((e) => zlog('onAnswer threw', String(e)));
        else if (m.data.act === 'end_call') teardown(d.callId);
      }
    },
  };
}

let SINGLETON = null;
function MainApp() { if (!SINGLETON) SINGLETON = createEngine(); return SINGLETON; }

module.exports = { MainApp, createEngine };
