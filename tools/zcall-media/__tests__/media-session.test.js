const assert = require('assert');
const dgram = require('dgram');
const path = require('path');
const MOD = path.join(__dirname, '..', 'media-session.js');
const { MediaSession } = require(MOD);

// Fake relay: echo every wire packet back to its sender (loopback duplex).
const relay = dgram.createSocket('udp4');
relay.on('message', (msg, rinfo) => relay.send(msg, rinfo.port, rinfo.address));

(async () => {
  await new Promise((res) => relay.bind(0, res));
  const port = relay.address().port;
  const key = Buffer.alloc(30);
  for (let i = 0; i < 30; i++) key[i] = (i * 3 + 5) & 0xff;

  const s = new MediaSession({
    key, ssrc: 0x11223344,
    relayAddr: { host: '127.0.0.1', port },
    flowToken: Buffer.from('0a0b0c0d', 'hex'),
  });
  await new Promise((res) => s.bind(res));

  const got = new Promise((res) => s.on('media', res));
  s.send(Buffer.from('frame-1'));
  const m = await got;

  assert.strictEqual(m.payload.toString(), 'frame-1', 'echoed payload decrypted');
  assert.strictEqual(m.flowToken.toString('hex'), '0a0b0c0d', 'flowToken preserved on the wire');
  assert.strictEqual(m.rtp.pt, 112, 'pt=112');
  assert.strictEqual(m.rtp.ssrc, 0x11223344, 'ssrc=fromId');
  s.close(); relay.close();
  console.log('OK media-session');
})().catch((e) => { relay.close(); console.error(e); process.exit(1); });
