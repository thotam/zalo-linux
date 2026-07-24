'use strict';
// Offline analysis helpers for SP2.0 keying-capture logs. Pure; no Electron.

const SECRET_KEYS = ['sessid', 'session', 'token', 'key', 'secret', 'srtpkey', 'masterkey', 'salt', 'auth', 'password'];
const BASE64ISH = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;

function parsePayloadLines(logText) {
  const out = [];
  const CONSOLE = '] CONSOLE ';
  const TAG = '[CALLDIAG-PAYLOAD] ';
  for (const line of String(logText).split('\n')) {
    // Diag lines wrap the console message as JSON after "] CONSOLE ": {"...","message":"<msg>",...}
    let msg = null;
    const ci = line.indexOf(CONSOLE);
    if (ci >= 0) {
      try { msg = JSON.parse(line.slice(ci + CONSOLE.length)).message; } catch (_) { msg = null; }
    }
    // Also accept a bare (non-wrapped) "[CALLDIAG-PAYLOAD] ..." line.
    if (msg == null && line.indexOf(TAG) >= 0) msg = line.slice(line.indexOf(TAG));
    if (msg == null) continue;
    const pi = msg.indexOf(TAG);
    if (pi < 0) continue;
    const rest = msg.slice(pi + TAG.length);
    const sp = rest.indexOf(' ');
    const tag = sp < 0 ? rest : rest.slice(0, sp);
    const raw = sp < 0 ? '' : rest.slice(sp + 1);
    let obj = null;
    try { obj = JSON.parse(raw); } catch (_) { obj = null; }
    out.push({ tag, obj, raw });
  }
  return out;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SECRET_KEYS.indexOf(k.toLowerCase()) >= 0) {
        const v = value[k];
        out[k] = '<redacted:' + (typeof v === 'string' ? v.length : String(v).length) + '>';
      } else {
        out[k] = redactSecrets(value[k]);
      }
    }
    return out;
  }
  if (typeof value === 'string' && BASE64ISH.test(value)) return '<redacted:base64:' + value.length + '>';
  return value;
}

module.exports = { parsePayloadLines, redactSecrets };
