# zcall SP2.0 — ZRTP Keying Gate Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the capture + analysis tooling that classifies where Zalo's SRTP/ZRTC keying comes from, to produce an evidence-backed GO/NO-GO on the SP2–SP6 engine build.

**Architecture:** Extend the existing Linux call diagnostics (main-process `call-diag.js` + the renderer-injected `patch-call-trace.js` probes) to dump, in plaintext at the JS/IPC boundary, the `setConfig`-equivalent payloads the app hands toward native and the app's own HTTP to the voicecall/config hosts — during a real 1-1 call the user places to their own phone. Offline pure-function tooling then parses, redacts, and classifies those captures into keying-class (a)/(b)/(c)/(d). A parallel wide-value loopback capture (CI, reusing the SP1 harness) locks the REQUEST wire format.

**Tech Stack:** Node.js (CommonJS), Electron 39 main process (`webContents.debugger` CDP Network domain), the existing `tools/zcall-re/` harness (Node 8 / ABI-57 on a macOS GitHub Actions runner), `assert`-based unit tests run under plain `node`.

## Global Constraints

- **Own account only; passive observation of the app's own traffic only.** No third party; no attack/probe of Zalo infrastructure beyond what the app itself does with the user's own login; no decryption of any other user's traffic. (Spec §ToS.)
- **No TLS interception (no MITM).** All capture is at the JS/IPC/CDP boundary where the data is already plaintext.
- **This scout builds nothing shippable** — no WebRTC, no media I/O, no ZRTC transport, no state machine, no media decrypt/render. (Spec §Objective.)
- **Captured keying material stays local.** Any sample committed to the repo must be redacted (real ids/keys/tokens → placeholders). (Spec §ToS.)
- **No `Co-Authored-By` / AI-attribution lines** in any commit message (repo rule).
- Tests are `assert`-based Node scripts runnable with plain `node <file>` (match `scripts/patches/__tests__/call-diag.test.js`); pure functions must also pass `node --check`.
- Diagnostics-only patches (`patch-call-trace.js`, `patch-zcall-linux-stub.js`, `patch-call-diagnostics.js`) are wired in `scripts/main.js` and must remain removable before any release.

---

## File Structure

- `tools/zcall-re/capture-utils.js` (Create) — offline pure helpers: parse `[CALLDIAG-PAYLOAD]` log lines, redact secrets. Used by the analyzer + sample prep. No Electron.
- `tools/zcall-re/classify-keying.js` (Create) — offline pure `classifyKeying(payloads)` → keying-class + signals; CLI wrapper to run over a captured log.
- `tools/zcall-re/__tests__/capture-utils.test.js` (Create) — unit tests for capture-utils.
- `tools/zcall-re/__tests__/classify-keying.test.js` (Create) — unit tests for classify-keying.
- `scripts/patches/patch-call-trace.js` (Modify) — extend the `sendToNative` / `callMainInit` probes to dump the full IPC payload as `[CALLDIAG-PAYLOAD] <tag> <json>`.
- `scripts/patches/__tests__/patch-call-trace.test.js` (Create) — unit test the extended patch (applies, payload probes present, idempotent, fail-loud).
- `scripts/patches/data/call-diag.js` (Modify) — add `isCallHost(url)` pure matcher + a main-process CDP Network tap that logs request/response bodies for call/config hosts.
- `scripts/patches/__tests__/call-diag.test.js` (Modify) — add `isCallHost` assertions to the existing test.
- `tools/zcall-re/harness.js` (Modify) — parameterize `fromId`/`toId`/`callId`/`sessId` via env (`resolveIds(env)` pure helper) for the wide-value loopback capture.
- `tools/zcall-re/__tests__/harness-ids.test.js` (Create) — unit test `resolveIds`.
- `.github/workflows/zcall-capture.yml` (Modify) — pass wide-value ids into the `MODE=call` run.
- `docs/superpowers/decisions/2026-XX-XX-zcall-zrtp-keying-verdict.md` (Create in Task 6) — the GO/NO-GO decision doc, written from a real capture.

