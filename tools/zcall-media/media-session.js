'use strict';
// Duplex SRTP media over UDP to the relay (§B). Outbound: payload -> RTP -> srtp_protect ->
// 5-byte zrtc wrap -> UDP. Inbound: unwrap -> srtp_unprotect -> RTP -> 'media' event.
// Payload is opaque bytes here (opus = step 3). Own account / own traffic only.
//
// CRITICAL: the InitZRTP handshake MUST run on this same socket (open()) so the relay forwards the
// peer's inbound media to this socket's source port. A separate handshake socket (closed before
// streaming) would make the relay forward to a dead port and no inbound media arrives.
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ZSrtp } = require('./zsrtp.js');
const { buildRtpPacket, parseRtpPacket } = require('./rtp.js');
const { wrapZrtc, unwrapZrtc } = require('./media-frame.js');
const { buildProbe, buildRequest, parseResponse } = require('./initzrtp.js');

const RELAY_PORT = 4200;

class MediaSession extends EventEmitter {
  constructor({ key, ssrc, relayAddr, flowToken, pt = 112, tsInc = 320 }) {
    super();
    if (!Buffer.isBuffer(key) || key.length !== 30) throw new Error('MediaSession: key must be 30 bytes');
    this.srtp = new ZSrtp({ key });
    this.ssrc = ssrc >>> 0;
    this.relay = relayAddr ? { host: relayAddr.host || relayAddr.ip, port: Number(relayAddr.port) } : null;
    this.flowToken = flowToken || Buffer.alloc(4);
    this.pt = pt;
    // RTP timestamp increment per 20 ms frame. opus/16000/1 → 16 kHz clock → 320 (not 960/48 kHz).
    this.tsInc = tsInc;
    this.seq = 0;
    this.ts = 0;
    this.bound = false;
    this.inboundFlowToken = null;
    this.rxResp = 0;   // count of InitZRTP 0x02 responses seen after open() (relay echoes, not media)
    this._pendingHandshake = null;
    this._ftByHost = new Map();   // relay host -> its flowToken (from open() probe results)
    this._retargeted = false;     // outbound relay switched to the actively-bridging relay yet?
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.sock.on('error', (e) => this.emit('error', e));
  }

  bind(cb) { this.sock.bind(0, () => { this.bound = true; if (cb) cb(); }); }

  // Run the InitZRTP handshake ON THIS socket, so inbound media returns to this source port.
  // Prefer the 0x02 reply from `preferHost` (the server-selected relay) — the callee streams
  // through that relay. Falls back to the first reply from any relay.
  //
  // From the 2026-07-14 connected-call capture (§D/§E of
  // ../../docs/superpowers/decisions/2026-07-14-zcall-outgoing-call-connect-flow.md):
  //   - media destination = the relay that REPLIED, on RELAY_PORT (its UDP source), NOT the ASCII
  //     "IP|port" carried at offset 35 of the reply.
  //   - flowToken = that same reply's per-relay token (offset 29); it MUST be stamped into every
  //     outbound media packet [1..4]. (A zero flowToken is why media never bridged before.)
  // Both come from the SAME reply. Resolves { relayAddr, host, port, flowToken } (or null).
  // Collects per-relay probe results over the whole window (for request.extendData.serverResult,
  // §I) instead of settling on the first reply: sends the InitZRTP request (for the flowToken) +
  // several probes per relay, counts 0x02 replies (recv) and measures rtt. Selects preferHost if it
  // replied, else the best relay (highest recv, then lowest rtt), and sets this.relay + this.flowToken
  // from that SAME reply. Resolves { selected, results, flowToken, host, port } (or null).
  open({ servers, fromId, toId, callId, sessId, preferHost, isCallee, relayPort = RELAY_PORT, probes = 6, timeoutMs = 1800 }) {
    return new Promise((resolve) => {
      const byHost = new Map();   // host -> { host, recv, rtt, flowToken, relayAddr }
      let sentAt = 0;
      this._pendingHandshake = (parsed, host) => {
        if (!host) return;
        let e = byHost.get(host);
        if (!e) { e = { host, recv: 0, rtt: null, flowToken: parsed.flowToken, relayAddr: parsed.relayAddr }; byHost.set(host, e); }
        e.recv++;
        if (e.rtt == null) e.rtt = Math.max(1, Date.now() - sentAt);
        if (!e.flowToken || e.flowToken.every((b) => b === 0)) e.flowToken = parsed.flowToken;
      };
      const start = () => {
        sentAt = Date.now();
        const seen = new Set();
        for (const srv of servers) {
          const raw = typeof srv === 'string' ? srv : (srv.rtpaddr || srv.rtpIP || srv.host || '');
          const host = String(raw).split(/[|:]/)[0].trim();
          if (!host || seen.has(host)) continue;
          seen.add(host);
          this.sock.send(buildRequest({ fromId, toId, callId, sessId, isCallee }), relayPort, host);
          for (let k = 0; k < probes; k++) this.sock.send(buildProbe({ fromId, callId, probeNonce: crypto.randomBytes(4) }), relayPort, host);
        }
        setTimeout(() => {
          this._pendingHandshake = null;
          const results = [...byHost.values()];
          this._ftByHost = new Map(results.map((r) => [r.host, r.flowToken]));
          let sel = (preferHost && byHost.get(preferHost)) || null;
          if (!sel) sel = results.slice().sort((a, b) => (b.recv - a.recv) || (a.rtt - b.rtt))[0] || null;
          if (sel) { this.relay = { host: sel.host, port: relayPort }; this.flowToken = sel.flowToken; }
          resolve(sel ? { selected: sel, results, flowToken: sel.flowToken, host: sel.host, port: relayPort } : null);
        }, timeoutMs);
      };
      if (this.bound) start(); else this.bind(start);
    });
  }

