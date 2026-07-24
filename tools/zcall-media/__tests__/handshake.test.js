const assert = require('assert');
const dgram = require('dgram');
const path = require('path');
const MOD = path.join(__dirname, '..', 'handshake.js');
const { handshake, relayHost, RELAY_PORT } = require(MOD);

// relayHost normalization
assert.deepStrictEqual(relayHost('9.9.9.9'), { host: '9.9.9.9', port: RELAY_PORT }, 'relayHost bare ip');
assert.deepStrictEqual(relayHost('9.9.9.9|4200'), { host: '9.9.9.9', port: RELAY_PORT }, 'relayHost ip|port');
assert.deepStrictEqual(relayHost({ rtpaddr: '8.8.8.8|4200' }), { host: '8.8.8.8', port: RELAY_PORT }, 'relayHost object');
assert.deepStrictEqual(relayHost('9.9.9.9', 5000), { host: '9.9.9.9', port: 5000 }, 'relayHost port override');

// Fake relay: on request (0x01/0x0b) reply with a 0x02 carrying a per-call nonce @25 and a
// relay-ASSIGNED flowToken @29 (real relays do NOT echo our probe nonce — the flowToken is the
// relay's own, and the caller must stamp it into outbound media). 2026-07-14 capture.
const RELAY_ADDR = '203.0.113.7|40000';
const RELAY_FLOWTOKEN = Buffer.from('ac95915d', 'hex');   // relay-assigned, independent of our probe
const relay = dgram.createSocket('udp4');
relay.on('message', (msg, rinfo) => {
  if (msg[0] === 0x01 && msg[18] === 0x0b) {          // request
    const callId = msg.readUInt32LE(21);
    const resp = Buffer.alloc(35 + RELAY_ADDR.length);
    resp[0] = 0x02; resp[1] = 0x7e;
    resp[18] = 0x0b; resp[19] = 0x00; resp[20] = 0x02;
    resp.writeUInt32LE(callId, 25);                    // (nonce field — echo callId here is fine)
    RELAY_FLOWTOKEN.copy(resp, 29);                    // per-relay flowToken
    resp.writeUInt16LE(RELAY_ADDR.length, 33);
    resp.write(RELAY_ADDR, 35, 'ascii');
    relay.send(resp, rinfo.port, rinfo.address);
  }
});

(async () => {
  await new Promise((res) => relay.bind(0, res));
  const relayPort = relay.address().port;
  const sessId = 'A'.repeat(154);
  const res = await handshake({
    fromId: 0x11223344, toId: 0x55667788, callId: 0x0a, sessId,
    servers: ['127.0.0.1'], timeoutMs: 1000, relayPort,
  });
  relay.close();
  assert.strictEqual(res.length, 1, 'one relay replied');
  assert.deepStrictEqual(res[0].relayAddr, { ip: '203.0.113.7', port: '40000' }, 'parsed relay addr');
  assert.strictEqual(res[0].flowToken.toString('hex'), 'ac95915d', 'per-relay flowToken exposed');
  assert.strictEqual(res[0].src, '127.0.0.1', 'relay source ip (media dest = src:4200)');
  assert.strictEqual(res[0].server, '127.0.0.1', 'server tagged back');
  assert.strictEqual(typeof res[0].rttMs, 'number', 'rtt measured');
  console.log('OK handshake');
})().catch((e) => { relay.close(); console.error(e); process.exit(1); });
