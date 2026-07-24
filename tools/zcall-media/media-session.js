'use strict';
// Duplex SRTP media over UDP to the relay (§B). Outbound: payload -> RTP -> srtp_protect ->
// 5-byte zrtc wrap -> UDP. Inbound: unwrap -> srtp_unprotect -> RTP -> 'media' event.
// Payload is opaque bytes here (opus = step 3). Own account / own traffic only.
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { ZSrtp } = require('./zsrtp.js');
const { buildRtpPacket, parseRtpPacket } = require('./rtp.js');
const { wrapZrtc, unwrapZrtc } = require('./media-frame.js');

class MediaSession extends EventEmitter {
  constructor({ key, ssrc, relayAddr, flowToken, pt = 112 }) {
    super();
    if (!Buffer.isBuffer(key) || key.length !== 30) throw new Error('MediaSession: key must be 30 bytes');
    if (!relayAddr || !relayAddr.port) throw new Error('MediaSession: relayAddr { host, port } required');
    this.srtp = new ZSrtp({ key });
    this.ssrc = ssrc >>> 0;
    this.relay = { host: relayAddr.host || relayAddr.ip, port: Number(relayAddr.port) };
    this.flowToken = flowToken || Buffer.alloc(4);
    this.pt = pt;
    this.seq = 0;
    this.ts = 0;
    this.inboundFlowToken = null;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg) => this._onMessage(msg));
    this.sock.on('error', (e) => this.emit('error', e));
  }

  bind(cb) { this.sock.bind(0, cb); }

  send(payload) {
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + 960) >>> 0;
    const rtp = buildRtpPacket({ pt: this.pt, seq: this.seq, timestamp: this.ts, ssrc: this.ssrc, payload });
    const srtp = this.srtp.protect(rtp);
    const wire = wrapZrtc(0x03, this.flowToken, srtp);
    this.sock.send(wire, this.relay.port, this.relay.host);
  }

  _onMessage(msg) {
    let f;
    try { f = unwrapZrtc(msg); } catch (_) { return; }
    if (!this.inboundFlowToken) this.inboundFlowToken = f.flowToken;
    let rtp;
    try { rtp = this.srtp.unprotect(f.srtp); } catch (e) { this.emit('authfail', e); return; }
    const parsed = parseRtpPacket(rtp);
    this.emit('media', { rtp: parsed, payload: rtp.subarray(parsed.headerLen), flowToken: f.flowToken });
  }

  close() { try { this.sock.close(); } catch (_) {} }
}

module.exports = { MediaSession };
