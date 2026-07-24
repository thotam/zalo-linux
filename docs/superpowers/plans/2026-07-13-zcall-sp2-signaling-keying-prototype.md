# zcall SP2 — Signaling + Keying Prototype (Linux, live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Node program on Linux that performs a live `voicecall/requestcall` (operator's own account → own phone), decrypts the zpw response, parses the config, and derives `srtpMasterKey = sessId[0:30]`.

**Architecture:** Four focused modules under `tools/zcall-signaling/`: `zpw.js` (AES-128-CBC IV=0 codec), `requestcall.js` (build request / parse config / keying), `cdp-extract.js` (Chrome-DevTools-Protocol client that pulls `secretKey` + cookies + one real requestcall sample out of the running Linux Zalo), and `prototype.js` (orchestrator). Pure crypto/parse/keying are golden-vector unit-tested with Node's own `crypto` as the reference; the CDP + live-fetch parts are validated by one real run.

**Tech Stack:** Node.js (CommonJS), built-in `crypto` (aes-128-cbc), built-in global `WebSocket` (Node 22+/24) + `fetch` for CDP and the live HTTPS call, `assert`-based tests.

## Global Constraints

- **Own account, own machine, own traffic only; call is operator → operator's OWN phone; minimum requests; replicate exactly what the app does.** (Spec §ToS.)
- **Per-call `sessId`/keys/cookies are ephemeral secrets — never print raw, never commit; committed samples/vectors are redacted.** (Spec §ToS.)
- **zpw crypto (verbatim from the bundle):** AES-128-CBC, PKCS7, IV = 16 zero bytes, key = `Base64.decode(secretKey)` (16 bytes). (Spec §4a.)
- **SRTP master key = the first 30 bytes of `sessId`** (16 key + 14 salt), raw ASCII. (Spec §keying.)
- **This step builds NO media engine, no UDP, no libsrtp, no `secretKey` derivation from `zcid`/`zcid_ext`.** (Spec §Out of scope.)
- **No `Co-Authored-By` / AI-attribution** in commit messages (repo rule).
- Tests are `assert`-based, runnable with plain `node <file>`; pure modules pass `node --check`.

---

## File Structure

- `tools/zcall-signaling/zpw.js` (Create) — `encode(objOrStr, secretKey)`, `decodeToString(cipherB64, secretKey)`.
- `tools/zcall-signaling/requestcall.js` (Create) — `parseConfig(jsonStr)`, `srtpMasterKey(sessId)`, `buildRequestUrl({sampleUrl, sampleParamsPlain, secretKey, overrides})`.
- `tools/zcall-signaling/cdp-extract.js` (Create) — `cookieHeader(cookies)`, `findGetSecretKeyLocation(src)` (pure helpers, tested) + `extract(opts)` (live CDP).
- `tools/zcall-signaling/prototype.js` (Create) — `summarize(config, keyBuf)` (pure, tested) + `main()` (live orchestrator).
- `tools/zcall-signaling/__tests__/zpw.test.js` (Create)
- `tools/zcall-signaling/__tests__/requestcall.test.js` (Create)
- `tools/zcall-signaling/__tests__/cdp-extract.test.js` (Create)
- `tools/zcall-signaling/__tests__/prototype.test.js` (Create)
- `tools/zcall-signaling/README.md` (Create in Task 4) — remote-debug enablement + run steps.

---

## Task 1: `zpw.js` — the AES-128-CBC/IV0 codec

**Files:**
- Create: `tools/zcall-signaling/zpw.js`
- Test: `tools/zcall-signaling/__tests__/zpw.test.js`

**Interfaces:**
- Produces:
  - `encode(objOrStr: object|string, secretKey: string): string` — JSON-stringifies an object (passes a string through), AES-128-CBC/IV0/PKCS7 encrypts with `Buffer.from(secretKey,'base64')`, returns base64 ciphertext.
  - `decodeToString(cipherB64: string, secretKey: string): string` — `decodeURIComponent` → base64-decode → AES decrypt → UTF-8 string (the caller JSON-parses).

