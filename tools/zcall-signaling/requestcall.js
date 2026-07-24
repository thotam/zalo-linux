'use strict';
// requestcall config parsing + SRTP keying + request builder. (GO verdict §1, §3.)
const zpw = require('./zpw.js');

function parseConfig(jsonStr) {
  const cfg = JSON.parse(jsonStr);
  // sessId is a variable-length base64url token (observed 152 and 154 chars across accounts).
  // The only hard requirement is >=30 chars (the SRTP master key = sessId[0:30]); the non-empty
  // servers[] below is the real config-validity gate.
  if (typeof cfg.sessId !== 'string' || cfg.sessId.length < 30) {
    throw new Error('requestcall: sessId too short (need >=30 chars), got ' + (cfg.sessId && cfg.sessId.length));
  }
  if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
    throw new Error('requestcall: expected non-empty servers[]');
  }
  return cfg;
}

// SRTP master key = first 30 raw ASCII bytes of sessId (16-byte AES-128 key + 14-byte salt).
function srtpMasterKey(sessId) {
  if (typeof sessId !== 'string' || sessId.length < 30) {
    throw new Error('requestcall: sessId too short for a 30-byte master key');
  }
  return Buffer.from(sessId.slice(0, 30), 'ascii');
}

// Rebuild a requestcall URL from a captured sample: apply overrides, re-encrypt params.
function buildRequestUrl({ sampleUrl, sampleParamsPlain, secretKey, overrides }) {
  const u = new URL(sampleUrl);
  const params = Object.assign({}, sampleParamsPlain, overrides || {});
  u.searchParams.set('params', zpw.encode(params, secretKey));
  return u.toString();
}

module.exports = { parseConfig, srtpMasterKey, buildRequestUrl };
