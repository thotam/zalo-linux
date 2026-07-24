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

// `control answer` non-zero status -> chat call-log reason. Status meanings RE'd from the native
// engine (ZaloCall.exe, zcallinfosignal.cpp caller answer-handler): 1=busy, 3=reject, 5=zrtp-fail,
// 6=timeout/no-answer, 0=accept. Reason enum (render): 1=CALLEE_BUSY "Người nhận bận",
// 3=CALLEE_REJECT "Người nhận từ chối", 2=generic ("Cuộc gọi thoại đi 0 giây"). Unknown -> generic.
const ANSWER_STATUS_REASON = { 1: 1, 3: 3, 5: 2, 6: 2 };

function createMainEngine(opts) {
  opts = opts || {};
  const sendToRender = opts.sendToRender || (() => {});
  const getMediaSession = () => opts.MediaSession || require('../zcall-media/media-session.js').MediaSession;
  const getZAudio = () => opts.ZAudio || require('../zcall-media/zaudio.js').ZAudio;
  const os = opts.os || require('os');
  const randomCallId = opts.randomCallId || (() => Math.floor(Math.random() * 1e9));
  const ui = opts.ui || null;
  const uiCloseDelay = typeof opts.uiCloseDelay === 'number' ? opts.uiCloseDelay : 1200;
  const uiSafe = (fn) => { if (!ui) return; try { fn(); } catch (e) { zlog('ui err', e && e.message); } };
  const calls = new Map();   // callId(str) -> { callId, calleeId, session, audio, config }
  let current = null;        // the outgoing call awaiting its 401 config

  const emit = (type, command, data) => { try { sendToRender({ type, command, data }); } catch (e) { zlog('emit err', e && e.message); } };

  function startOutgoing(partner, type) {
    const calleeId = partner && partner.id;
    const callId = randomCallId();
    current = { callId, calleeId: String(calleeId), type: type || 1,
                partner: { id: String(calleeId),
                           name: (partner && (partner.name || partner.dName || partner.displayName)) || String(calleeId),
                           avatar: (partner && (partner.avatar || partner.avatarUrl)) || null } };
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
    uiSafe(() => {
      ui.show(c.partner);
      ui.setState('calling', { name: c.partner.name });
      let devs = { capture: [], playback: [] };
      try { devs = audio.listDevices(); } catch (e) { zlog('listDevices err', e && e.message); }
      ui.setDevices(Object.assign({ selectedIn: -1, selectedOut: -1 }, devs));
    });
    audio.start((opus) => { if (c._outTick) c._outTick(); try { session.send(opus); } catch (_) {} });   // stream during ringing
  }

  function onAnswer(callId, data) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    zlog('answer', callId, 'status=', data && data.status, '-> 408');
    c.answered = true;
    c.connectedAt = Date.now();
    emit('sendSignal', 408, { calleeId: c.calleeId, callId: Number(c.callId) });
    emit('update', 'callState', { state: 'connected', callId: c.callId });
    uiSafe(() => ui.setState('connected', { connectedAt: Date.now(), name: c.partner && c.partner.name }));
  }

  // reason: only meaningful when the call was NOT answered — 4 = we cancelled (default),
  // 3 = callee rejected/ended while ringing. Answered calls ignore it (rendered as a normal call).
  function teardown(callId, reason) {
    const c = calls.get(String(callId)) || current;
    if (!c) { zlog('teardown noop (no call)', callId); return; }
    const answered = !!c.answered;
    zlog('teardown', c.callId, 'answered=', answered, 'reason=', reason);
    try { if (c._iv) clearInterval(c._iv); } catch (_) {}
    try { c.audio && c.audio.stop(); } catch (_) {}
    try { c.session && c.session.close(); } catch (_) {}
    calls.delete(String(c.callId));
    if (current && String(current.callId) === String(c.callId)) current = null;
    // Order matters (RE-verified): emit callState 'free' FIRST so callRunning=false, THEN the
    // 'bubble'. The render has NO reactive call-state; the header refreshes only when the
    // conversation changes. The bubble inserts the chat call-log message (via callbackGenerateMessage
    // -> genMessageServer), which re-renders the header AFTER callRunning is already false -> the
    // "in another call" tooltip flips back to normal. Emitting bubble first would re-render while
    // callRunning is still true, leaving the tooltip stale.
    emit('update', 'callState', { state: 'free', callId: c.callId });
    // Outgoing call-log. The render derives the label from action + params.reason (title/desc are
    // dead), so we pass the outcome: role=1 (we are the caller), calltype 0=audio, missed=!answered,
    // reason (4 cancel / 3 reject) for missed calls; answered -> reason 0 + real duration.
    // partnerId MUST be the callee's real UID (used as the conversation id); duration in seconds.
    const durationSec = answered ? (c.connectedAt ? Math.max(0, (Date.now() - c.connectedAt) / 1000) : 0) : 0;
    const outReason = answered ? 0 : (reason != null ? reason : 4);
    emit('update', 'bubble', { role: 1, duration: durationSec, partnerId: c.calleeId, reason: outReason, missed: !answered, calltype: 0 });
    uiSafe(() => { ui.setState('ended', { name: c.partner && c.partner.name }); setTimeout(() => uiSafe(() => ui.close()), uiCloseDelay); });
  }

  function handleSendToNative(t) {
    let m; try { m = typeof t === 'string' ? JSON.parse(t) : t; } catch (_) { return; }
    if (!m) return;
    zlog('S<-', m.type, m.command, m.data && m.data.act);
    if (m.type === 'request' && m.command === 'makeCall') {
      const p = m.data && m.data.partner && m.data.partner[0];
      if (p && !current) startOutgoing(p, m.data.type);   // one outgoing at a time (makeCall repeats)
    } else if (m.type === 'recvSignal' && Number(m.command) === 401) {
      onConfig(m.data).catch((e) => zlog('onConfig err', e && e.message));
    } else if (m.type === 'recvSignal' && Number(m.command) === 409) {
      teardown(current && current.callId, 2);   // remote hangup / timeout -> close (answered=normal call)
    } else if (m.type === 'control' && m.data && m.data.act) {
      const d = m.data.data || {};
      zlog('control', m.data.act, 'status=', d.status, 'callId=', d.callId);
      if (m.data.act === 'answer') {
        // `control answer` carries a status: 0 = callee accepted; non-0 (e.g. 3) = declined/busy/
        // no-answer. Only a real accept -> connect + start timer; anything else -> tear down.
        const st = Number(d.status);
        if (st === 0) onAnswer(d.callId, d);   // callee accepted -> connect + timer
        else {
          // `control answer` non-zero status = the call ended without a talk: map to a call-log reason.
          // 3 = callee actively rejected ("Người nhận từ chối"); 6 = no-answer/timeout (generic
          // "Cuộc gọi thoại đi 0 giây"). Unknown statuses fall back to generic. (Busy TBD.)
          const r = ANSWER_STATUS_REASON[st] != null ? ANSWER_STATUS_REASON[st] : 2;
          zlog('answer non-accept status', st, '-> reason', r);
          teardown(d.callId, r);
        }
      }
      // remote hangup / no-answer timeout arrive as cancel or end_call (NOT an active reject) ->
      // reason 2 (generic "Cuộc gọi thoại đi"); an answered call ignores reason and shows duration.
      else if (m.data.act === 'end_call' || m.data.act === 'cancel') teardown(d.callId, 2);
    } else if (m.type === 'request' && m.command === 'endCall') {
      teardown(m.data && m.data.callId);
    }
  }

  if (ui) {
    ui.on('end', () => {
      const c = current;
      if (c) {
        // Ringing (not yet answered) -> 405 cancel; answered -> 409 endcall. Both read `toId`.
        if (c.answered) emit('sendSignal', 409, { toId: c.calleeId, callId: Number(c.callId) });
        else emit('sendSignal', 405, { toId: c.calleeId, callId: Number(c.callId), callType: c.type || 1 });
      }
      teardown(c && c.callId);
    });
    ui.on('mute', (v) => { const c = current; if (c && c.audio) try { c.audio.setMute(!!v); } catch (e) { zlog('setMute err', e && e.message); } });
    ui.on('selectInput', (i) => { const c = current; if (c && c.audio) try { c.audio.setInputDevice(i); } catch (e) { zlog('setInput err', e && e.message); } });
    ui.on('selectOutput', (i) => { const c = current; if (c && c.audio) try { c.audio.setOutputDevice(i); } catch (e) { zlog('setOutput err', e && e.message); } });
  }

  return { handleSendToNative, start() {}, stop() { if (current) teardown(current.callId); } };
}

module.exports = { createMainEngine };
