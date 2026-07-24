const assert = require('assert');
const dgram = require('dgram');
const path = require('path');
const MOD = path.join(__dirname, '..', 'media-session.js');
const { MediaSession } = require(MOD);

function makeKey() { const key = Buffer.alloc(30); for (let i = 0; i < 30; i++) key[i] = (i * 3 + 5) & 0xff; return key; }

// --- Test 1: duplex — send SRTP media, fake relay echoes it, we decrypt it back ---
async function testEcho() {
  const relay = dgram.createSocket('udp4');
  relay.on('message', (msg, rinfo) => relay.send(msg, rinfo.port, rinfo.address)); // loopback echo
  await new Promise((res) => relay.bind(0, res));
  const port = relay.address().port;

  const s = new MediaSession({
    key: makeKey(), ssrc: 0x11223344,
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
  console.log('OK media-session (echo)');
}

// --- Test 2: open() captures the relay-assigned flowToken (§E) and sends media to the RESPONDER
// on relayPort (§D) — NOT the ASCII "IP|port" carried in the reply. Then media is stamped with
// that flowToken. This is the 2026-07-14 connect fix. ---
async function testOpenFlowToken() {
  const RELAY_FLOWTOKEN = 'ac95915d';
  const ASCII_ADDR = '9.9.9.9|11111';   // deliberately != responder (127.0.0.1) — must NOT be the media dest
  const relay = dgram.createSocket('udp4');
  relay.on('message', (msg, rinfo) => {
    if (msg[0] === 0x01 && msg[18] === 0x0b) {         // InitZRTP request -> 0x02 reply
      const callId = msg.readUInt32LE(21);
      const resp = Buffer.alloc(35 + ASCII_ADDR.length);
      resp[0] = 0x02; resp[1] = 0x7e;
      resp[18] = 0x0b; resp[19] = 0x00; resp[20] = 0x02;
      resp.writeUInt32LE(callId, 25);                  // per-call nonce field
      Buffer.from(RELAY_FLOWTOKEN, 'hex').copy(resp, 29); // per-relay flowToken @29
      resp.writeUInt16LE(ASCII_ADDR.length, 33);
      resp.write(ASCII_ADDR, 35, 'ascii');
      relay.send(resp, rinfo.port, rinfo.address);
    } else if (msg[0] === 0x03) {                       // media -> echo back
      relay.send(msg, rinfo.port, rinfo.address);
    }
  });
  await new Promise((res) => relay.bind(0, res));
  const port = relay.address().port;

  const s = new MediaSession({ key: makeKey(), ssrc: 0x0fb25d73 }); // no relayAddr, no flowToken
  await new Promise((res) => s.bind(res));
  const opened = await s.open({
    servers: ['127.0.0.1'], fromId: 0x0fb25d73, toId: 0x01020304,
    callId: 0x0a, sessId: 'A'.repeat(154), preferHost: '127.0.0.1', relayPort: port, timeoutMs: 1500,
  });

  assert.ok(opened, 'open() settled on a reply');
  assert.strictEqual(s.flowToken.toString('hex'), RELAY_FLOWTOKEN, 'this.flowToken = relay reply @29 (not 0)');
  assert.strictEqual(s.relay.host, '127.0.0.1', 'media dest host = RESPONDER (not the ASCII 9.9.9.9)');
  assert.strictEqual(s.relay.port, port, 'media dest port = relayPort (responder), not the ASCII port');
  assert.strictEqual(opened.flowToken.toString('hex'), RELAY_FLOWTOKEN, 'open() resolves the flowToken');

  // and the stamped media carries that flowToken on the wire
  const got = new Promise((res) => s.on('media', res));
  s.send(Buffer.from('hello'));
  const m = await got;
  assert.strictEqual(m.flowToken.toString('hex'), RELAY_FLOWTOKEN, 'outbound media stamped with relay flowToken');
  assert.strictEqual(m.payload.toString(), 'hello', 'round-trips through the responder relay');
  s.close(); relay.close();
  console.log('OK media-session (open/flowToken)');
}

// --- Test 3: REAL inbound framing (2026-07-14 capture §C). The relay forwards callee media as
// type 0x04 with the SRTP packet at offset 1 and NO flowToken (1-byte prefix), unlike our outbound
// 0x03 (5-byte prefix). The receive path must detect 0x04 -> srtp@1 and still decrypt it. ---
async function testInbound04() {
  const relay = dgram.createSocket('udp4');
  relay.on('message', (msg, rinfo) => {
    if (msg[0] !== 0x03) return;                 // our outbound 0x03: [0x03|ft(4)|SRTP@5]
    const srtp = msg.subarray(5);                // strip the 5-byte 0x03 prefix
    const inbound = Buffer.concat([Buffer.from([0x04]), srtp]);  // re-frame as 0x04: [0x04|SRTP@1]
    relay.send(inbound, rinfo.port, rinfo.address);
  });
  await new Promise((res) => relay.bind(0, res));
  const port = relay.address().port;

  const s = new MediaSession({
    key: makeKey(), ssrc: 0x11223344,
    relayAddr: { host: '127.0.0.1', port },
    flowToken: Buffer.from('0a0b0c0d', 'hex'),
  });
  await new Promise((res) => s.bind(res));

  const got = new Promise((res) => s.on('media', res));
  s.send(Buffer.from('inbound-04'));
  const m = await got;

  assert.strictEqual(m.payload.toString(), 'inbound-04', '0x04 inbound decrypted (srtp@offset1)');
  assert.strictEqual(m.rtp.pt, 112, '0x04 pt=112');
  assert.strictEqual(m.type, 0x04, 'media event reports type 0x04');
  s.close(); relay.close();
  console.log('OK media-session (inbound 0x04)');
}

(async () => {
  await testEcho();
  await testOpenFlowToken();
  await testInbound04();
  console.log('OK media-session');
})().catch((e) => { console.error(e); process.exit(1); });
