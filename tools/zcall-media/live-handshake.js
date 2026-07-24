'use strict';
// Operator-run live InitZRTP handshake on Linux (own account / own phone). Fetches a live config
// via the signaling tool (CDP invoke of the app's own requestCall), runs the UDP handshake, and
// prints a REDACTED summary. Never prints sessId or the raw relay IP. Own traffic only.
//
// Prereq: launch Zalo with remote debugging (ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux) so the
// signaling CDP invoke can reach the page (see tools/zcall-signaling/README.md).
const { handshake } = require('./handshake.js');
const { invokeRequestCall } = require('../zcall-signaling/cdp-invoke.js');
const { parseConfig } = require('../zcall-signaling/requestcall.js');

// Mask an "ip|port" so committed/printed logs never leak the real relay.
function maskAddr(addr) {
  if (!addr || !addr.ip) return '<none>';
  return addr.ip.replace(/[0-9A-Fa-f]+/g, '***') + '|****';
}

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-media/live-handshake.js <calleeId>');
  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));
  const res = await handshake({
    fromId: config.fromId,
    toId: config.toId,
    callId,
    sessId: config.sessId,
    servers: config.servers,
  });
  console.log('[initzrtp-live] relaysReplied ' + res.length + '/' + config.servers.length);
  for (const r of res) console.log('  relay ' + maskAddr(r.relayAddr) + '  rtt ' + r.rttMs + 'ms');
  console.error('[initzrtp-live] ' + (res.length ? 'OK — got relay media address(es) from real 0x02 reply' : 'FAILED — no relay replied'));
  process.exit(res.length ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('[initzrtp-live] FAILED:', e.message); process.exit(1); });
module.exports = { main, maskAddr };
