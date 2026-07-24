'use strict';
// Read the incoming call-control 'answer' event from the diag log. On Linux the server pushes
// call signals via JS polling ($ctrl -> callbackVideoCallEvent -> handleControl -> _sendToNative),
// and _sendToNative is logged to ~/zalo-call-diag.log. The 'answer' event carries the REAL media
// rendezvous: params.rtpSerIp (relay media endpoint) + params.sessId (the media key source) +
// codec. This is the missing piece for a connected call on Linux. Own account only.
const fs = require('fs');

// Parse every CALLDIAG-PAYLOAD sendToNative control event out of the (doubly-escaped) log.
function readControlEvents(logText) {
  const out = [];
  const re = /sendToNative (\{\\"type\\".*?)","line"/g;
  let m;
  while ((m = re.exec(logText))) {
    try {
      const unesc = JSON.parse('"' + m[1] + '"'); // undo one level of JS-string escaping
      out.push(JSON.parse(unesc));
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Latest 'answer' control event for a given callId -> { status, rtpSerIp, sessId, codec, params }.
function findAnswer(logText, callId) {
  const cid = String(callId);
  let best = null;
  for (const o of readControlEvents(logText)) {
    const d = o && o.data;
    if (!d || d.act !== 'answer' || !d.data || String(d.data.callId) !== cid) continue;
    let params = {};
    try { params = JSON.parse(d.data.params || '{}'); } catch (_) {}
    best = {
      status: d.data.status,
      rtpSerIp: params.rtpSerIp || params.rtpIP || null,
      sessId: params.sessId || null,
      codec: d.data.codec,
      params,
    };
  }
  return best;
}

function readAnswer(logPath, callId) {
  let txt = '';
  try { txt = fs.readFileSync(logPath, 'utf8'); } catch (_) { return null; }
  return findAnswer(txt, callId);
}

// All voip control events for a callId, in order -> [{ act, status, rtpSerIp, hasSessId }].
function findCallEvents(logText, callId) {
  const cid = String(callId);
  const out = [];
  for (const o of readControlEvents(logText)) {
    const d = o && o.data;
    if (!d || d.act_type !== 'voip' || !d.data || String(d.data.callId) !== cid) continue;
    let params = {};
    try { params = JSON.parse(d.data.params || '{}'); } catch (_) {}
    out.push({ act: d.act, status: d.data.status, rtpSerIp: params.rtpSerIp || params.rtpIP || null, hasSessId: !!params.sessId });
  }
  return out;
}

module.exports = { readControlEvents, findAnswer, readAnswer, findCallEvents };
