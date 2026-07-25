'use strict';
// Main-process $zcall engine (Linux) — replaces the absent child-process native engine. Event-driven
// over the app's IPC signaling loop: receives S(t) (makeCall / recvSignal config / control) and emits
// {type:'sendSignal',command,data} the render executes as HTTP signals. Media via MediaSession+ZAudio.
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { buildExtendData, OPUS_CODEC } = require('../zcall-signaling/call-control.js');

// Engine trace. Always to console.error (ephemeral); the persistent ~/zalo-engine.log append
// only when ZALO_CALL_DEBUG is set (opt-in for live-call debugging, off in shipping builds).
function zlog() {
  const msg = '[ZENGINE ' + new Date().toISOString() + '] ' + Array.from(arguments).join(' ');
  try { console.error(msg); } catch (_) {}
  if (!process.env.ZALO_CALL_DEBUG) return;
  try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'zalo-engine.log'), msg + '\n'); } catch (_) {}
}
function parseAddr(s) { const m = String(s).split(/[:|]/); return { host: m[0], port: Number(m[1]) || 4200 }; }

// `control answer` non-zero status -> chat call-log reason. Status meanings RE'd from the native
// engine (ZaloCall.exe, zcallinfosignal.cpp caller answer-handler): 1=busy, 3=reject, 5=zrtp-fail,
// 6=timeout/no-answer, 0=accept. Reason enum (render): 1=CALLEE_BUSY "Người nhận bận",
// 3=CALLEE_REJECT "Người nhận từ chối", 2=generic ("Cuộc gọi thoại đi 0 giây"). Unknown -> generic.
const ANSWER_STATUS_REASON = { 1: 1, 3: 3, 5: 2, 6: 2 };
// End-tone outcome fed to sounds.apply('ended', outcome) — matches ZaloCall.exe's sound set (RE'd):
// status 1 = receiver busy -> busy.mp3 (onReceiverBusy). All other ends -> endcall.mp3 (default).
// disconnect.mp3 is the partnerDisconnect (mid-call media drop) tone, which we don't detect, so we
// never emit 'disconnect'.
const ANSWER_STATUS_OUTCOME = { 1: 'busy' };

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

  // Role-agnostic media bring-up: open a relay, wire MediaSession + ZAudio + UI devices, start mic.
  // Populates c.session / c.audio / c.extendData / c.opened. Returns false (and emits callState free)
  // if no relay replied. Caller and callee (acceptIncoming) both call this; it does NOT emit 416 or
  // set the 'calling'/'connected' state — that stays with the role-specific caller.
  async function setupMedia(c, cfg) {
    const callId = c.callId;
    const MediaSession = getMediaSession(); const ZAudio = getZAudio();
    const key = srtpMasterKey(cfg.sessId);
    const session = new MediaSession({ key, ssrc: c.selfId != null ? c.selfId : cfg.fromId });
    const selHost = cfg.rtpIP ? parseAddr(cfg.rtpIP).host : null;
    const servers = cfg.servers.slice(); if (cfg.rtpIP) servers.push({ rtpaddr: cfg.rtpIP });
    const _fromId = (c.selfId != null ? c.selfId : cfg.fromId), _toId = (c.peerId != null ? c.peerId : cfg.toId);
    const opened = await session.open({ servers, fromId: _fromId, toId: _toId, callId, sessId: cfg.sessId, preferHost: selHost, isCallee: !!c.incoming });
    if (!opened) { zlog('no relay replied'); emit('update', 'callState', { state: 'free', callId }); return false; }
    const sport = session.sock.address().port;
    const p2p = []; const nets = os.networkInterfaces();
    for (const nm of Object.keys(nets)) for (const ni of nets[nm]) if (ni.family === 'IPv4' && !ni.internal) p2p.push({ ip: ni.address, port: sport, type: 0 });
    c.extendData = buildExtendData({ results: opened.results, selectedHost: opened.host, p2p });
    c.opened = opened; c.session = session; c.config = cfg;
    const audio = new ZAudio({ sampleRate: 16000, channels: 1, frameMs: 20, micGain: 2 });
    c.audio = audio;
    let inCount = 0, outCount = 0;
    // speakerMuted mirrors ZaloCall.exe's muteSpeaker() (speaker button = output/playout mute, RE'd):
    // media still arrives (inCount++) but we don't play it out -> no sound from the speaker.
    session.on('media', (m) => { inCount++; if (c.speakerMuted) return; try { audio.play(m.payload); } catch (e) { zlog('play err', e && e.message); } });
    session.on('retarget', (h) => zlog('retarget ->', h));
    session.on('authfail', () => { c._authfail = (c._authfail || 0) + 1; });
    c._iv = setInterval(() => zlog('media in', inCount, 'out', outCount, 'authfail', c._authfail || 0, 'relay', session.relay && session.relay.host), 3000);
    c._outTick = () => { outCount++; };
    uiSafe(() => {
      let devs = { capture: [], playback: [] };
      try { devs = audio.listDevices(); } catch (e) { zlog('listDevices err', e && e.message); }
      ui.setDevices(Object.assign({ selectedIn: -1, selectedOut: -1 }, devs));
    });
    audio.start((opus) => { if (c._outTick) c._outTick(); try { session.send(opus); } catch (_) {} });
    return true;
  }

  async function onConfig(config) {
    const c = current;
    if (!c) { zlog('config with no pending call'); return; }
    let cfg;
    try { cfg = parseConfig(typeof config === 'string' ? config : JSON.stringify(config)); }
    catch (e) { zlog('config parse err', e && e.message); return; }
    const ok = await setupMedia(c, cfg);
    if (!ok) return;
    zlog('open OK relay', c.opened.host, '-> 416 (ring)');
    emit('sendSignal', 416, { calleeId: c.calleeId, rtcpAddress: c.opened.host + ':4200', rtpAddress: c.opened.host + ':4200', codec: OPUS_CODEC, extendData: JSON.stringify(c.extendData), session: cfg.sessId, callId: c.callId });
    // Native bounds ring time; the app-button call path has no such bound, so the caller would
    // otherwise ring forever if the callee never answers/rejects. Mirror the native timeout: cancel
    // (405) + tear down as a generic missed call (reason 2) once ringTimeoutMs elapses unanswered.
    const rt = typeof opts.ringTimeoutMs === 'number' ? opts.ringTimeoutMs : 60000;
    c._ringTimer = setTimeout(() => {
      if (!c.answered) { zlog('ring timeout -> 405 cancel'); emit('sendSignal', 405, { toId: c.calleeId, callId: Number(c.callId), callType: c.type || 1 }); teardown(c.callId, 2); }
    }, rt);
    emit('update', 'callState', { state: 'calling', callId: c.callId });
    uiSafe(() => {
      ui.show(c.partner);
      ui.setState('calling', { name: c.partner.name });
    });
  }

  function markConnected(c) {
    if (!c || c.connectedAt) return;
    c.connectedAt = Date.now();
    if (c._connTimer) { try { clearTimeout(c._connTimer); } catch (_) {} c._connTimer = null; }
    emit('update', 'callState', { state: 'connected', callId: c.callId });
    // secure:true — media is SRTP-encrypted end-to-end, so the timer shows the encrypted (green) state.
    uiSafe(() => ui.setState('connected', { connectedAt: c.connectedAt, name: c.partner && c.partner.name, secure: true }));
  }

  function onAnswer(callId, data) {
    const c = calls.get(String(callId)) || current;
    if (!c) return;
    // Duplicate `control answer status:0` for an already-connected call is a no-op — ZaloCall.exe's
    // call-state machine only accepts `answer` from the ringing state (RE'd). Ignoring it here avoids
    // re-emitting 408 and orphaning c._connTimer / adding a stray media path on the repeat.
    if (c.answered) { zlog('duplicate answer ignored (already connected)'); return; }
    try { if (c._ringTimer) { clearTimeout(c._ringTimer); c._ringTimer = null; } } catch (_) {}
    zlog('answer', callId, 'status=', data && data.status, '-> 408 + connected');
    c.answered = true;
    emit('sendSignal', 408, { calleeId: c.calleeId, callId: Number(c.callId) });
    // The caller's answer means "picked up" -> count the duration immediately (matches the app: no
    // post-answer 'connecting' pause; connecting.mp3 is the pre-ring dialing tone, not a post-answer one).
    markConnected(c);
  }

  // reason: only meaningful when the call was NOT answered — 4 = we cancelled (default),
  // 3 = callee rejected/ended while ringing. Answered calls ignore it (rendered as a normal call).
  function teardown(callId, reason, outcome) {
    const c = calls.get(String(callId)) || current;
    if (!c) { zlog('teardown noop (no call)', callId); return; }
    const answered = !!c.answered;
    zlog('teardown', c.callId, 'answered=', answered, 'reason=', reason);
    try { if (c._iv) clearInterval(c._iv); } catch (_) {}
    try { if (c._connTimer) clearTimeout(c._connTimer); } catch (_) {}
    try { if (c._ringTimer) { clearTimeout(c._ringTimer); c._ringTimer = null; } } catch (_) {}
    try { if (c._ackTimer) { clearTimeout(c._ackTimer); c._ackTimer = null; } } catch (_) {}
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
    // Call-log bubble is OUTGOING-only. The app already logs INCOMING calls natively (server-synced
    // chat message, as it did before we added incoming support), so emitting an engine bubble for an
    // incoming call double-logs it (live-observed: a "từ chối" + a "bị nhỡ" for one decline). For
    // outgoing, the render derives the label from action + params.reason (title/desc are dead): role=1
    // (caller), calltype 0=audio, missed=!answered, reason (4 cancel / 3 reject) for missed calls;
    // answered -> reason 0 + real duration. partnerId MUST be the callee's real UID; duration seconds.
    // Outgoing: always log (the app doesn't natively log outgoing calls). Incoming: log ONLY an
    // ANSWERED call — the server syncs missed/declined incoming logs itself (an engine bubble for
    // those double-logs them, e.g. "từ chối" + "bị nhỡ"), but it does NOT sync an answered-incoming
    // log, so we add that one (role 0 = incoming, missed=false, real duration).
    if (!c.incoming || answered) {
      const durationSec = answered ? (c.connectedAt ? Math.max(0, (Date.now() - c.connectedAt) / 1000) : 0) : 0;
      const outReason = answered ? 0 : (reason != null ? reason : 4);
      const role = c.incoming ? 0 : 1;
      emit('update', 'bubble', { role: role, duration: durationSec, partnerId: c.calleeId, reason: outReason, missed: !answered, calltype: 0 });
    }
    uiSafe(() => { try { ui.closeIncoming && ui.closeIncoming(); } catch (_) {} ui.setState('ended', { name: c.partner && c.partner.name, outcome: outcome }); setTimeout(() => uiSafe(() => ui.close()), uiCloseDelay); });
  }

  // Reshape an incoming `control request` payload (`ctrl.data`, live-RE'd) into the {sessId, servers,
  // rtpIP, fromId, toId} form setupMedia/srtpMasterKey expect. The incoming config differs from the
  // caller's requestcall reply: the SRTP session token is `d.session` (mirrored in d.params.sessId),
  // OUR uid is `d.uidTo` and the caller is `d.uidN`, and the relay candidates live in
  // d.params.extendData.serverResult with `d.rtpAddress` the caller's selected bridging relay (put it
  // first so setupMedia's preferHost picks the same relay the caller uses -> the relay bridges us).
  function parseIncomingConfig(d) {
    let params = {}; try { params = JSON.parse(d.params || '{}'); } catch (_) {}
    let ext = {}; try { ext = JSON.parse(params.extendData || '{}'); } catch (_) {}
    const sessId = d.session || params.sessId;
    const addr = d.rtpAddress || params.rtpIP;
    const servers = []; const seen = {};
    if (addr) { servers.push({ rtpaddr: addr }); seen[addr] = 1; }
    (ext.serverResult || ext.serverAddr || []).forEach((s) => {
      if (s && s.rtp && !seen[s.rtp]) { servers.push({ rtpaddr: s.rtp, rtcpaddr: s.rtcp }); seen[s.rtp] = 1; }
    });
    // fromId = our uid (uidTo); toId = the caller's REAL uid (uidFrom) — NOT uidN (see startIncoming).
    return { sessId, servers, rtpIP: addr, fromId: d.uidTo, toId: (d.uidFrom != null ? d.uidFrom : d.uidN) };
  }

  // Incoming call: `control request` from the render (RE'd: caller/call params in ctrl.data, caller
  // display name/avatar in ctrl._caller). Busy (already `current`, or the render reports
  // inCallStatus:'zalo') -> auto-decline with 402 status 1 (busy), no UI. Otherwise ring: 407 ack +
  // ringing-incoming state + ui.showIncoming so the render can show the incoming-call UI/ringtone.
  function startIncoming(ctrl) {
    const d = (ctrl && ctrl.data) || {};
    const callId = d.callId;
    // The caller has TWO ids and they are NOT interchangeable (live-verified):
    //  - SIGNALING/ROUTING id = `uidN` (the huge normalized id the server routes call-signals by —
    //    the same id our outgoing makeCall used). 407 ring + 402 answer/decline callerId MUST be this,
    //    else the caller's phone stays stuck on "connecting" (our ring/answer never reaches it).
    //  - MEDIA/ACCOUNT uid = `uidFrom` (small, fits a LE uint32). The InitZRTP toId MUST be this, else
    //    the relay rejects our registration. (Caller display name/avatar come from ctrl._caller.)
    const routeId = String(d.uidN != null ? d.uidN : (d.uidFrom != null ? d.uidFrom : d.fromId));
    const mediaId = String(d.uidFrom != null ? d.uidFrom : d.uidN);
    if (ctrl.inCallStatus === 'zalo') { zlog('incoming busy -> 402 status 1'); emit('sendSignal', 402, { callerId: routeId, callId, status: 1, session: d.session }); return; }
    if (current) { zlog('incoming while busy(local) -> 402 status 1'); emit('sendSignal', 402, { callerId: routeId, callId, status: 1, session: d.session }); return; }
    const caller = ctrl._caller || {};
    current = { callId, calleeId: routeId, selfId: (d.uidTo != null ? String(d.uidTo) : null), peerId: mediaId,
      type: 1, incoming: true, incomingCfg: d, sessId: d.session, callerRtp: d.rtpAddress || d.rtcpAddress,
      partner: { id: routeId, name: caller.name || routeId, avatar: caller.avatar || null } };
    calls.set(String(callId), current);
    zlog('incoming', routeId, '(media', mediaId, ') callId', callId, '-> 407 ring');
    emit('sendSignal', 407, { callerId: routeId, callId });
    emit('update', 'callState', { state: 'ringing-incoming', callId });
    uiSafe(() => { ui.showIncoming(current.partner); ui.setState('ringing-incoming', { name: current.partner.name }); });
  }

  // User pressed "Trả lời" on the incoming-call UI. Reuse the role-agnostic setupMedia as the callee
  // (c.selfId/c.peerId already set by startIncoming), then answer with 402 status=0 (our own
  // relay/extendData), close the incoming window, open the call window, and go connecting->connected.
  // User pressed "Trả lời". Open callee-side media (InitZRTP the caller-selected relay with the
  // callee subtype 0x0c so the relay accepts our registration and returns a flowToken), then answer
  // with 402 status=0 carrying our relay/extendData. The callee reuses the incoming config's relay +
  // shared sessId (no fresh requestcall — RE'd). Media bridges through the shared relay by callId.
  async function acceptIncoming() {
    const c = current;
    if (!c || !c.incoming) return;
    const cfg = parseIncomingConfig(c.incomingCfg || {});
    if (!cfg.sessId || typeof cfg.sessId !== 'string' || cfg.sessId.length < 30 || !cfg.servers.length) {
      zlog('incoming cfg invalid: sessId', cfg.sessId && cfg.sessId.length, 'servers', cfg.servers.length); return;
    }
    c.answered = true;
    const ok = await setupMedia(c, cfg);
    if (!ok) { zlog('accept: no relay replied -> teardown (not stuck)'); teardown(c.callId, 2); return; }
    const host = c.opened.host;
    zlog('accept incoming -> 402 status 0; relay', host);
    emit('sendSignal', 402, { callerId: c.calleeId, callId: Number(c.callId), status: 0, codec: OPUS_CODEC, extendData: JSON.stringify(c.extendData), rtcpAddress: host + ':4200', rtpAddress: host + ':4200', session: cfg.sessId });
    uiSafe(() => { ui.closeIncoming(); ui.show(c.partner); ui.setState('connecting', { name: c.partner.name }); });
    if (c.session) { try { c.session.on('media', () => markConnected(c)); } catch (_) {} }
    c._connTimer = setTimeout(() => markConnected(c), typeof opts.connectDelayMs === 'number' ? opts.connectDelayMs : 1500);
  }

  // User pressed "Từ chối" on the incoming-call UI. Tell the caller we declined (402 status=3),
  // then tear down (reason 3 -> "Người nhận từ chối"); teardown handles closing the incoming window.
  function declineIncoming() {
    const c = current;
    if (!c || !c.incoming) return;
    // Reject = sendAnswerCall status 3 (RE'd from ZaloCall.exe UiAnswerCallEvent @0x7e44c0 reject branch
    // 0x7e4622: push 3 -> sendAnswerCall). Native reject is SYNCHRONOUS and does NOT populate the media
    // offer — codec/extendData/rtp/rtcp are sent EMPTY (only accept's async path fills them). So send
    // explicit empty strings (not undefined -> avoids "undefined" in the query), callerId/callId/session
    // populated exactly as the accept does (which the caller accepts).
    zlog('decline incoming -> 402 status 3 callerId', c.calleeId, 'callId', c.callId);
    emit('sendSignal', 402, { callerId: c.calleeId, callId: Number(c.callId), status: 3, session: c.sessId, codec: '', extendData: '', rtpAddress: '', rtcpAddress: '' });
    teardown(c.callId, 3);
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
    } else if (m.type === 'recvSignal' && Number(m.command) === 407) {
      // The 407 echoed back on the callee side (our own ring-ack) must NOT flip the incoming window
      // from 'ringing-incoming' (ringtone) to 'ringing' (ringback). Only meaningful for outgoing.
      const c = current;
      if (c && !c.incoming) { zlog('recv 407 ringring -> ringing'); emit('update', 'callState', { state: 'ringing', callId: c.callId }); uiSafe(() => ui.setState('ringing', { name: c.partner && c.partner.name })); }
    } else if (m.type === 'recvSignal' && Number(m.command) === 409) {
      teardown(current && current.callId, 2);   // remote hangup / timeout -> close (answered=normal call)
    } else if (m.type === 'control' && m.data && m.data.act) {
      const d = m.data.data || {};
      zlog('control', m.data.act, 'status=', d.status, 'callId=', d.callId);
      if (m.data.act === 'request') { startIncoming(m.data); return; }
      // Outgoing: the remote phone started ringing arrives as `control ring_ring` (NOT recvSignal 407)
      // -> switch to the 'ringing' state so the caller hears the ringback tone.
      if (m.data.act === 'ring_ring') {
        const c = current;
        if (c && !c.incoming) { zlog('control ring_ring -> ringing'); emit('update', 'callState', { state: 'ringing', callId: c.callId }); uiSafe(() => ui.setState('ringing', { name: c.partner && c.partner.name })); }
        return;
      }
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
          teardown(d.callId, r, ANSWER_STATUS_OUTCOME[st]);   // status 1 (busy) -> busy.mp3; else endcall.mp3
        }
      }
      // remote hangup / no-answer timeout arrive as cancel or end_call (NOT an active reject) ->
      // reason 2 (generic "Cuộc gọi thoại đi"); an answered call ignores reason and shows duration.
      else if (m.data.act === 'end_call' || m.data.act === 'cancel') teardown(d.callId, 2);
      else zlog('control (unhandled act)', m.data.act);   // e.g. mute_audio, ring_ring echoes, answerack
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
    // speaker button = output mute (RE ZaloCall.exe muteSpeaker): gate playback in the media handler.
    ui.on('toggleSpeaker', (v) => { const c = current; if (c) c.speakerMuted = !!v; });
    ui.on('selectInput', (i) => { const c = current; if (c && c.audio) try { c.audio.setInputDevice(i); } catch (e) { zlog('setInput err', e && e.message); } });
    ui.on('selectOutput', (i) => { const c = current; if (c && c.audio) try { c.audio.setOutputDevice(i); } catch (e) { zlog('setOutput err', e && e.message); } });
    ui.on('accept', () => { acceptIncoming().catch((e) => zlog('accept err', e && e.message)); });
    ui.on('decline', () => declineIncoming());
  }

  return { handleSendToNative, start() {}, stop() { if (current) teardown(current.callId); } };
}

module.exports = { createMainEngine };
