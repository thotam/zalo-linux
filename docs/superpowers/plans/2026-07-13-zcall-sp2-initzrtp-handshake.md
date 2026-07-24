# InitZRTP Handshake (Linux) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build byte-exact InitZRTP packets per §A, send them to a real VNG relay on `:4200` using a live `sessId` obtained on Linux, and parse the `0x02` reply to extract the media relay address.

**Architecture:** Pure Node.js. A stateless builder/parser (`initzrtp.js`), a `dgram` UDP sweep (`handshake.js`), and an operator CLI (`live-handshake.js`) that reuses `tools/zcall-signaling` for a live config. Offline golden-vector tests + a loopback transport test; live run is manual.

**Tech Stack:** Node.js `dgram`, `Buffer`, `crypto.randomBytes`. No native addon, no libsrtp (step 2.2).

**Spec:** `docs/superpowers/specs/2026-07-13-zcall-sp2-initzrtp-handshake-design.md`
**Wire format source:** §A of `docs/superpowers/decisions/2026-07-13-zcall-initzrtp-and-srtp-profile.md`

## Global Constraints

- **Boundary:** operator's own account / own machine / own phone only. `sessId`, relay addresses, pcap are ephemeral secrets — never committed. Committed output redacted; live artifacts git-ignored.
- **No `Co-Authored-By` / AI-attribution** in any commit or file.
- **Runtime:** Node.js only. No native/libsrtp in this step.
- **Endianness:** little-endian for `fromId`/`toId`/`callId`. `sessId` ASCII; length field LE u16 = `9a 00` (154).
- Do **not** reuse `tools/zcall-re/parse-zrtppacket.js` (old SP1 41-byte BE parser).
- Commit only when the operator explicitly asks (repo rule).

---

### Task 1: InitZRTP builder/parser (`initzrtp.js`) + golden-vector tests

**Files:**
- Create: `tools/zcall-media/initzrtp.js`
- Test: `tools/zcall-media/__tests__/initzrtp.test.js`

**Interfaces:**
- Produces:
  - `buildProbe({ fromId:number, callId:number, probeNonce:Buffer(4) }) → Buffer(25)`
  - `buildRequest({ fromId:number, toId:number, callId:number, sessId:string(154) }) → Buffer(185)`
  - `parseResponse(buf:Buffer) → { type, flag, fromId, callId, probeNonce:Buffer(4), relayAddr:{ ip:string, port:string } }`
  - `SESSID_LEN = 154`

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-media/__tests__/initzrtp.test.js`:

```js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'initzrtp.js');
const { buildProbe, buildRequest, parseResponse, SESSID_LEN } = require(MOD);

// --- buildProbe: 25-byte layout (§A.3) ---
const nonce = Buffer.from('deadbeef', 'hex');
const probe = buildProbe({ fromId: 0x11223344, callId: 0x0a, probeNonce: nonce });
assert.strictEqual(probe.length, 25, 'probe length');
assert.strictEqual(probe[0], 0x01, 'probe type');
assert.strictEqual(probe[1], 0x7e, 'probe flag');
assert.strictEqual(probe.subarray(2, 10).toString('hex'), '0000000000000000', 'probe reserved');
assert.strictEqual(probe.readUInt32LE(10), 0x11223344, 'probe fromId LE');
assert.strictEqual(probe.subarray(14, 18).toString('hex'), 'deadbeef', 'probe nonce');
assert.strictEqual(probe[18], 0x03, 'probe subtype');
assert.strictEqual(probe[19], 0x00, 'probe pad19');
assert.strictEqual(probe[20], 0x00, 'probe pad20');
assert.strictEqual(probe.readUInt32LE(21), 0x0a, 'probe callId LE');

// --- buildRequest: 185-byte layout (§A.1) ---
const sessId = 'A'.repeat(SESSID_LEN);
const req = buildRequest({ fromId: 0x11223344, toId: 0x55667788, callId: 0x0a, sessId });
assert.strictEqual(req.length, 185, 'request length');
assert.strictEqual(req[0], 0x01, 'req type');
assert.strictEqual(req[1], 0x7e, 'req flag');
assert.strictEqual(req.readUInt32LE(10), 0x11223344, 'req fromId LE');
assert.strictEqual(req[18], 0x0b, 'req subtype');
assert.strictEqual(req[19], 0x00, 'req has-sessId hi');
assert.strictEqual(req[20], 0x02, 'req has-sessId lo');
assert.strictEqual(req.readUInt32LE(21), 0x0a, 'req callId LE');
assert.strictEqual(req.readUInt32LE(25), 0x55667788, 'req toId LE');
assert.strictEqual(req.readUInt16LE(29), 154, 'req sessId len LE');
assert.strictEqual(req.subarray(29, 31).toString('hex'), '9a00', 'req sessId len bytes');
assert.strictEqual(req.subarray(31).toString('ascii'), sessId, 'req sessId ascii');

