'use strict';
// Debug: dump the requestcall config STRUCTURE (keys + address formats) with values masked, to
// figure out the correct sendRequestCall params. Own account only. Digits -> '#', so an address
// like "14.225.1.2:4200" prints as "##.###.#.#:####" — format visible, value hidden.
const { invokeRequestCall } = require('./cdp-invoke.js');

function maskVal(v) {
  if (typeof v === 'number') return '<num:' + String(v).length + 'd>';
  if (typeof v === 'string') return v.replace(/[0-9A-Za-z]/g, (c) => (/[0-9]/.test(c) ? '#' : 'x'));
  return v;
}

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-signaling/dump-config.js <calleeId>');
  const callId = Math.floor(Math.random() * 1e9);
  const cfg = await invokeRequestCall({ calleeId, callId, type: 1 });

  console.log('top-level keys:', Object.keys(cfg).join(', '));
  const addrKeys = ['rtpIP', 'rtcpIP', 'rtpaddr', 'rtcpaddr', 'protocol', 'codec'];
  for (const k of addrKeys) if (k in cfg) console.log(k + ':', maskVal(cfg[k]), '(format-masked)');
  console.log('fromId digits:', String(cfg.fromId).length, ' toId digits:', String(cfg.toId).length);
  console.log('sessId length:', cfg.sessId ? cfg.sessId.length : 0);
  if (Array.isArray(cfg.servers) && cfg.servers[0]) {
    console.log('servers[0] keys:', Object.keys(cfg.servers[0]).join(', '));
    for (const k of Object.keys(cfg.servers[0])) console.log('  servers[0].' + k + ':', maskVal(cfg.servers[0][k]));
  }
  // show any field whose name hints at address/session/codec, masked
  for (const k of Object.keys(cfg)) {
    if (/addr|ip|session|codec|rtp|rtcp/i.test(k) && !addrKeys.includes(k)) {
      console.log('extra ' + k + ':', maskVal(cfg[k]));
    }
  }
}

if (require.main === module) main().catch((e) => { console.error('[dump-config] FAILED:', e.message); process.exit(1); });
module.exports = { main };
