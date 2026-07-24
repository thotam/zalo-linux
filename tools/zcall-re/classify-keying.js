'use strict';
// SP2.0 keying classifier. Pure analysis over captured [CALLDIAG-PAYLOAD] objects.
const { parsePayloadLines } = require('./capture-utils.js');

const KEYMAT = ['srtpkey', 'masterkey', 'key', 'salt'];
const NONCE = ['nonce', 'seed', 'challenge'];
const SESSION = ['sessid', 'session', 'token'];

function collectKeyingSignals(value) {
  const signals = new Set();
  let sawSession = false;
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const lk = k.toLowerCase();
        const val = v[k];
        if (lk === 'zrtc_config' && val && (typeof val !== 'object' || Object.keys(val).length > 0)) signals.add('zrtc-config');
        if (KEYMAT.indexOf(lk) >= 0 && typeof val === 'string' && val.length >= 16) signals.add('srtp-key-material');
        if (NONCE.indexOf(lk) >= 0 && val) signals.add('kdf-nonce');
        if (SESSION.indexOf(lk) >= 0 && val) sawSession = true;
        walk(val);
      }
    }
  })(value);
  if (signals.size === 0 && sawSession) signals.add('session-token-only');
  return Array.from(signals);
}

function classifyKeying(payloads) {
  const signals = new Set();
  for (const p of payloads || []) for (const s of collectKeyingSignals(p && p.obj)) signals.add(s);
  const has = (s) => signals.has(s);
  let klass, rationale;
  // NB: `zrtc-config` presence does NOT imply class a — SP2.1 confirmed zrtc_config is pure
  // codec/quality tuning with NO key material (the real SRTP key is sessId[0:30], carried in
  // the `sessId` token, not inside zrtc_config). Class a requires actual key material.
  if (has('srtp-key-material')) { klass = 'a'; rationale = 'server-delivered SRTP key material in signaling/config payload'; }
  else if (has('kdf-nonce')) { klass = 'b'; rationale = 'server nonce present -> client likely derives keys via KDF'; }
  else { klass = 'd'; rationale = 'only session/token, zrtc_config, or nothing -> keying is in the session token (sessId) or media handshake, not standalone key material'; }
  return { klass, signals: Array.from(signals), rationale };
}

// Adapter: classify an array of raw JSON bodies (e.g. decrypted signaling from mitmproxy /
// TLS keylog) with the same signal logic as the [CALLDIAG-PAYLOAD] path.
function classifyFromJson(objs) {
  return classifyKeying((objs || []).map((o) => ({ obj: o })));
}

if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  if (args[0] === '--json') {
    if (!args[1]) { console.error('usage: node classify-keying.js --json <file.json>'); process.exit(2); }
    console.log(JSON.stringify(classifyFromJson(JSON.parse(fs.readFileSync(args[1], 'utf8'))), null, 2));
  } else {
    const file = args[0];
    if (!file) { console.error('usage: node classify-keying.js <diag-log-file> | --json <file.json>'); process.exit(2); }
    const payloads = parsePayloadLines(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(classifyKeying(payloads), null, 2));
  }
}

module.exports = { collectKeyingSignals, classifyKeying, classifyFromJson };