// bad sessId length -> throw
assert.throws(() => buildRequest({ fromId: 1, toId: 2, callId: 3, sessId: 'short' }), /154/, 'req rejects short sessId');

// --- parseResponse: synthetic §A.2 buffer ---
const addr = '1.2.3.4|5678';
const resp = Buffer.alloc(35 + addr.length);
resp[0] = 0x02; resp[1] = 0x7e;
resp.writeUInt32LE(0x11223344, 10);      // fromId echo
resp[18] = 0x0b; resp[19] = 0x00; resp[20] = 0x02;
resp.writeUInt32LE(0x0a, 25);            // callId echo
nonce.copy(resp, 29);                     // probeNonce echo
resp.writeUInt16LE(addr.length, 33);
resp.write(addr, 35, 'ascii');
const parsed = parseResponse(resp);
assert.strictEqual(parsed.type, 0x02, 'resp type');
assert.strictEqual(parsed.fromId, 0x11223344, 'resp fromId');
assert.strictEqual(parsed.callId, 0x0a, 'resp callId');
assert.strictEqual(parsed.probeNonce.toString('hex'), 'deadbeef', 'resp nonce echo');
assert.deepStrictEqual(parsed.relayAddr, { ip: '1.2.3.4', port: '5678' }, 'resp relayAddr');

// wrong type -> throw
const notResp = Buffer.alloc(40); notResp[0] = 0x01;
assert.throws(() => parseResponse(notResp), /RESPONSE/, 'parseResponse rejects non-0x02');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK initzrtp');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-media/__tests__/initzrtp.test.js`
Expected: FAIL with "Cannot find module '../initzrtp.js'".

- [ ] **Step 3: Write minimal implementation**

Create `tools/zcall-media/initzrtp.js`:

```js
'use strict';
// InitZRTP wire builder/parser (Linux engine, SP2 step 2.1). Format = §A of
// docs/superpowers/decisions/2026-07-13-zcall-initzrtp-and-srtp-profile.md.
// Little-endian ids (revises SP1 Appendix C's tentative big-endian read). No I/O, no crypto.
const SESSID_LEN = 154;

// PROBE — type 0x01, subtype 0x03, 25 bytes (§A.3).
function buildProbe({ fromId, callId, probeNonce }) {
  if (!Buffer.isBuffer(probeNonce) || probeNonce.length !== 4) {
    throw new Error('buildProbe: probeNonce must be a 4-byte Buffer');
  }
  const buf = Buffer.alloc(25);
  buf[0] = 0x01;                       // type
  buf[1] = 0x7e;                       // flag
  buf.writeUInt32LE(fromId >>> 0, 10); // fromId LE
  probeNonce.copy(buf, 14);            // probeNonce
  buf[18] = 0x03;                      // subtype = probe
  buf.writeUInt32LE(callId >>> 0, 21); // callId LE (bytes 19..20 stay zero)
  return buf;
}

// REQUEST — type 0x01, subtype 0x0b, 185 bytes (§A.1).
function buildRequest({ fromId, toId, callId, sessId }) {
  if (typeof sessId !== 'string' || sessId.length !== SESSID_LEN) {
    throw new Error('buildRequest: sessId must be a ' + SESSID_LEN + '-char string, got ' +
      (typeof sessId === 'string' ? sessId.length : typeof sessId));
  }
  const buf = Buffer.alloc(31 + SESSID_LEN); // 185
  buf[0] = 0x01;                       // type
  buf[1] = 0x7e;                       // flag
  buf.writeUInt32LE(fromId >>> 0, 10); // fromId LE
  buf[18] = 0x0b;                      // subtype = InitZRTP
  buf[19] = 0x00; buf[20] = 0x02;      // has-sessId flag/count
  buf.writeUInt32LE(callId >>> 0, 21); // callId LE
  buf.writeUInt32LE(toId >>> 0, 25);   // toId LE
  buf.writeUInt16LE(SESSID_LEN, 29);   // sessId length LE u16 = 0x9a 0x00
  buf.write(sessId, 31, 'ascii');      // sessId
  return buf;
}

// RESPONSE — type 0x02, ~52-55 bytes (§A.2). Returns the relay media address.
function parseResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 35) {
    throw new Error('parseResponse: buffer too short (need >=35, got ' +
      (Buffer.isBuffer(buf) ? buf.length : typeof buf) + ')');
  }
  const type = buf[0];
  if (type !== 0x02) throw new Error('parseResponse: not a RESPONSE (type=0x' + type.toString(16) + ')');
  const flag = buf[1];
  const fromId = buf.readUInt32LE(10);
  const callId = buf.readUInt32LE(25);
  const probeNonce = Buffer.from(buf.subarray(29, 33));
  const addrLen = buf.readUInt16LE(33);
  if (buf.length < 35 + addrLen) throw new Error('parseResponse: truncated address (need ' + (35 + addrLen) + ', got ' + buf.length + ')');
  const ascii = buf.subarray(35, 35 + addrLen).toString('ascii');
  const [ip, port] = ascii.split('|');
  return { type, flag, fromId, callId, probeNonce, relayAddr: { ip, port } };
}

module.exports = { buildProbe, buildRequest, parseResponse, SESSID_LEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-media/__tests__/initzrtp.test.js`
Expected: `OK initzrtp`.

