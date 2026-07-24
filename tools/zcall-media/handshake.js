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
    const byNonce = new Map();                 // nonceHex -> { server, host, sentAt }
    const byHost = new Map();                  // relay source ip -> { server, host, sentAt }
    const targets = servers.map((s) => relayHost(s, relayPort));

    sock.on('error', (e) => { try { sock.close(); } catch (_) {} reject(e); });

    // Correlate a reply to the relay we sent to: real relays don't echo our probe nonce in the
    // 0x02 reply, so fall back to matching the UDP source address (rinfo.address == target host).
    sock.on('message', (msg, rinfo) => {
      if (msg[0] !== 0x02) return;
      let parsed;
      try { parsed = parseResponse(msg); } catch (_) { return; }
      const nonceHex = parsed.probeNonce.toString('hex');
      const ctx = byNonce.get(nonceHex) || byHost.get(rinfo.address) || null;
      results.push({
        server: ctx ? ctx.server : null,
        relayAddr: parsed.relayAddr,
        src: rinfo.address,
        probeNonce: nonceHex,
        rttMs: ctx ? Date.now() - ctx.sentAt : null,
      });
    });

    sock.bind(0, () => {
      for (let i = 0; i < targets.length; i++) {
        const { host, port } = targets[i];
        const nonce = crypto.randomBytes(4);
        const ctx = { server: servers[i], host, sentAt: Date.now() };
        byNonce.set(nonce.toString('hex'), ctx);
        byHost.set(host, ctx);
        sock.send(buildProbe({ fromId, callId, probeNonce: nonce }), port, host);
        sock.send(buildRequest({ fromId, toId, callId, sessId }), port, host);
      }
      setTimeout(() => { try { sock.close(); } catch (_) {} resolve(results); }, timeoutMs);
    });
  });
}

module.exports = { handshake, relayHost, RELAY_PORT };