- [ ] **Step 1: Write the failing test** (uses Node's own `crypto` as the independent reference)

```js
// tools/zcall-signaling/__tests__/zpw.test.js
const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'zpw.js');
const { encode, decodeToString } = require(MOD);

const secretKey = Buffer.alloc(16, 7).toString('base64'); // 16-byte AES-128 key, base64
const key = Buffer.from(secretKey, 'base64');
const iv = Buffer.alloc(16, 0);
const plain = JSON.stringify({ hello: 'world', n: 42 });

// reference ciphertext produced by Node crypto directly
const ref = crypto.createCipheriv('aes-128-cbc', key, iv);
const refCipher = Buffer.concat([ref.update(plain, 'utf8'), ref.final()]).toString('base64');

// encode matches the reference
assert.strictEqual(encode(plain, secretKey), refCipher, 'encode == node reference');
// decodeToString inverts the reference ciphertext
assert.strictEqual(decodeToString(refCipher, secretKey), plain, 'decode inverts reference');
// round-trip on an object
assert.strictEqual(decodeToString(encode({ a: 1 }, secretKey), secretKey), JSON.stringify({ a: 1 }), 'round-trip');
// tolerates url-encoding on input
assert.strictEqual(decodeToString(encodeURIComponent(refCipher), secretKey), plain, 'url-encoded input');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK zpw');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-signaling/__tests__/zpw.test.js`
Expected: FAIL — `Cannot find module '.../zpw.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-signaling/zpw.js
'use strict';
// zpw cipher — Zalo API param/response crypto. Verbatim from the app bundle:
// AES-128-CBC, PKCS7, IV = 16 zero bytes, key = Base64.decode(secretKey). (GO verdict §4a.)
const crypto = require('crypto');

function keyBuf(secretKey) {
  const k = Buffer.from(secretKey, 'base64');
  if (k.length !== 16) throw new Error('zpw: secretKey must decode to 16 bytes, got ' + k.length);
  return k;
}

function encode(objOrStr, secretKey) {
  const pt = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
  const c = crypto.createCipheriv('aes-128-cbc', keyBuf(secretKey), Buffer.alloc(16, 0));
  return Buffer.concat([c.update(pt, 'utf8'), c.final()]).toString('base64');
}

function decodeToString(cipherB64, secretKey) {
  const input = Buffer.from(decodeURIComponent(cipherB64), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', keyBuf(secretKey), Buffer.alloc(16, 0));
  return Buffer.concat([d.update(input), d.final()]).toString('utf8');
}

module.exports = { encode, decodeToString };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-signaling/__tests__/zpw.test.js`
Expected: `OK zpw`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-signaling/zpw.js tools/zcall-signaling/__tests__/zpw.test.js
git commit -m "zcall SP2: zpw AES-128-CBC/IV0 codec (encode/decode signaling)"
```

---

## Task 2: `requestcall.js` — parse config, keying, build request

**Files:**
- Create: `tools/zcall-signaling/requestcall.js`
- Test: `tools/zcall-signaling/__tests__/requestcall.test.js`

**Interfaces:**
- Consumes: `zpw.encode` (Task 1).
- Produces:
  - `parseConfig(jsonStr: string): object` — `JSON.parse`; asserts `sessId` is a 154-char string and `servers` is a non-empty array (fail loud otherwise). Returns the parsed config.
  - `srtpMasterKey(sessId: string): Buffer` — the first 30 raw ASCII bytes of `sessId` (16 key + 14 salt). Throws if `sessId.length < 30`.
  - `buildRequestUrl({sampleUrl, sampleParamsPlain, secretKey, overrides}): string` — takes the URL + decrypted params object of a real captured requestcall, applies `overrides` (e.g. a fresh `callId`), re-encrypts the params with `zpw.encode`, and returns the full URL with the `params=` query value replaced by the re-encrypted (URL-encoded) ciphertext.

- [ ] **Step 1: Write the failing test**

```js
// tools/zcall-signaling/__tests__/requestcall.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'requestcall.js');
const { parseConfig, srtpMasterKey, buildRequestUrl } = require(MOD);
const { decodeToString } = require(path.join(__dirname, '..', 'zpw.js'));

// srtpMasterKey = first 30 ASCII bytes of sessId
const sess = 'A'.repeat(154);
const key = srtpMasterKey(sess);
assert.ok(Buffer.isBuffer(key) && key.length === 30, '30-byte key');
assert.strictEqual(key.toString('ascii'), 'A'.repeat(30), 'first 30 chars');
assert.throws(() => srtpMasterKey('short'), /30/, 'too-short sessId throws');

// parseConfig validates sessId length + servers
const good = JSON.stringify({ sessId: sess, servers: [{ rtpaddr: '1.2.3.4:4200' }], changeZRTP: { enable: 0 } });
const cfg = parseConfig(good);
assert.strictEqual(cfg.sessId.length, 154, 'sessId parsed');
assert.strictEqual(cfg.changeZRTP.enable, 0, 'changeZRTP parsed');
assert.throws(() => parseConfig(JSON.stringify({ sessId: 'x', servers: [] })), /sessId|servers/, 'bad config throws');

// buildRequestUrl re-encrypts params with overrides, keeps other query keys
const secretKey = Buffer.alloc(16, 7).toString('base64');
const sampleUrl = 'https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?zpw_ver=1&zpw_type=2&params=OLDCIPHER';
const url = buildRequestUrl({ sampleUrl, sampleParamsPlain: { calleeId: '111', callId: 10, imei: 'x' }, secretKey, overrides: { callId: 99 } });
assert.ok(url.startsWith('https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?'), 'base url kept');
assert.ok(url.includes('zpw_ver=1') && url.includes('zpw_type=2'), 'other query kept');
const m = url.match(/[?&]params=([^&]+)/);
assert.ok(m, 'params present');
const decoded = JSON.parse(decodeToString(m[1], secretKey));
assert.strictEqual(decoded.callId, 99, 'override applied');
assert.strictEqual(decoded.calleeId, '111', 'sample field kept');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK requestcall');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-signaling/__tests__/requestcall.test.js`
Expected: FAIL — `Cannot find module '.../requestcall.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-signaling/requestcall.js
'use strict';
// requestcall config parsing + SRTP keying + request builder. (GO verdict §1, §3.)
const zpw = require('./zpw.js');

function parseConfig(jsonStr) {
  const cfg = JSON.parse(jsonStr);
  if (typeof cfg.sessId !== 'string' || cfg.sessId.length !== 154) {
    throw new Error('requestcall: expected 154-char sessId, got ' + (cfg.sessId && cfg.sessId.length));
  }
  if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
    throw new Error('requestcall: expected non-empty servers[]');
  }
  return cfg;
}

// SRTP master key = first 30 raw ASCII bytes of sessId (16-byte AES-128 key + 14-byte salt).
function srtpMasterKey(sessId) {
  if (typeof sessId !== 'string' || sessId.length < 30) {
    throw new Error('requestcall: sessId too short for a 30-byte master key');
  }
  return Buffer.from(sessId.slice(0, 30), 'ascii');
}

// Rebuild a requestcall URL from a captured sample: apply overrides, re-encrypt params.
function buildRequestUrl({ sampleUrl, sampleParamsPlain, secretKey, overrides }) {
  const u = new URL(sampleUrl);
  const params = Object.assign({}, sampleParamsPlain, overrides || {});
  u.searchParams.set('params', zpw.encode(params, secretKey));
  return u.toString();
}

module.exports = { parseConfig, srtpMasterKey, buildRequestUrl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-signaling/__tests__/requestcall.test.js`
Expected: `OK requestcall`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-signaling/requestcall.js tools/zcall-signaling/__tests__/requestcall.test.js
git commit -m "zcall SP2: requestcall config parse + sessId[0:30] keying + request builder"
```

---

## Task 3: `cdp-extract.js` — pull secretKey + cookies + a real requestcall sample

**Files:**
- Create: `tools/zcall-signaling/cdp-extract.js`
- Test: `tools/zcall-signaling/__tests__/cdp-extract.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (returns raw material for `prototype.js`).
- Produces (pure helpers, unit-tested):
  - `cookieHeader(cookies: Array<{name,value}>): string` — `"a=b; c=d"`.
  - `findGetSecretKeyReturn(src: string): {line: number, column: number} | null` — locates the `return le` inside `getSecretKey(){return le` in a bundle source string, as 0-based `{line, column}` (for `Debugger.setBreakpoint`).
- Produces (live):
  - `async extract({port=9222, bundleUrlRe}): {secretKey, cookieHeader, sampleUrl, sampleParamsPlain}` — connects to CDP, breakpoints `getSecretKey` to read `le`, reads cookies for the voicecall host, and captures one real `requestcall` (operator clicks call once) to get `sampleUrl` + decrypted params.

- [ ] **Step 1: Write the failing test** (pure helpers only — the live `extract` is validated by a real run in Task 4)

```js
// tools/zcall-signaling/__tests__/cdp-extract.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'cdp-extract.js');
const { cookieHeader, findGetSecretKeyReturn } = require(MOD);

assert.strictEqual(cookieHeader([{ name: 'a', value: 'b' }, { name: 'c', value: 'd' }]), 'a=b; c=d', 'cookie header');
assert.strictEqual(cookieHeader([]), '', 'empty cookies');

// findGetSecretKeyReturn: locate "return le" inside getSecretKey on the correct line
const src = 'line0;\nfoo(){}static getSecretKey(){return le||bar(),le}baz();';
const loc = findGetSecretKeyReturn(src);
assert.ok(loc && loc.line === 1, 'found on line 1');
assert.ok(typeof loc.column === 'number' && loc.column > 0, 'has a column');
assert.strictEqual(findGetSecretKeyReturn('no match here'), null, 'null when absent');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK cdp-extract');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-signaling/__tests__/cdp-extract.test.js`
Expected: FAIL — `Cannot find module '.../cdp-extract.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-signaling/cdp-extract.js
'use strict';
// CDP client: pull the zpw secretKey (breakpoint on getSecretKey), the voicecall-host cookies,
// and one real requestcall sample out of the running Linux Zalo. Live parts need Zalo launched
// with --remote-debugging-port. (GO verdict §5.3; own account/own machine only.)
const zpw = require('./zpw.js');

function cookieHeader(cookies) {
  return (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
}

// Locate the `return le` inside `getSecretKey(){return le...` as 0-based {line,column}.
function findGetSecretKeyReturn(src) {
  const idx = src.indexOf('getSecretKey(){return ');
  if (idx < 0) return null;
  const retIdx = src.indexOf('return ', idx);
  const before = src.slice(0, retIdx);
  const line = before.split('\n').length - 1;
  const column = retIdx - (before.lastIndexOf('\n') + 1);
  return { line, column };
}

// --- live CDP (integration; not unit-tested — validated by a real run) ---
async function extract({ port = 9222, bundleUrlRe = /default-login-main-startup.*\.js$/, voicecallHost = 'https://voicecall-wpa.chat.zalo.me/' } = {}) {
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('cdp-extract: no debuggable page target — launch Zalo with --remote-debugging-port=' + port + ' --remote-allow-origins=*');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp-extract: WS connect failed')); });

  let id = 0; const pending = new Map(); const scripts = new Map(); let paused = null;
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Debugger.scriptParsed' && bundleUrlRe.test(m.params.url || '')) scripts.set(m.params.scriptId, m.params.url);
    if (m.method === 'Debugger.paused') paused = m.params;
    events.push(m);
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });

  await send('Debugger.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');

  // 1. secretKey via a breakpoint on getSecretKey.
  //    Find the bundle script, get its source, locate `return le`, set a breakpoint, wait for a hit.
  await new Promise((r) => setTimeout(r, 500)); // let scriptParsed events arrive
  let secretKey = null;
  for (const [scriptId] of scripts) {
    const { result } = await send('Debugger.getScriptSource', { scriptId });
    const loc = findGetSecretKeyReturn(result.scriptSource || '');
    if (!loc) continue;
    await send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: loc.line, columnNumber: loc.column } });
    break;
  }
  console.error('[cdp-extract] breakpoint armed on getSecretKey — the app calls it constantly; waiting…');
  for (let i = 0; i < 200 && !paused; i++) await new Promise((r) => setTimeout(r, 100));
  if (!paused) throw new Error('cdp-extract: getSecretKey breakpoint never hit');
  const frame = paused.callFrames[0];
  const evalRes = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'le' });
  secretKey = evalRes.result && evalRes.result.value;
  await send('Debugger.resume');
  await send('Debugger.disable');
  if (!secretKey) throw new Error('cdp-extract: could not read secretKey (le) from getSecretKey frame');

  // 2. cookies for the voicecall host.
  const { result: ck } = await send('Network.getCookies', { urls: [voicecallHost] });
  const cookies = cookieHeader(ck.cookies);

  // 3. capture one real requestcall (operator clicks call once).
  console.error('[cdp-extract] now place ONE real call in Zalo to your own phone (captures the request shape)…');
  let sampleUrl = null;
  for (let i = 0; i < 600 && !sampleUrl; i++) {
    const e = events.find((x) => x.method === 'Network.requestWillBeSent' && /voicecall\/requestcall/.test(x.params.request.url));
    if (e) sampleUrl = e.params.request.url;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!sampleUrl) throw new Error('cdp-extract: no requestcall observed — did you place a call?');
  const paramsCipher = new URL(sampleUrl).searchParams.get('params');
  const sampleParamsPlain = JSON.parse(zpw.decodeToString(paramsCipher, secretKey));

  ws.close();
  return { secretKey, cookieHeader: cookies, sampleUrl, sampleParamsPlain };
}

module.exports = { cookieHeader, findGetSecretKeyReturn, extract };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-signaling/__tests__/cdp-extract.test.js`
Expected: `OK cdp-extract`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-signaling/cdp-extract.js tools/zcall-signaling/__tests__/cdp-extract.test.js
git commit -m "zcall SP2: CDP extractor (secretKey breakpoint + cookies + requestcall sample)"
```

---

## Task 4: `prototype.js` orchestrator + README

**Files:**
- Create: `tools/zcall-signaling/prototype.js`
- Create: `tools/zcall-signaling/README.md`
- Test: `tools/zcall-signaling/__tests__/prototype.test.js`

**Interfaces:**
- Consumes: `cdp-extract.extract`, `requestcall.{buildRequestUrl,parseConfig,srtpMasterKey}`, `zpw.decodeToString`.
- Produces:
  - `summarize(config: object, keyBuf: Buffer): object` — a **redacted** summary: `{ sessIdLen, keyLen, servers: [<addr…>], changeZRTP: config.changeZRTP, fromId, toId }` (never the raw sessId or key bytes).
  - `main()` — the live orchestrator (extract → build → fetch → decode → parse → key → print `summarize`).

- [ ] **Step 1: Write the failing test** (pure `summarize` only)

```js
// tools/zcall-signaling/__tests__/prototype.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'prototype.js');
const { summarize } = require(MOD);

const cfg = { sessId: 'S'.repeat(154), servers: [{ rtpaddr: '1.2.3.4:4200' }], changeZRTP: { enable: 0 }, fromId: 1, toId: 2 };
const out = summarize(cfg, Buffer.alloc(30, 9));
assert.strictEqual(out.sessIdLen, 154, 'sessId length only');
assert.strictEqual(out.keyLen, 30, 'key length only');
assert.deepStrictEqual(out.servers, ['1.2.3.4:4200'], 'server addrs');
assert.strictEqual(out.changeZRTP.enable, 0, 'changeZRTP passed');
// never leaks raw secrets
assert.ok(!JSON.stringify(out).includes('S'.repeat(154)), 'no raw sessId');
assert.ok(!JSON.stringify(out).includes('09090909'), 'no raw key bytes');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK prototype');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-signaling/__tests__/prototype.test.js`
Expected: FAIL — `Cannot find module '.../prototype.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-signaling/prototype.js
'use strict';
// SP2 step-1 orchestrator: standalone Linux program that obtains a real requestcall config +
// derives the SRTP master key. Live; own account/own phone only. Prints a REDACTED summary.
const zpw = require('./zpw.js');
const { buildRequestUrl, parseConfig, srtpMasterKey } = require('./requestcall.js');
const { extract } = require('./cdp-extract.js');

function summarize(config, keyBuf) {
  return {
    sessIdLen: config.sessId ? config.sessId.length : 0,
    keyLen: keyBuf ? keyBuf.length : 0,
    servers: (config.servers || []).map((s) => s.rtpaddr).filter(Boolean),
    changeZRTP: config.changeZRTP,
    fromId: config.fromId,
    toId: config.toId,
  };
}

async function main() {
  const { secretKey, cookieHeader, sampleUrl, sampleParamsPlain } = await extract({});
  // Re-issue requestcall to the SAME callee (your own phone) with a fresh callId.
  const overrides = { callId: (Number(sampleParamsPlain.callId) || 0) + 1 };
  const url = buildRequestUrl({ sampleUrl, sampleParamsPlain, secretKey, overrides });
  const resp = await fetch(url, { headers: { cookie: cookieHeader } });
  if (!resp.ok) throw new Error('requestcall HTTP ' + resp.status);
  const body = await resp.json();
  const cipher = body && body.data;
  if (!cipher) throw new Error('requestcall: no .data ciphertext in response: ' + JSON.stringify(body).slice(0, 200));
  const config = parseConfig(zpw.decodeToString(cipher, secretKey));
  const key = srtpMasterKey(config.sessId);
  console.log(JSON.stringify(summarize(config, key), null, 2));
  console.error('[prototype] OK — obtained real config + 30-byte SRTP master key on Linux.');
}

if (require.main === module) main().catch((e) => { console.error('[prototype] FAILED:', e.message); process.exit(1); });

module.exports = { summarize, main };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-signaling/__tests__/prototype.test.js`
Expected: `OK prototype`.

- [ ] **Step 5: Write the README (remote-debug enablement + run steps)**

Create `tools/zcall-signaling/README.md`:

```markdown
# zcall-signaling — SP2 step 1 (Linux live signaling + keying)

Standalone Node proof that Linux can obtain a real call config + SRTP master key from the
operator's own account. **Own account / own machine / own phone only.** Never commit real
`sessId`/key/cookie values.

## 1. Launch Zalo Linux with remote debugging
    zalo --remote-debugging-port=9222 --remote-allow-origins=*
If the Electron fuse `EnableNodeCliInspectArguments` is OFF, the flag is ignored — rebuild with
the fuse on, or launch the unpacked Electron with the flag. Verify: `curl http://127.0.0.1:9222/json`
returns a target list.

## 2. Run the prototype (needs Node 22+ for global WebSocket/fetch)
    node tools/zcall-signaling/prototype.js
- It arms a breakpoint on `getSecretKey` (fires automatically — the app calls it constantly).
- When it prints "now place ONE real call", call **your own phone** from Zalo once (this
  captures the exact request shape). It then re-issues one requestcall and prints a summary.

## Expected output (redacted)
    { "sessIdLen": 154, "keyLen": 30, "servers": ["<ip>:4200", …], "changeZRTP": {"enable":0}, ... }

`sessIdLen 154` + `keyLen 30` + `servers :4200` + `changeZRTP.enable 0` = success: Linux
obtained the real config and derived `srtpMasterKey = sessId[0:30]`. Feeds SP2 step 2 (media).

## Tests
    for t in tools/zcall-signaling/__tests__/*.test.js; do node "$t"; done
```

- [ ] **Step 6: Commit**

```bash
git add tools/zcall-signaling/prototype.js tools/zcall-signaling/README.md tools/zcall-signaling/__tests__/prototype.test.js
git commit -m "zcall SP2: live orchestrator + README (Linux obtains real config + sessId[0:30])"
```

---

## Task 5: Live run (manual, operator) + record result

**Files:** none (a real run + a short note).

**Context:** Automatable code is done in Tasks 1–4; this is the live validation on the operator's Linux machine with their own account. Not automatable here.

- [ ] **Step 1: Enable remote debugging + run** per `tools/zcall-signaling/README.md`.
- [ ] **Step 2: Confirm success** — the operator's phone rings and the output shows `sessIdLen:154`, `keyLen:30`, `servers` on `:4200`, `changeZRTP.enable:0`.
- [ ] **Step 3: Record** the (redacted) summary in the GO verdict doc's roadmap section as "step 1 done on Linux", and note any request-shape surprises (extra params, header requirements) for step 2.

---

## Notes

- If `fetch` returns a non-200 or a `.data`-less body, the request likely needs extra headers
  the app sends (user-agent, `viewerkey`, etc.). Capture the app's real requestcall **response**
  too (CDP `Network.getResponseBody`) to compare — but that is a refinement, not a redesign.
- Next step (separate plan): SP2 step 2 — libsrtp + RTP/UDP loop to relay `:4200` + the InitZRTP
  UDP token exchange (SP1 Appendix C + `tools/zcall-re/parse-zrtppacket.js`), consuming this
  step's `config` + `srtpMasterKey`.