- [ ] **Step 5: Commit** (only if the operator asked to commit)

```bash
git add tools/zcall-media/initzrtp.js tools/zcall-media/__tests__/initzrtp.test.js
git commit -m "zcall SP2 2.1: InitZRTP wire builder/parser (§A, LE, byte-exact tests)"
```

---

### Task 2: UDP handshake sweep (`handshake.js`) + loopback test

**Files:**
- Create: `tools/zcall-media/handshake.js`
- Test: `tools/zcall-media/__tests__/handshake.test.js`

**Interfaces:**
- Consumes: `buildProbe`, `buildRequest`, `parseResponse` from Task 1.
- Produces:
  - `relayHost(server, port=4200) → { host:string, port:number }` — normalizes a `servers[]` entry (string `"ip|port"`/`"ip:port"`/`"ip"` or object `{rtpaddr|rtpIP|host}`) to a host, forcing `port`.
  - `handshake({ fromId, toId, callId, sessId, servers:Array, timeoutMs=3000, relayPort=4200 }) → Promise<Array<{ server, relayAddr:{ip,port}, probeNonce:hexString, rttMs:number }>>` — sends probe+request to each candidate, collects `0x02` replies; never rejects on partial replies.
  - `RELAY_PORT = 4200`

- [ ] **Step 1: Write the failing test**

Create `tools/zcall-media/__tests__/handshake.test.js`:

```js
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

// Fake relay: on request (0x01/0x0b) reply with a 0x02 echoing callId + the probe's nonce.
const RELAY_ADDR = '203.0.113.7|40000';
const relay = dgram.createSocket('udp4');
let lastNonce = Buffer.alloc(4);
relay.on('message', (msg, rinfo) => {
  if (msg[0] === 0x01 && msg[18] === 0x03) {          // probe
    lastNonce = Buffer.from(msg.subarray(14, 18));
  } else if (msg[0] === 0x01 && msg[18] === 0x0b) {   // request
    const callId = msg.readUInt32LE(21);
    const resp = Buffer.alloc(35 + RELAY_ADDR.length);
    resp[0] = 0x02; resp[1] = 0x7e;
    resp[18] = 0x0b; resp[19] = 0x00; resp[20] = 0x02;
    resp.writeUInt32LE(callId, 25);
    lastNonce.copy(resp, 29);
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
  assert.strictEqual(res[0].server, '127.0.0.1', 'server tagged back');
  assert.strictEqual(typeof res[0].rttMs, 'number', 'rtt measured');
  console.log('OK handshake');
})().catch((e) => { relay.close(); console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-media/__tests__/handshake.test.js`
Expected: FAIL with "Cannot find module '../handshake.js'".

- [ ] **Step 3: Write minimal implementation**

Create `tools/zcall-media/handshake.js`:

```js
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
    const targets = servers.map((s) => relayHost(s, relayPort));

    sock.on('error', (e) => { try { sock.close(); } catch (_) {} reject(e); });

    sock.on('message', (msg) => {
      if (msg[0] !== 0x02) return;
      let parsed;
      try { parsed = parseResponse(msg); } catch (_) { return; }
      const nonceHex = parsed.probeNonce.toString('hex');
      const ctx = byNonce.get(nonceHex);
      results.push({
        server: ctx ? ctx.server : null,
        relayAddr: parsed.relayAddr,
        probeNonce: nonceHex,
        rttMs: ctx ? Date.now() - ctx.sentAt : null,
      });
    });

    sock.bind(0, () => {
      for (let i = 0; i < targets.length; i++) {
        const { host, port } = targets[i];
        const nonce = crypto.randomBytes(4);
        byNonce.set(nonce.toString('hex'), { server: servers[i], host, sentAt: Date.now() });
        sock.send(buildProbe({ fromId, callId, probeNonce: nonce }), port, host);
        sock.send(buildRequest({ fromId, toId, callId, sessId }), port, host);
      }
      setTimeout(() => { try { sock.close(); } catch (_) {} resolve(results); }, timeoutMs);
    });
  });
}

module.exports = { handshake, relayHost, RELAY_PORT };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-media/__tests__/handshake.test.js`
Expected: `OK handshake`.

- [ ] **Step 5: Commit** (only if the operator asked to commit)

```bash
git add tools/zcall-media/handshake.js tools/zcall-media/__tests__/handshake.test.js
git commit -m "zcall SP2 2.1: InitZRTP UDP handshake sweep (dgram, loopback-tested)"
```

---

### Task 3: Operator live CLI (`live-handshake.js`) + README

**Files:**
- Create: `tools/zcall-media/live-handshake.js`
- Modify: `tools/zcall-media/CAPTURE-MEDIA-WIN.md` is unrelated — instead append a section to a new/existing `tools/zcall-media/README.md` (create if absent).

**Interfaces:**
- Consumes: `handshake` (Task 2); `invokeRequestCall` from `tools/zcall-signaling/cdp-invoke.js`; `parseConfig` from `tools/zcall-signaling/requestcall.js`.
- Produces: a CLI `node tools/zcall-media/live-handshake.js [<calleeId>]` that prints a redacted summary and exits 0 iff ≥1 relay replied. `main()` exported for reuse.

- [ ] **Step 1: Write the implementation** (no unit test — needs a live account; a dry syntax check stands in)

Create `tools/zcall-media/live-handshake.js`:

```js
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
```

- [ ] **Step 2: Verify it parses (syntax dry check)**

Run: `node --check tools/zcall-media/live-handshake.js`
Expected: no output, exit 0.

- [ ] **Step 3: Write the README section**

Create/append `tools/zcall-media/README.md` with:

````markdown
## InitZRTP handshake (SP2 step 2.1)

Build + send the InitZRTP handshake to a real relay and read back the media address.

- `initzrtp.js` — byte-exact builder/parser (§A of the InitZRTP decision doc). Pure, unit-tested.
- `handshake.js` — `dgram` sweep: probe+request to each `servers[]` candidate on `:4200`, collects
  the `0x02` replies. Loopback-tested.
- `live-handshake.js` — operator CLI. Own account / own phone only.

### Run live (own call)
1. Launch Zalo with remote debugging: `ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux`
2. `node tools/zcall-media/live-handshake.js <yourCalleeId>`
3. Success = `relaysReplied >= 1/N` with a (masked) relay media address. The raw sessId/IP are
   never printed or committed. The returned `relayAddr` is the input to step 2.2 (media).
````

- [ ] **Step 4: Run the full media test suite**

Run: `node tools/zcall-media/__tests__/initzrtp.test.js && node tools/zcall-media/__tests__/handshake.test.js && node tools/zcall-media/__tests__/srtp-decrypt.test.js`
Expected: `OK initzrtp`, `OK handshake`, `OK srtp-decrypt`.

- [ ] **Step 5: Commit** (only if the operator asked to commit)

```bash
git add tools/zcall-media/live-handshake.js tools/zcall-media/README.md
git commit -m "zcall SP2 2.1: live InitZRTP handshake CLI (signaling→handshake, redacted)"
```

---

## Manual live validation (operator, after Task 3)

Not a CI step. Once, on the operator's own account:
1. `ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux`
2. `node tools/zcall-media/live-handshake.js <yourCalleeId>` (your own phone number's uid)
3. Expect `relaysReplied >= 1` and a masked relay media address — proves the Linux-built InitZRTP
   is accepted by the real relay. Record the redacted result (relaysReplied, rtt) in the decision
   doc `2026-07-13-zcall-initzrtp-and-srtp-profile.md`; never commit the raw address.