---

## Task 1: Offline capture-utils (parse + redact)

**Files:**
- Create: `tools/zcall-re/capture-utils.js`
- Test: `tools/zcall-re/__tests__/capture-utils.test.js`

**Interfaces:**
- Produces:
  - `parsePayloadLines(logText: string): Array<{tag: string, obj: any, raw: string}>` — extracts every `[CALLDIAG-PAYLOAD] <tag> <json>` occurrence from a diag-log's console messages, JSON-parsing the payload (skips lines whose payload isn't valid JSON, keeping `obj: null`).
  - `redactSecrets(obj: any): any` — deep-clones `obj`, replacing the values of known-sensitive keys (case-insensitive: `sessId`, `session`, `token`, `key`, `secret`, `srtpKey`, `masterKey`, `salt`, `auth`, `password`) with `"<redacted:<len>>"`, and long (≥24-char) base64-ish string values anywhere with `"<redacted:base64:<len>>"`.

- [ ] **Step 1: Write the failing test**

```js
// tools/zcall-re/__tests__/capture-utils.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'capture-utils.js');
const { parsePayloadLines, redactSecrets } = require(MOD);

// parsePayloadLines: pulls tag + parsed JSON out of diag CONSOLE lines.
const log = [
  '2026-01-01T00:00:00.000Z [browser] CONSOLE {"type":"window","level":3,"message":"[CALLDIAG-PAYLOAD] sendToNative {\\"sessId\\":\\"abc\\",\\"servers\\":[1]}","line":1,"source":"x"}',
  '2026-01-01T00:00:01.000Z [browser] CONSOLE {"type":"window","level":3,"message":"[CALLDIAG-PAYLOAD] callMainInit not-json","line":1,"source":"x"}',
  'unrelated line',
].join('\n');
const parsed = parsePayloadLines(log);
assert.strictEqual(parsed.length, 2, 'two payload lines');
assert.strictEqual(parsed[0].tag, 'sendToNative');
assert.deepStrictEqual(parsed[0].obj, { sessId: 'abc', servers: [1] });
assert.strictEqual(parsed[1].tag, 'callMainInit');
assert.strictEqual(parsed[1].obj, null, 'unparseable payload -> null');

// redactSecrets: masks sensitive keys + long base64-ish strings, keeps structure.
const red = redactSecrets({ sessId: 'abc', callId: 10, nested: { token: 'xyz', keep: 'ok' }, blob: 'A'.repeat(40) });
assert.strictEqual(red.callId, 10, 'non-secret kept');
assert.strictEqual(red.nested.keep, 'ok', 'non-secret nested kept');
assert.ok(/^<redacted:/.test(red.sessId), 'sessId redacted');
assert.ok(/^<redacted:/.test(red.nested.token), 'token redacted');
assert.ok(/^<redacted:base64:/.test(red.blob), 'long base64-ish redacted');
// input not mutated
assert.strictEqual(typeof redactSecrets, 'function');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK capture-utils');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-re/__tests__/capture-utils.test.js`
Expected: FAIL — `Cannot find module '.../capture-utils.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-re/capture-utils.js
'use strict';
// Offline analysis helpers for SP2.0 keying-capture logs. Pure; no Electron.

const SECRET_KEYS = ['sessid', 'session', 'token', 'key', 'secret', 'srtpkey', 'masterkey', 'salt', 'auth', 'password'];
const BASE64ISH = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;

function parsePayloadLines(logText) {
  const out = [];
  const CONSOLE = '] CONSOLE ';
  const TAG = '[CALLDIAG-PAYLOAD] ';
  for (const line of String(logText).split('\n')) {
    // Diag lines wrap the console message as JSON after "] CONSOLE ": {"...","message":"<msg>",...}
    let msg = null;
    const ci = line.indexOf(CONSOLE);
    if (ci >= 0) {
      try { msg = JSON.parse(line.slice(ci + CONSOLE.length)).message; } catch (_) { msg = null; }
    }
    // Also accept a bare (non-wrapped) "[CALLDIAG-PAYLOAD] ..." line.
    if (msg == null && line.indexOf(TAG) >= 0) msg = line.slice(line.indexOf(TAG));
    if (msg == null) continue;
    const pi = msg.indexOf(TAG);
    if (pi < 0) continue;
    const rest = msg.slice(pi + TAG.length);
    const sp = rest.indexOf(' ');
    const tag = sp < 0 ? rest : rest.slice(0, sp);
    const raw = sp < 0 ? '' : rest.slice(sp + 1);
    let obj = null;
    try { obj = JSON.parse(raw); } catch (_) { obj = null; }
    out.push({ tag, obj, raw });
  }
  return out;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SECRET_KEYS.indexOf(k.toLowerCase()) >= 0) {
        const v = value[k];
        out[k] = '<redacted:' + (typeof v === 'string' ? v.length : String(v).length) + '>';
      } else {
        out[k] = redactSecrets(value[k]);
      }
    }
    return out;
  }
  if (typeof value === 'string' && BASE64ISH.test(value)) return '<redacted:base64:' + value.length + '>';
  return value;
}

module.exports = { parsePayloadLines, redactSecrets };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-re/__tests__/capture-utils.test.js`
Expected: `OK capture-utils`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-re/capture-utils.js tools/zcall-re/__tests__/capture-utils.test.js
git commit -m "zcall SP2.0: offline capture-utils (parse payload lines + redact secrets)"
```

---

## Task 2: Extend call-trace probes to dump IPC payloads

**Files:**
- Modify: `scripts/patches/patch-call-trace.js`
- Test: `scripts/patches/__tests__/patch-call-trace.test.js` (Create)

**Interfaces:**
- Consumes: the existing `PROBES` array and `patchOne(file)` in `patch-call-trace.js`.
- Produces: after patching, the running bundle's `_sendToNative(e){...}` and `_callMainInit(e){...}` emit `console.error("[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e))` (and `callMainInit`) — the plaintext `setConfig`-equivalent payload, captured by the main-process CONSOLE hook. `[CALLDIAG] sendToNative` / `[CALLDIAG] callMainInit` reach-probes are preserved.

**Context:** `patch-call-trace.js` currently replaces `_sendToNative(e){` with `_sendToNative(e){try{console.error("[CALLDIAG] sendToNative")}catch(_e){}` (a reach-probe with no payload). This task upgrades those two entries to also serialize `e`. The `MARKER` used for idempotency is `[CALLDIAG] videoCall-click` (unchanged); add payload dumps as new probe entries keyed off the same anchors, guarded so re-runs don't double-insert.

- [ ] **Step 1: Write the failing test**

```js
// scripts/patches/__tests__/patch-call-trace.test.js
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zct-'));
const repo = path.join(tmp, 'repo');
const pc = path.join(repo, 'app', 'pc-dist');
fs.ensureDirSync(pc);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.ensureDirSync(path.join(repo, 'scripts', 'patches'));

// Minimal bundle carrying the anchors the patch targets.
const BUNDLE =
  'x();this._videoCall=async(e=!0,t=null)=>{const n=await this._getFullInfoConversation();' +
  'if(!j.d.isSupport())return;if(j.d.isCalling())return;let a=t;' +
  ';j.d.makeCall(t,e,i,(e=>{q(e)}));' +
  '_sendToNative(e){this.x(),$zcall.sendDataToNative(e)}' +
  '_callMainInit(e){$zcall.initCall(e)}';
fs.writeFileSync(path.join(pc, 'compact-app-pc.abc.js'), BUNDLE, 'utf8');

fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-call-trace.js'), path.join(repo, 'scripts', 'patches', 'patch-call-trace.js'));
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

const { main } = require(path.join(repo, 'scripts', 'patches', 'patch-call-trace.js'));

(async () => {
  await main();
  const s = fs.readFileSync(path.join(pc, 'compact-app-pc.abc.js'), 'utf8');
  // reach-probes still present
  assert.ok(s.includes('[CALLDIAG] videoCall-click'), 'videoCall-click reach probe');
  assert.ok(s.includes('[CALLDIAG] sendToNative'), 'sendToNative reach probe');
  // payload dumps present with JSON.stringify of the arg
  assert.ok(s.includes('[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e)'), 'sendToNative payload dump');
  assert.ok(s.includes('[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e)'), 'callMainInit payload dump');
  // idempotent
  await main();
  const s2 = fs.readFileSync(path.join(pc, 'compact-app-pc.abc.js'), 'utf8');
  assert.strictEqual(s, s2, 'idempotent');
  assert.strictEqual((s2.match(/\[CALLDIAG-PAYLOAD\] sendToNative/g) || []).length, 1, 'single payload dump');
  fs.removeSync(tmp);
  console.log('OK patch-call-trace');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/patch-call-trace.test.js`
Expected: FAIL — `sendToNative payload dump` assertion (payload dumps not present yet).

- [ ] **Step 3: Write minimal implementation**

In `scripts/patches/patch-call-trace.js`, replace the two probe entries for `_sendToNative(e){` and `_callMainInit(e){` in the `PROBES` array with payload-dumping versions:

```js
  [
    '_sendToNative(e){',
    '_sendToNative(e){try{console.error("[CALLDIAG] sendToNative");console.error("[CALLDIAG-PAYLOAD] sendToNative "+JSON.stringify(e))}catch(_e){}',
  ],
  [
    '_callMainInit(e){',
    '_callMainInit(e){try{console.error("[CALLDIAG] callMainInit");console.error("[CALLDIAG-PAYLOAD] callMainInit "+JSON.stringify(e))}catch(_e){}',
  ],
```

(The existing `patchOne` guard `s.includes(anchor) && !s.includes(replacement)` already makes this idempotent, since the replacement string now contains the payload dump.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/patch-call-trace.test.js`
Expected: `OK patch-call-trace`.

- [ ] **Step 5: Commit**

```bash
git add scripts/patches/patch-call-trace.js scripts/patches/__tests__/patch-call-trace.test.js
git commit -m "zcall SP2.0: dump setConfig/IPC payloads from the call-trace probes"
```

---

## Task 3: Main-process CDP Network tap for call/config hosts

**Files:**
- Modify: `scripts/patches/data/call-diag.js`
- Modify: `scripts/patches/__tests__/call-diag.test.js`

**Interfaces:**
- Consumes: the existing `call-diag.js` module (exports `formatLine`, `safeJson`; Electron-wiring guarded by `!process.env.CALL_DIAG_TEST`).
- Produces: exports `isCallHost(url: string): boolean` (true for hosts containing `voicecall`, `wpa.chat`, or a `zls?action=call_config` path). When Electron is present, each app `web-contents-created` attaches a CDP debugger, enables the Network domain, and logs `HTTP-REQ {url,method,postData?}` / `HTTP-RESP {url,status,body}` for URLs where `isCallHost` is true — plaintext, no TLS MITM.

**Context:** `webContents.debugger.attach('1.3')` + `sendCommand('Network.enable')` + the `Network.requestWillBeSent` / `Network.responseReceived` events + `Network.getResponseBody` give request/response bodies at the Chromium layer. This is additive to the existing web-contents hooks; it must fail open (a debugger already attached, or attach unsupported, must not break the app).

- [ ] **Step 1: Write the failing test**

Append to `scripts/patches/__tests__/call-diag.test.js` (before the final `console.log('OK call-diag')`):

```js
// isCallHost matcher
const { isCallHost } = require(MOD);
assert.strictEqual(isCallHost('https://voicecall-wpa.zalo.me/voicecall/requestcall'), true, 'voicecall host');
assert.strictEqual(isCallHost('https://wpa.chat.zalo.me/api/x'), true, 'wpa.chat host');
assert.strictEqual(isCallHost('https://api.conf.talk.zing.vn/zls?action=call_config'), true, 'call_config path');
assert.strictEqual(isCallHost('https://zalo.me/index.html'), false, 'unrelated host');
assert.strictEqual(isCallHost(''), false, 'empty');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/call-diag.test.js`
Expected: FAIL — `isCallHost is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `scripts/patches/data/call-diag.js`, add the pure matcher and export it (alongside `formatLine`, `safeJson`), then wire the CDP tap inside the existing `if (!process.env.CALL_DIAG_TEST) { ... }` Electron block.

Pure matcher + export:

```js
function isCallHost(url) {
  if (!url) return false;
  const u = String(url);
  return u.indexOf('voicecall') >= 0 || u.indexOf('wpa.chat') >= 0 || u.indexOf('action=call_config') >= 0;
}

module.exports = { formatLine, safeJson, isCallHost };
```

Inside the Electron block, within the existing `app.on('web-contents-created', (_e, contents) => { ... })` handler, after the existing `contents.on(...)` hooks, add the CDP Network tap:

```js
        // CDP Network tap: log call/config HTTP request+response bodies (plaintext, no TLS MITM).
        try {
          const dbg = contents.debugger;
          if (dbg && !dbg.isAttached()) {
            dbg.attach('1.3');
            const pending = {};
            dbg.on('message', (_ev, method, params) => {
              try {
                if (method === 'Network.requestWillBeSent' && isCallHost(params.request && params.request.url)) {
                  pending[params.requestId] = params.request.url;
                  log('HTTP-REQ', { url: params.request.url, method: params.request.method, postData: params.request.postData });
                } else if (method === 'Network.responseReceived' && pending[params.requestId]) {
                  const url = pending[params.requestId];
                  dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                    .then((r) => log('HTTP-RESP', { url, status: params.response && params.response.status, body: r && r.body }))
                    .catch((e) => log('HTTP-RESP-ERR', { url, err: String(e && e.message || e) }));
                }
              } catch (err) { log('CDP-MSG-ERROR', String((err && err.message) || err)); }
            });
            dbg.sendCommand('Network.enable').catch((e) => log('CDP-ENABLE-ERR', String(e && e.message || e)));
          }
        } catch (err) { log('CDP-ATTACH-ERROR', String((err && err.message) || err)); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/call-diag.test.js`
Expected: `OK call-diag`.

- [ ] **Step 5: Verify the module still syntax-checks**

Run: `node --check scripts/patches/data/call-diag.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

```bash
git add scripts/patches/data/call-diag.js scripts/patches/__tests__/call-diag.test.js
git commit -m "zcall SP2.0: CDP Network tap for voicecall/config HTTP bodies (no TLS MITM)"
```

---

## Task 4: Wide-value loopback capture (lock REQUEST wire format)

**Files:**
- Modify: `tools/zcall-re/harness.js`
- Create: `tools/zcall-re/__tests__/harness-ids.test.js`
- Modify: `.github/workflows/zcall-capture.yml`

**Interfaces:**
- Produces: `resolveIds(env): {fromId, toId, callId, sessId}` exported from `harness.js` — reads `FROM_ID`/`TO_ID`/`CALL_ID` (parsed as integers, defaulting to `111`/`222`/`10`) and `SESS_ID` (default `'SP1CAPTURE'`). The `MODE=call` config uses these instead of the hardcoded literals.

**Context:** The current call-mode `cfg` hardcodes `fromId:111,toId:222,callId:10`. SP1 Appendix C flags REQUEST endianness/field-widths as TENTATIVE because these small values can't distinguish big-endian-at-offset-7 from little-endian-at-offset-10. Wide, distinct-byte values (all > 255) disambiguate. `resolveIds` must be defined **before** the `MODE=call` block and exported without breaking the existing `MODE !== 'call'` early `process.exit(0)` path (export happens at module top, before any exit).

- [ ] **Step 1: Write the failing test**

```js
// tools/zcall-re/__tests__/harness-ids.test.js
const assert = require('assert');
const path = require('path');
// harness.js runs a body on require (it loads the addon). Guard: it only reaches the
// addon load when executed as the CLI; we require it with a sentinel so it exports and
// returns early. The module must export resolveIds without needing the addon.
process.env.ZCALL_HARNESS_TEST = '1';
const { resolveIds } = require(path.join(__dirname, '..', 'harness.js'));

assert.deepStrictEqual(
  resolveIds({}),
  { fromId: 111, toId: 222, callId: 10, sessId: 'SP1CAPTURE' },
  'defaults');
assert.deepStrictEqual(
  resolveIds({ FROM_ID: '16909060', TO_ID: '84281096', CALL_ID: '287454020', SESS_ID: 'WIDECAP' }),
  { fromId: 16909060, toId: 84281096, callId: 287454020, sessId: 'WIDECAP' },
  'wide distinct-byte ids from env');
console.log('OK harness-ids');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-re/__tests__/harness-ids.test.js`
Expected: FAIL — either `resolveIds is not a function` or the harness tries to load the addon and errors.

- [ ] **Step 3: Write minimal implementation**

At the **top** of `tools/zcall-re/harness.js` (right after `'use strict';` and the `require`s, before `mkdirp(OUT)`), add:

```js
function resolveIds(env) {
  const int = (v, d) => (v === undefined || v === null || v === '' || isNaN(parseInt(v, 10)) ? d : parseInt(v, 10));
  return {
    fromId: int(env.FROM_ID, 111),
    toId: int(env.TO_ID, 222),
    callId: int(env.CALL_ID, 10),
    sessId: env.SESS_ID || 'SP1CAPTURE',
  };
}
module.exports = { resolveIds };

// Test hook: exit before touching the mac addon when required by a unit test.
if (process.env.ZCALL_HARNESS_TEST) return;
```

Note: a top-level `return` is legal in a CommonJS module. Then, in the `MODE=call` block, replace the hardcoded id fields:

```js
  const ids = resolveIds(process.env);
  const cfg = {
    fromId: ids.fromId, toId: ids.toId, protocol: 3, status: 3, callId: ids.callId,
    sessId: ids.sessId,
```

(Leave the rest of `cfg` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-re/__tests__/harness-ids.test.js`
Expected: `OK harness-ids`.

- [ ] **Step 5: Wire wide-value ids into the capture workflow**

In `.github/workflows/zcall-capture.yml`, on the step that runs the harness with `MODE=call`, add the env values (distinct bytes, all > 255): `FROM_ID: "16909060"` (0x01020304), `TO_ID: "84281096"` (0x05060708), `CALL_ID: "287454020"` (0x11121314), `SESS_ID: "WIDEVALUECAP"`. Add them to that step's existing `env:` block (matching the file's current YAML style).

- [ ] **Step 6: Commit**

```bash
git add tools/zcall-re/harness.js tools/zcall-re/__tests__/harness-ids.test.js .github/workflows/zcall-capture.yml
git commit -m "zcall SP2.0: wide-value loopback capture (parameterize harness ids) to lock REQUEST wire format"
```

---

## Task 5: Keying classifier

**Files:**
- Create: `tools/zcall-re/classify-keying.js`
- Test: `tools/zcall-re/__tests__/classify-keying.test.js`

**Interfaces:**
- Consumes: `parsePayloadLines` from `tools/zcall-re/capture-utils.js` (Task 1).
- Produces:
  - `collectKeyingSignals(obj: any): string[]` — walks a payload object and returns the set of matched signal names: `'srtp-key-material'` (a key named like `srtpKey`/`masterKey`/`key`/`salt` with a ≥16-char string value), `'zrtc-config'` (a `zrtc_config` key present and non-empty), `'kdf-nonce'` (a key named like `nonce`/`seed`/`challenge`), `'session-token-only'` (a `sessId`/`session`/`token` present but none of the above).
  - `classifyKeying(payloads: Array<{obj:any}>): {klass: 'a'|'b'|'c'|'d', signals: string[], rationale: string}` — maps signals → keying class: any `srtp-key-material` or non-empty `zrtc-config` ⇒ `'a'` (server-delivered key material); else `kdf-nonce` present ⇒ `'b'` (client-derives-from-nonce); else only `session-token-only` ⇒ `'d'` (inconclusive — keys likely in media handshake, needs escalation); else (no payloads / no signals) ⇒ `'d'`. Class `'c'` is never auto-assigned — it is a human judgement recorded in the decision doc when evidence shows attestation/anti-tamper.
  - CLI: `node tools/zcall-re/classify-keying.js <diag-log-file>` prints the classification JSON.

- [ ] **Step 1: Write the failing test**

```js
// tools/zcall-re/__tests__/classify-keying.test.js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const MOD = path.join(__dirname, '..', 'classify-keying.js');
const { collectKeyingSignals, classifyKeying } = require(MOD);

assert.deepStrictEqual(
  collectKeyingSignals({ srtpKey: 'x'.repeat(20), callId: 1 }).sort(),
  ['srtp-key-material'], 'key material signal');
assert.ok(collectKeyingSignals({ zrtc_config: { a: 1 } }).indexOf('zrtc-config') >= 0, 'zrtc-config signal');
assert.ok(collectKeyingSignals({ nonce: 'abc' }).indexOf('kdf-nonce') >= 0, 'nonce signal');
assert.deepStrictEqual(collectKeyingSignals({ sessId: 'abc' }), ['session-token-only'], 'session only');

assert.strictEqual(classifyKeying([{ obj: { srtpKey: 'x'.repeat(20) } }]).klass, 'a', 'key material -> a');
assert.strictEqual(classifyKeying([{ obj: { zrtc_config: { k: 1 } } }]).klass, 'a', 'zrtc_config -> a');
assert.strictEqual(classifyKeying([{ obj: { nonce: 'abc' } }]).klass, 'b', 'nonce -> b');
assert.strictEqual(classifyKeying([{ obj: { sessId: 'abc' } }]).klass, 'd', 'session-only -> d');
assert.strictEqual(classifyKeying([]).klass, 'd', 'empty -> d');

cp.execFileSync(process.execPath, ['--check', MOD]);
console.log('OK classify-keying');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/zcall-re/__tests__/classify-keying.test.js`
Expected: FAIL — `Cannot find module '.../classify-keying.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// tools/zcall-re/classify-keying.js
'use strict';
// SP2.0 keying classifier. Pure analysis over captured [CALLDIAG-PAYLOAD] objects.
const { parsePayloadLines } = require('./capture-utils.js');

const KEYMAT = ['srtpkey', 'masterkey', 'key', 'salt'];
const NONCE = ['nonce', 'seed', 'challenge'];
const SESSION = ['sessid', 'session', 'token'];

function collectKeyingSignals(value) {
  const signals = new Set();
  let sawSession = false;
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const lk = k.toLowerCase();
        const val = v[k];
        if (lk === 'zrtc_config' && val && (typeof val !== 'object' || Object.keys(val).length > 0)) signals.add('zrtc-config');
        if (KEYMAT.indexOf(lk) >= 0 && typeof val === 'string' && val.length >= 16) signals.add('srtp-key-material');
        if (NONCE.indexOf(lk) >= 0 && val) signals.add('kdf-nonce');
        if (SESSION.indexOf(lk) >= 0 && val) sawSession = true;
        walk(val);
      }
    }
  })(value);
  if (signals.size === 0 && sawSession) signals.add('session-token-only');
  return Array.from(signals);
}

function classifyKeying(payloads) {
  const signals = new Set();
  for (const p of payloads || []) for (const s of collectKeyingSignals(p && p.obj)) signals.add(s);
  const has = (s) => signals.has(s);
  let klass, rationale;
  if (has('srtp-key-material') || has('zrtc-config')) { klass = 'a'; rationale = 'server-delivered key material in signaling/config payload'; }
  else if (has('kdf-nonce')) { klass = 'b'; rationale = 'server nonce present -> client likely derives keys via KDF'; }
  else { klass = 'd'; rationale = 'only session/token or nothing -> keying likely in media handshake; escalate (C2b) or inconclusive'; }
  return { klass, signals: Array.from(signals), rationale };
}

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) { console.error('usage: node classify-keying.js <diag-log-file>'); process.exit(2); }
  const payloads = parsePayloadLines(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify(classifyKeying(payloads), null, 2));
}

module.exports = { collectKeyingSignals, classifyKeying };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/zcall-re/__tests__/classify-keying.test.js`
Expected: `OK classify-keying`.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-re/classify-keying.js tools/zcall-re/__tests__/classify-keying.test.js
git commit -m "zcall SP2.0: keying classifier over captured payloads (class a/b/c/d)"
```

---

## Task 6: Capture procedure + GO/NO-GO decision doc

**Files:**
- Create: `tools/zcall-re/CAPTURE-SP2.md` (the runbook)
- Create: `docs/superpowers/decisions/2026-07-12-zcall-zrtp-keying-verdict.md` (the decision, filled from a real run)

**Interfaces:**
- Consumes: all prior tasks (the instrumentation patches, `classify-keying.js`, `capture-utils.js`).
- Produces: a reproducible runbook and a decision doc with the classification + evidence, updating SP1 §E.5.

**Context:** This task is documentation + running the real capture, not new code. The runbook must state the exact build/run/capture/analyze commands; the decision doc is written from the actual captured `~/zalo-call-diag.log`.

- [ ] **Step 1: Write the capture runbook**

Create `tools/zcall-re/CAPTURE-SP2.md` with these exact steps (own account; passive; local):

```markdown
# SP2.0 keying capture runbook

1. Build the diagnostics deb (includes call-trace payload dumps + CDP tap + zcall stub):
   SETUP=true BUILD=true node scripts/main.js
2. Install + reset log:
   sudo dpkg -i dist/Zalo-*.deb ; rm -f ~/zalo-call-diag.log
3. Launch, log in with YOUR account, open a 1-1 chat with YOUR OWN second device/number.
4. Place a real audio call to yourself; let it ring/connect ~20s; hang up.
5. Analyze (offline, pure):
   node tools/zcall-re/classify-keying.js ~/zalo-call-diag.log
6. Prepare a redacted sample for the repo (never commit raw secrets):
   node -e 'const u=require("./tools/zcall-re/capture-utils");const fs=require("fs");const p=u.parsePayloadLines(fs.readFileSync(process.env.HOME+"/zalo-call-diag.log","utf8"));console.log(JSON.stringify(p.map(x=>({tag:x.tag,obj:u.redactSecrets(x.obj)})),null,2))' > tools/zcall-re/sample-keying-redacted.json
```

- [ ] **Step 2: Run the capture** (manual, by the operator with their own account) and record the classifier output.

- [ ] **Step 3: Write the decision doc**

Create `docs/superpowers/decisions/2026-07-12-zcall-zrtp-keying-verdict.md` capturing: the classifier output (class a/b/c/d), the redacted evidence excerpt, whether the CDP tap showed server-delivered keys in the `/zls?action=call_config` or voicecall response, and the resulting **GO / NO-GO / CONDITIONAL-refined** verdict for SP2–SP6 — explicitly updating SP1 §E.5. If class is `d` (session-only), state the escalation decision (build C2b stub-driven elicitation, per spec §C2b) or declare inconclusive.

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-re/CAPTURE-SP2.md tools/zcall-re/sample-keying-redacted.json docs/superpowers/decisions/2026-07-12-zcall-zrtp-keying-verdict.md
git commit -m "zcall SP2.0: keying capture runbook + GO/NO-GO verdict (updates SP1 E.5)"
```

---

## Notes on C2b (escalation — not built unless reached)

Per spec §C2b, extending `patch-zcall-linux-stub.js` to actively perform the reversed
`voicecall/requestcall` signaling is deliberately **out of this plan** (YAGNI): it is only
built if Task 6's capture classifies as `d` (session-only, server never returns keying to a
passive client). At that point, add a follow-up plan for C2b as a minimal, signaling-only
elicitor bound by the same ToS constraints. Do not pre-build it.
