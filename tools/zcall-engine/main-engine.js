'use strict';
// Main-process $zcall engine (Linux) — replaces the absent child-process native engine. Event-driven
// over the app's IPC signaling loop: receives S(t) (makeCall / recvSignal config / control) and emits
// {type:'sendSignal',command,data} the render executes as HTTP signals. Media via MediaSession+ZAudio.
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');

function zlog() {
  const msg = '[ZENGINE ' + new Date().toISOString() + '] ' + Array.from(arguments).join(' ');
  try { console.error(msg); } catch (_) {}
  try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'zalo-engine.log'), msg + '\n'); } catch (_) {}
}
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }

function createMainEngine(opts) {
  opts = opts || {};
  const sendToRender = opts.sendToRender || (() => {});
  const getMediaSession = () => opts.MediaSession || require('../zcall-media/media-session.js').MediaSession;
  const getZAudio = () => opts.ZAudio || require('../zcall-media/zaudio.js').ZAudio;
  const os = opts.os || require('os');
  const randomCallId = opts.randomCallId || (() => Math.floor(Math.random() * 1e9));
  const calls = new Map();   // callId(str) -> { callId, calleeId, session, audio, config }
  let current = null;        // the outgoing call awaiting its 401 config

  const emit = (type, command, data) => { try { sendToRender({ type, command, data }); } catch (e) { zlog('emit err', e && e.message); } };

  function startOutgoing(calleeId, type) {
    const callId = randomCallId();
    current = { callId, calleeId: String(calleeId), type: type || 1 };
    calls.set(String(callId), current);
    zlog('makeCall', calleeId, '-> 401', callId);
    emit('sendSignal', 401, { calleeId: String(calleeId), callId, codec: '[]', type: type || 1 });
  }

  async function onConfig(config) {
    const c = current;
    if (!c) { zlog('config with no pending call'); return; }
    let cfg;
    try { cfg = parseConfig(typeof config === 'string' ? config : JSON.stringify(config)); }
    catch (e) { zlog('config parse err', e && e.message); return; }
    const callId = c.callId;
    const MediaSession = getMediaSession(); const ZAudio = getZAudio();
    const key = srtpMasterKey(cfg.sessId);
    const session = new MediaSession({ key, ssrc: cfg.fromId });
    const selHost = cfg.rtpIP ? parseAddr(cfg.rtpIP).host : null;
    const servers = cfg.servers.slice(); if (cfg.rtpIP) servers.push({ rtpaddr: cfg.rtpIP });
    const opened = await session.open({ servers, fromId: cfg.fromId, toId: cfg.toId, callId, sessId: cfg.sessId, preferHost: selHost });
    if (!opened) { zlog('no relay replied'); emit('update', 'callState', { state: 'free', callId }); return; }
    const sport = session.sock.address().port;
    const p2p = []; const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    const extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });
    c.session = session; c.config = cfg;
    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    c.audio = audio;
    let inCount = 0, outCount = 0;
    session.on('media', (m) => { inCount++; try { audio.play(m.payload); } catch (e) { zlog('play err', e && e.message); } });
    session.on('retarget', (h) => zlog('outbound retarget ->', h));
    session.on('authfail', () => { c._authfail = (c._authfail || 0) + 1; });
    c._iv = setInterval(() => zlog('media in', inCount, 'out', outCount, 'authfail', c._authfail || 0, 'relay', session.relay && session.relay.host), 3000);
    c._outTick = () => { outCount++; };
    zlog('open OK relay', opened.host, '-> 416 (ring)');
    emit('sendSignal', 416, { calleeId: c.calleeId, rtcpAddress: opened.host + ':4200', rtpAddress: opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(extendData), session: cfg.sessId, callId });
    emit('update', 'callState', { state: 'calling', callId });
    audio.start((opus) => { if (c._outTick) c._outTick(); try { session.send(opus); } catch (_) {} });   // stream during ringing
  }

  function onAnswer(callId) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    zlog('answer', callId, '-> 408');
    emit('sendSignal', 408, { calleeId: c.calleeId, callId: Number(c.callId) });
    emit('update', 'callState', { state: 'connected', callId: c.callId });
  }

  function teardown(callId) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    try { if (c._iv) clearInterval(c._iv); } catch (_) {}
    try { c.audio && c.audio.stop(); } catch (_) {}
    try { c.session && c.session.close(); } catch (_) {}
    calls.delete(String(c.callId));
    if (current && String(current.callId) === String(c.callId)) current = null;
    emit('update', 'callState', { state: 'free', callId: c.callId });
  }

  function handleSendToNative(t) {
    let m; try { m = typeof t === 'string' ? JSON.parse(t) : t; } catch (_) { return; }
    if (!m) return;
    zlog('S<-', m.type, m.command, m.data && m.data.act);
    if (m.type === 'request' && m.command === 'makeCall') {
      const p = m.data && m.data.partner && m.data.partner[0];
      if (p && !current) startOutgoing(p.id, m.data.type);   // one outgoing at a time (makeCall repeats)
    } else if (m.type === 'recvSignal' && Number(m.command) === 401) {
      onConfig(m.data).catch((e) => zlog('onConfig err', e && e.message));
    } else if (m.type === 'control' && m.data && m.data.act) {
      const d = m.data.data || {};
      if (m.data.act === 'answer') onAnswer(d.callId);
      else if (m.data.act === 'end_call') teardown(d.callId);
    } else if (m.type === 'request' && m.command === 'endCall') {
      teardown(m.data && m.data.callId);
    }
  }

  return { handleSendToNative, start() {}, stop() { if (current) teardown(current.callId); } };
}

module.exports = { createMainEngine };
