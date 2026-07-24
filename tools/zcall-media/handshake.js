'use strict';
// InitZRTP UDP handshake sweep (SP2 step 2.1). Sends probe+request to each candidate relay,
// collects 0x02 replies. No SRTP/media. Own account / own traffic only.
const dgram = require('dgram');
const crypto = require('crypto');
const { buildProbe, buildRequest, parseResponse } = require('./initzrtp.js');

const RELAY_PORT = 4200;

// Normalize a requestcall servers[] entry to { host, port }. Accepts a string
// ("ip", "ip|port", "ip:port") or an object ({ rtpaddr | rtpIP | host }).
function relayHost(server, port = RELAY_PORT) {
  const raw = typeof server === 'string' ? server : (server && (server.rtpaddr || server.rtpIP || server.host)) || '';
  const host = String(raw).split(/[|:]/)[0].trim();
  if (!host) throw new Error('relayHost: cannot resolve host from ' + JSON.stringify(server));
  return { host, port };
}

function handshake({ fromId, toId, callId, sessId, servers, timeoutMs = 3000, relayPort = RELAY_PORT }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const results = [];
    const byHost = new Map();                  // relay source ip -> { server, host, sentAt }
    const targets = servers.map((s) => relayHost(s, relayPort));

    sock.on('error', (e) => { try { sock.close(); } catch (_) {} reject(e); });

    // Correlate a reply to the relay we sent to by UDP source address (rinfo.address == target
    // host) — real relays do NOT echo our probe nonce. Each reply carries the relay's per-relay
    // flowToken (offset 29) and the media destination is that relay's src IP on :4200 (per the
    // 2026-07-14 connected-call capture).
    sock.on('message', (msg, rinfo) => {
      if (msg[0] !== 0x02) return;
      let parsed;
      try { parsed = parseResponse(msg); } catch (_) { return; }
      const ctx = byHost.get(rinfo.address) || null;
      results.push({
        server: ctx ? ctx.server : null,
        relayAddr: parsed.relayAddr,
        src: rinfo.address,               // media dest = src:relayPort
        flowToken: parsed.flowToken,      // per-relay token to stamp into outbound media [1..4]
        rttMs: ctx ? Date.now() - ctx.sentAt : null,
      });
    });

    sock.bind(0, () => {
      for (let i = 0; i < targets.length; i++) {
        const { host, port } = targets[i];
        const nonce = crypto.randomBytes(4);
        byHost.set(host, { server: servers[i], host, sentAt: Date.now() });
        sock.send(buildProbe({ fromId, callId, probeNonce: nonce }), port, host);
        sock.send(buildRequest({ fromId, toId, callId, sessId }), port, host);
      }
      setTimeout(() => { try { sock.close(); } catch (_) {} resolve(results); }, timeoutMs);
    });
  });
}

module.exports = { handshake, relayHost, RELAY_PORT };
