'use strict';
// Minimal loopback UDP responder: echoes the first bytes back so the ZRTC
// handshake advances past its initial send. Listens on 59000/59001.
const dgram = require('dgram');
for (const port of [59000, 59001]) {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, rinfo) => {
    // echo the datagram straight back to the sender
    s.send(msg, rinfo.port, rinfo.address);
  });
  s.bind(port, '127.0.0.1');
}
console.log('udp-responder listening on 59000/59001');