  send(payload) {
    if (!this.relay) throw new Error('MediaSession.send: no relay (call open() or pass relayAddr)');
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + this.tsInc) >>> 0;
    const rtp = buildRtpPacket({ pt: this.pt, seq: this.seq, timestamp: this.ts, ssrc: this.ssrc, payload });
    const srtp = this.srtp.protect(rtp);
    const wire = wrapZrtc(0x03, this.flowToken, srtp);
    this.sock.send(wire, this.relay.port, this.relay.host);
  }

  _onMessage(msg, rinfo) {
    this.emit('raw', msg, rinfo);
    // InitZRTP RESPONSE (type 0x02) — never media. Feed open()'s handler (prefer selected relay);
    // once open() has settled, just count the extra relay echoes.
    if (msg[0] === 0x02) {
      if (this._pendingHandshake) {
        let parsed;
        try { parsed = parseResponse(msg); } catch (_) { return; }
        this._pendingHandshake(parsed, rinfo && rinfo.address);
      } else {
        this.rxResp++;
      }
      return;
    }
    // media packet. Retarget outbound to the relay the phone's media actually arrives FROM (the
    // relay actively bridging) with THAT relay's flowToken — open()'s selected relay is sometimes a
    // different one, and sending elsewhere means the phone never hears us.
    if (!this._retargeted && rinfo && this.relay && rinfo.address !== this.relay.host && this._ftByHost.has(rinfo.address)) {
      this.relay = { host: rinfo.address, port: this.relay.port };
      this.flowToken = this._ftByHost.get(rinfo.address);
      this._retargeted = true;
      this.emit('retarget', rinfo.address);
    }
    this.emit('wire', msg);
    // Audio only: OUTBOUND-style 0x03 (5-byte prefix, RTP@5) or real INBOUND 0x04 (1-byte prefix,
    // RTP@1, no flowToken — 2026-07-14 capture §C). unwrapZrtc detects the prefix by type. Skip
    // 0x05+ sub-streams (RTCP/secondary), which are not the audio SRTP path.
    if (msg[0] !== 0x03 && msg[0] !== 0x04) return;
    let f;
    try { f = unwrapZrtc(msg); } catch (_) { return; }
    if (f.flowToken && !this.inboundFlowToken) this.inboundFlowToken = f.flowToken;
    let rtp;
    try { rtp = this.srtp.unprotect(f.srtp); } catch (e) { this.emit('authfail', e); return; }
    const parsed = parseRtpPacket(rtp);
    this.emit('media', { type: f.type, rtp: parsed, payload: rtp.subarray(parsed.headerLen), flowToken: f.flowToken });
  }

  close() { try { this.sock.close(); } catch (_) {} }
}

module.exports = { MediaSession };
