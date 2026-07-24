'use strict';
// Operator-run live SRTP media on Linux (own account / own phone). Signaling -> InitZRTP handshake
// -> open a MediaSession to the chosen relay -> send K synthetic payloads AND receive+decrypt the
// peer's real inbound media for a few seconds. Prints a REDACTED summary. Own traffic only.
// Payload is synthetic (NOT audio) — opus is step 3.
const { invokeRequestCall } = require('../zcall-signaling/cdp-invoke.js');
const { parseConfig, srtpMasterKey } = require('../zcall-signaling/requestcall.js');
const { handshake } = require('./handshake.js');
const { MediaSession } = require('./media-session.js');

function mask(s) { return String(s).replace(/[0-9A-Fa-f]+/g, '***'); }

async function main() {
  const calleeId = process.argv[2];
  if (!calleeId) throw new Error('usage: node tools/zcall-media/live-media.js <calleeId>');
  const durationMs = Number(process.argv[3] || 8000);

  const callId = Math.floor(Math.random() * 1e9);
  const config = parseConfig(JSON.stringify(await invokeRequestCall({ calleeId, callId, type: 1 })));
  const key = srtpMasterKey(config.sessId);

  const replies = await handshake({
    fromId: config.fromId, toId: config.toId, callId, sessId: config.sessId, servers: config.servers,
  });
  if (!replies.length) throw new Error('no relay replied to InitZRTP — cannot open media');
  const r0 = replies[0];
  // Media dest = the relay that REPLIED, on :4200 (its UDP source), stamped with its per-relay
  // flowToken (offset 29) — NOT the ASCII relayAddr@35 (2026-07-14 capture §D/§E). NOTE: this tool
  // runs InitZRTP on a SEPARATE socket, so inbound media returns to a dead port — use live-call.js
  // (open() on the media socket) for a real duplex/connected test.
  const s = new MediaSession({ key, ssrc: config.fromId, relayAddr: { host: r0.src, port: 4200 }, flowToken: r0.flowToken });
  await new Promise((res) => s.bind(res));

  let inOk = 0, inFail = 0, seenFlow = null;
  s.on('media', (m) => { inOk++; if (!seenFlow) seenFlow = m.flowToken; });
  s.on('authfail', () => { inFail++; });

  // send a synthetic payload every 20ms (opus frame cadence) for the duration
  const filler = Buffer.alloc(80, 0);
  const timer = setInterval(() => { try { s.send(filler); } catch (_) {} }, 20);
  await new Promise((res) => setTimeout(res, durationMs));
  clearInterval(timer);
  s.close();

  console.log('[live-media] inboundAuthOk ' + inOk + '  authfail ' + inFail);
  console.log('[live-media] inbound flowToken ' + (seenFlow ? mask(seenFlow.toString('hex')) : '<none>'));
  console.log('[live-media] relay ' + mask((r0.src || '') + '|4200') + '  flowToken ' + mask((r0.flowToken || Buffer.alloc(0)).toString('hex')));
  console.error('[live-media] ' + (inOk ? 'OK — decrypted peer real inbound media on Linux' : 'no inbound decrypted (see §B.3 re-key / flowToken notes)'));
  process.exit(inOk ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error('[live-media] FAILED:', e.message); process.exit(1); });
module.exports = { main };
