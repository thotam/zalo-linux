'use strict';
// Call-control signaling helpers (SP2 2.3): ring the callee (voicecall/request) and end the call
// (voicecall/endcall) by invoking the app's own API methods via CDP. Own phone only.
const { invokeVoiceCall } = require('./cdp-invoke.js');

// The real opus codec the Windows client advertises in request (§I.3).
const OPUS_CODEC = '[{"name":"opus/16000/1","payload":112,"frmPtime":20,"dynamicFptime":0}]';

// Resolve the (rtp, rtcp) media addresses to advertise in sendRequestCall.
function pickAddr(config, relayAddr, source) {
  if (source === 'server0') {
    const s = (config.servers && config.servers[0]) || {};
    return { rtp: s.rtpaddr || '', rtcp: s.rtcpaddr || '' };
  }
  if (source === 'relay') {
    // relay addresses on the wire use "ip:port" (same as config), not the 0x02 reply's "ip|port".
    const a = relayAddr ? (relayAddr.ip + ':' + relayAddr.port) : '';
    return { rtp: a, rtcp: a };
  }
  return { rtp: config.rtpIP || '', rtcp: config.rtcpIP || '' }; // default 'config'
}

// Build request.extendData (§I.3/I.4) — this is what makes the server set up the relay bridge and
// push status→3. It reports the caller's InitZRTP probe results (which relays replied + recv/rtt),
// the selected relay, and local ICE-like candidates.
//   results:      [{ host, recv, rtt }]  — one per relay that replied to the InitZRTP probe
//   selectedHost: the chosen best relay's host
//   p2p:          [{ ip, port, type }]   — local candidates (type 0 = LAN, 1 = public-reflexive)
function buildExtendData({ results, selectedHost, p2p = [], relayPort = 4200 }) {
  const addr = (h) => h + ':' + relayPort;
  return {
    callType: 0, newZrtc: 1, packetMode: 2, platform: 2, srtpMode: 1, spTcp: 1, srtcp: 0,
    supportCallBusy: 1, supportHevcDecode: 1, tpType: 0, maxFT: 60, gccMode: 1, gccAudio: 1,
    p2p: p2p.map((c) => ({ ip: c.ip, port: c.port, type: c.type })),
    serverAddr: selectedHost ? [{ rtp: addr(selectedHost), rtcp: addr(selectedHost), tpType: 0 }] : [],
    serverResult: (results || []).map((r) => ({ rtp: addr(r.host), rtcp: addr(r.host), recv: r.recv, rtt: r.rtt, spTcp: 1, tpType: 0 })),
    video: { codec: [{ name: 'h264', payload: 97 }] },
  };
}

// Positional args for sendRequestCall(calleeId, rtcpAddress, rtpAddress, codec, extendData, session, callId).
// calleeId is the ORIGINAL id passed to requestCall (19-digit global id), not config.toId (9-digit).
// When extendData is a non-empty object/string the app sets subCommand:3 (server builds the bridge).
function buildRingArgs({ calleeId, config, callId, relayAddr, addrSource = 'config', rtpAddress, codec, extendData }) {
  let rtp, rtcp;
  if (rtpAddress) { rtp = rtpAddress; rtcp = rtpAddress; }
  else { const a = pickAddr(config, relayAddr, addrSource); rtp = a.rtp; rtcp = a.rtcp; }
  const codecStr = codec != null ? codec : '[]';
  const extStr = extendData == null ? '' : (typeof extendData === 'string' ? extendData : JSON.stringify(extendData));
  return [String(calleeId != null ? calleeId : config.toId), rtcp, rtp, codecStr, extStr, config.sessId, callId];
}

function ring({ calleeId, callId, config, relayAddr, addrSource = 'config', rtpAddress, codec, extendData, port = 9222 }) {
  return invokeVoiceCall({ port, method: 'sendRequestCall', args: buildRingArgs({ calleeId, config, callId, relayAddr, addrSource, rtpAddress, codec, extendData }) });
}

function endCall({ uidTo, callId, port = 9222 }) {
  return invokeVoiceCall({ port, method: 'sendEndCall', args: [String(uidTo), callId] });
}

// Ack the callee's answer (sendAnswerACKCall(calleeId, callId)) to complete call setup.
function answerAck({ calleeId, callId, port = 9222 }) {
  return invokeVoiceCall({ port, method: 'sendAnswerACKCall', args: [String(calleeId), callId] });
}

module.exports = { pickAddr, buildRingArgs, buildExtendData, ring, endCall, answerAck, OPUS_CODEC };
