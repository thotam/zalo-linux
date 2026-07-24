# Linux Call Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the Linux Electron build's call path (webview lifecycle + media permissions + renderer console) so a single real call reveals the exact gaps blocking Zalo voice/video calls on Linux — without altering the remote voice-call web app.

**Architecture:** A diagnostics-only patch (`patch-call-diagnostics.js`) drops a main-process instrumentation module (`__call_diag.js`) into `app/main-dist/`, prepends a `require` of it into `main.js`, and enables `webviewTag` on the app windows. The module registers Electron `app`/`session` hooks that append structured events to `~/zalo-call-diag.log`. The user builds the `.deb`, places a real 1‑1 call on their own account, and sends the log; we read it to enumerate the gaps.

**Tech Stack:** Electron main-process APIs (`app.on('web-contents-created')`, `session.fromPartition('persist:zalo').setPermissionRequestHandler`, `webContents` events), Node `fs`/`os`/`path`, the repo's existing patch pattern (anchor → replacement, idempotent, fail-loud) + `node`-based patch tests.

## Global Constraints

- **Diagnostics-only.** This patch is NOT part of the shipping E39 build. It is applied on a diagnostics branch and reverted/omitted before release.
- **Fail-open.** Every hook and the logger are wrapped so a diagnostics error never breaks the app or a call.
- **Scope.** Only the app's own `persist:zalo` session, for the user's own call. No third-party/other-user exposure. Do not reverse zcall/ZRTP, do not reimplement or probe Zalo infrastructure.
- **Log file:** `process.env.ZALO_CALL_LOG` or `~/zalo-call-diag.log`, append-only, one line per event: ISO-8601 timestamp + `[process-role]` + TAG + JSON payload.
- **Patch conventions:** idempotent (re-running does nothing new), fail-loud if an anchor is missing (throw with a clear message — the bundle changed), never re-commit binaries or `app/` (gitignored).
- **No AI attribution** in commit messages (no `Co-Authored-By`, no "Generated with"/emoji). English commit messages.
- **Anchors (verbatim, from `app/main-dist/main.js`):** app windows use `webPreferences:{…partition:"persist:zalo"…}` (3 occurrences); `main.js` is a single webpack bundle whose first bytes are `__ZaBUNDLENAME__="main",__SCRIPT_TYPE__="main",function(e){…`.

---

## File Structure

- `scripts/patches/data/call-diag.js` — the main-process instrumentation module (source template; copied verbatim into `app/main-dist/__call_diag.js` by the patch). Pure log-formatting helpers are exported for unit testing; the Electron wiring runs as a side effect guarded by try/catch.
- `scripts/patches/patch-call-diagnostics.js` — the patch: copy the module, prepend its `require` into `main.js`, enable `webviewTag`. Idempotent + fail-loud.
- `scripts/patches/__tests__/call-diag.test.js` — unit test for the module's pure helpers + `node --check` validity.
- `scripts/patches/__tests__/patch-call-diagnostics.test.js` — unit test for the patch (webviewTag applied to all persist:zalo prefs, require injected, module copied, idempotent, fail-loud on anchor drift).
- `scripts/main.js` — (diagnostics wiring) apply the patch in the SETUP pipeline, guarded so it's clearly diagnostics-only.

---

### Task 1: Instrumentation module (`call-diag.js`)

**Files:**
- Create: `scripts/patches/data/call-diag.js`
- Test: `scripts/patches/__tests__/call-diag.test.js`

**Interfaces:**
- Produces: the module, when required with `process.env.CALL_DIAG_TEST` set (so the Electron wiring is skipped), exports `{ formatLine(when, role, tag, obj), safeJson(obj) }`.
  - `safeJson(obj)`: returns `obj` unchanged if it is a string; else `JSON.stringify(obj)`; on any throw returns `String(obj)`.
  - `formatLine(when, role, tag, obj)`: returns `"<when> [<role>] <tag>"`, plus `" " + safeJson(obj)` when `obj !== undefined`, plus a trailing `"\n"`.
- The un-guarded side effect (real Electron run) registers the hooks described in Steps 3–4.

- [ ] **Step 1: Write the failing test**

Create `scripts/patches/__tests__/call-diag.test.js`:

```js
const assert = require('assert');
const cp = require('child_process');
const path = require('path');

const MOD = path.join(__dirname, '..', 'data', 'call-diag.js');

// The module require()s 'electron', which is absent under plain node; it must fail open
// and still export its pure helpers when CALL_DIAG_TEST is set.
process.env.CALL_DIAG_TEST = '1';
const { formatLine, safeJson } = require(MOD);

// safeJson
assert.strictEqual(safeJson('hi'), 'hi', 'string passthrough');
assert.strictEqual(safeJson({ a: 1 }), '{"a":1}', 'object -> json');
const circular = {}; circular.self = circular;
assert.strictEqual(typeof safeJson(circular), 'string', 'circular -> String() fallback, no throw');

// formatLine
assert.strictEqual(
  formatLine('2026-01-01T00:00:00.000Z', 'main', 'DIAG-INIT', { log: '/x' }),
  '2026-01-01T00:00:00.000Z [main] DIAG-INIT {"log":"/x"}\n',
  'formatLine with payload');
assert.strictEqual(
  formatLine('2026-01-01T00:00:00.000Z', 'main', 'PING'),
  '2026-01-01T00:00:00.000Z [main] PING\n',
  'formatLine without payload');

// The whole file must be valid JS.
cp.execFileSync(process.execPath, ['--check', MOD]);

console.log('OK call-diag');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/call-diag.test.js`
Expected: FAIL — `Cannot find module '.../data/call-diag.js'` (the module does not exist yet).

- [ ] **Step 3: Write the module — pure helpers + logger**

Create `scripts/patches/data/call-diag.js` starting with the testable core:

```js
'use strict';
// Linux call diagnostics — main-process instrumentation. DIAGNOSTICS-ONLY; never shipped.
// Copied verbatim to app/main-dist/__call_diag.js by patch-call-diagnostics.js and required
// at the top of main.js. Observes the webview call path + media permissions and appends
// structured events to ~/zalo-call-diag.log so one real call reveals the Linux gaps.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.ZALO_CALL_LOG || path.join(os.homedir(), 'zalo-call-diag.log');

function safeJson(obj) {
  try { return typeof obj === 'string' ? obj : JSON.stringify(obj); }
  catch (_) { return String(obj); }
}
function formatLine(when, role, tag, obj) {
  let s = when + ' [' + role + '] ' + tag;
  if (obj !== undefined) s += ' ' + safeJson(obj);
  return s + '\n';
}
function log(tag, obj) {
  try { fs.appendFileSync(LOG, formatLine(new Date().toISOString(), process.type || 'main', tag, obj)); }
  catch (_) { /* fail open — diagnostics must never break the app */ }
}

module.exports = { formatLine, safeJson };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/call-diag.test.js`
Expected: `OK call-diag` (helpers correct + `--check` passes).

- [ ] **Step 5: Add the Electron wiring (side effect, guarded)**

Append to `scripts/patches/data/call-diag.js` (after the `module.exports` line). This block does nothing under plain node (require('electron') throws → caught) and only runs in the real app:

```js
// --- Electron wiring (real app only). Skipped in unit tests / when electron is absent. ---
if (!process.env.CALL_DIAG_TEST) {
  try {
    const { app, session } = require('electron');
    log('DIAG-INIT', { log: LOG, electron: (process.versions && process.versions.electron) || null });

    const url = (c) => { try { return c.getURL(); } catch (_) { return '?'; } };

    // Webview + renderer lifecycle: attach, load result, console (in-page getUserMedia errors), crashes.
    app.on('web-contents-created', (_e, contents) => {
      try {
        const type = contents.getType();
        contents.on('did-fail-load', (_ev, code, desc, u) => log('DID-FAIL-LOAD', { type, code, desc, url: u }));
        contents.on('console-message', (_ev, level, message, line, source) =>
          log('CONSOLE', { type, level, message, line, source }));
        contents.on('render-process-gone', (_ev, details) => log('RENDER-GONE', { type, details }));
        contents.on('did-attach-webview', (_ev, wc) => log('DID-ATTACH-WEBVIEW', { host: url(contents) }));
        if (type === 'webview') {
          log('WEBVIEW-CREATED', { url: url(contents) });
          contents.on('did-finish-load', () => log('WEBVIEW-DID-FINISH-LOAD', { url: url(contents) }));
        }
      } catch (err) { log('WC-HOOK-ERROR', String((err && err.message) || err)); }
    });

    // Media permission: log every request/check on the app session and GRANT media, so the
    // run reveals the downstream chain rather than dead-ending at the permission gap.
    app.whenReady().then(() => {
      try {
        const ses = session.fromPartition('persist:zalo');
        ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
          log('PERMISSION-REQUEST', { permission, url: details && details.requestingUrl });
          cb(permission === 'media' || permission === 'mediaKeySystem');
        });
        ses.setPermissionCheckHandler((_wc, permission, origin) => {
          log('PERMISSION-CHECK', { permission, origin });
          return permission === 'media';
        });
        log('PERMISSION-HANDLERS-INSTALLED', { partition: 'persist:zalo' });
      } catch (err) { log('PERMISSION-INSTALL-ERROR', String((err && err.message) || err)); }
    }).catch((err) => log('WHENREADY-ERROR', String((err && err.message) || err)));
  } catch (err) {
    log('DIAG-FATAL', String((err && err.message) || err));
  }
}
```

- [ ] **Step 6: Re-run test + verify still valid JS**

Run: `node scripts/patches/__tests__/call-diag.test.js`
Expected: `OK call-diag` (the guarded block is skipped under `CALL_DIAG_TEST`; helpers + `--check` still pass).

- [ ] **Step 7: Commit**

```bash
git add scripts/patches/data/call-diag.js scripts/patches/__tests__/call-diag.test.js
git commit -m "call-diag: main-process instrumentation module (webview/permission/console logging)"
```

---

### Task 2: The patch (`patch-call-diagnostics.js`)

**Files:**
- Create: `scripts/patches/patch-call-diagnostics.js`
- Test: `scripts/patches/__tests__/patch-call-diagnostics.test.js`

**Interfaces:**
- Consumes: `scripts/patches/data/call-diag.js` (Task 1).
- Produces: `main()` (async) that (a) copies `data/call-diag.js` → `app/main-dist/__call_diag.js`, (b) prepends `require("./__call_diag.js");` to `app/main-dist/main.js`, (c) adds `webviewTag:!0,` after each `webPreferences:{` that contains `partition:"persist:zalo"`. Exports `{ main }`. Idempotent; throws if the main.js bundle header anchor or the persist:zalo webPreferences anchor is absent.

- [ ] **Step 1: Write the failing test**

Create `scripts/patches/__tests__/patch-call-diagnostics.test.js`:

```js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcd-'));
const repo = path.join(tmp, 'repo');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.ensureDirSync(path.join(repo, 'scripts', 'patches', 'data'));

// Minimal main.js mirroring the two anchors the patch targets.
const MAIN =
  '__ZaBUNDLENAME__="main",__SCRIPT_TYPE__="main",function(e){' +
  'var w1={webPreferences:{devTools:!1,webSecurity:!0,partition:"persist:zalo"}};' +
  'var w2={webPreferences:{devTools:!1,webSecurity:!0,partition:"persist:zalo"}};' +
  '}();';
fs.writeFileSync(path.join(appMD, 'main.js'), MAIN, 'utf8');

// Copy the real data module + patch + logger so the patch runs against a real tree.
fs.copyFileSync(path.join(__dirname, '..', 'data', 'call-diag.js'), path.join(repo, 'scripts', 'patches', 'data', 'call-diag.js'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-call-diagnostics.js'), path.join(repo, 'scripts', 'patches', 'patch-call-diagnostics.js'));
fs.symlinkSync(path.join(__dirname, '..', '..', '..', 'node_modules'), path.join(repo, 'node_modules'), 'dir');

const { main } = require(path.join(repo, 'scripts', 'patches', 'patch-call-diagnostics.js'));

(async () => {
  await main();
  const m = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');

  // webviewTag enabled on BOTH persist:zalo webPreferences.
  assert.strictEqual((m.match(/webviewTag:!0,partition:"persist:zalo"/g) || []).length, 2, 'webviewTag on both app windows');
  // require injected once, at the very front.
  assert(m.startsWith('require("./__call_diag.js");'), 'require prepended to main.js');
  // module copied.
  assert(fs.existsSync(path.join(appMD, '__call_diag.js')), '__call_diag.js copied');

  // Idempotent: a second run must not double-inject.
  await main();
  const m2 = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');
  assert.strictEqual(m, m2, 'idempotent');
  assert.strictEqual((m2.match(/require\("\.\/__call_diag\.js"\)/g) || []).length, 1, 'single require');

  // Fail-loud on anchor drift.
  fs.writeFileSync(path.join(appMD, 'main.js'), 'no anchors here', 'utf8');
  let threw = false;
  try { await main(); } catch (_) { threw = true; }
  assert(threw, 'throws when anchors missing');

  fs.removeSync(tmp);
  console.log('OK patch-call-diagnostics');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/patch-call-diagnostics.test.js`
Expected: FAIL — `Cannot find module '.../patch-call-diagnostics.js'`.

- [ ] **Step 3: Write the patch**

Create `scripts/patches/patch-call-diagnostics.js`:

```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// DIAGNOSTICS-ONLY patch. Instruments the Linux call path to find why voice/video
// calls don't work, WITHOUT changing the remote voicecall-wpa web app:
//   1. copy the instrumentation module -> app/main-dist/__call_diag.js
//   2. prepend `require("./__call_diag.js")` to main.js (runs it in the main process)
//   3. enable webviewTag on the app windows (partition:"persist:zalo") so the call
//      <webview> can attach and be observed.
// The module logs webview lifecycle + media permission requests (grants media) +
// renderer console to ~/zalo-call-diag.log. NOT part of the shipping build.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'app', 'main-dist', 'main.js');
const SRC_MODULE = path.join(__dirname, 'data', 'call-diag.js');
const DST_MODULE = path.join(ROOT, 'app', 'main-dist', '__call_diag.js');

const REQUIRE_LINE = 'require("./__call_diag.js");';
const BUNDLE_ANCHOR = '__ZaBUNDLENAME__="main"';
const WV_ANCHOR = 'webPreferences:{';
const WV_PERSIST = 'partition:"persist:zalo"';

async function main() {
  if (!fs.existsSync(MAIN)) {
    throw new Error(`patch-call-diagnostics: ${logger.formatPath(MAIN)} not found (run extract first)`);
  }
  if (!fs.existsSync(SRC_MODULE)) {
    throw new Error(`patch-call-diagnostics: instrumentation module missing at ${logger.formatPath(SRC_MODULE)}`);
  }

  // 1. Copy the instrumentation module next to main.js.
  fs.copyFileSync(SRC_MODULE, DST_MODULE);

  let s = fs.readFileSync(MAIN, 'utf8');

  // 2. Prepend the require (idempotent).
  if (!s.startsWith(REQUIRE_LINE)) {
    if (!s.includes(BUNDLE_ANCHOR)) {
      throw new Error('patch-call-diagnostics: main.js bundle anchor `__ZaBUNDLENAME__="main"` not found — bundle changed.');
    }
    s = REQUIRE_LINE + s;
  } else {
    logger.dim('call-diagnostics: require already present');
  }

  // 3. Enable webviewTag on every persist:zalo webPreferences (idempotent).
  if (!s.includes(WV_PERSIST)) {
    throw new Error('patch-call-diagnostics: no `partition:"persist:zalo"` webPreferences found — bundle changed.');
  }
  // Only add webviewTag where it isn't already present for that pref block. Target the
  // `webPreferences:{…partition:"persist:zalo"…}` blocks by inserting right before the
  // partition key (stable, minified-safe), skipping blocks already patched.
  s = s.replace(new RegExp('(webPreferences:\\{(?:(?!webviewTag)[^}])*?)' + 'partition:"persist:zalo"', 'g'),
    (m0, pre) => pre + 'webviewTag:!0,' + WV_PERSIST);

  fs.writeFileSync(MAIN, s, 'utf8');

  // Post-conditions (fail loud).
  if (!s.startsWith(REQUIRE_LINE)) throw new Error('patch-call-diagnostics: require not prepended');
  if (!s.includes('webviewTag:!0,' + WV_PERSIST)) throw new Error('patch-call-diagnostics: webviewTag not applied');
  if (!fs.existsSync(DST_MODULE)) throw new Error('patch-call-diagnostics: module not copied');

  logger.success('call-diagnostics installed (webviewTag + main-process instrumentation)');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/patch-call-diagnostics.test.js`
Expected: `OK patch-call-diagnostics` (webviewTag on both windows, require prepended once, module copied, idempotent, fail-loud on drift).

- [ ] **Step 5: Commit**

```bash
git add scripts/patches/patch-call-diagnostics.js scripts/patches/__tests__/patch-call-diagnostics.test.js
git commit -m "call-diag: patch to enable webviewTag + inject main-process instrumentation (diagnostics-only)"
```

---

### Task 3: Wire into the SETUP pipeline + usage instructions

**Files:**
- Modify: `scripts/main.js` (add the patch to the pipeline, marked diagnostics-only)
- Create: `scripts/patches/README-call-diagnostics.md` (how to build, run a real call, capture the log)

**Interfaces:**
- Consumes: `patch-call-diagnostics.js` `main()` (Task 2).

- [ ] **Step 1: Add the patch to the pipeline**

In `scripts/main.js`, after the last `await require('./patches/patch-clipboard-image-paste.js').main();` line, add (the comment marks it clearly as diagnostics-only so it isn't mistaken for a shipping patch):

```js
      // DIAGNOSTICS-ONLY (call gap-finding; remove before release): instruments the
      // Linux call path — webviewTag + main-process webview/permission/console logging.
      await require('./patches/patch-call-diagnostics.js').main();
```

- [ ] **Step 2: Verify main.js still parses**

Run: `node --check scripts/main.js`
Expected: no output (valid).

- [ ] **Step 3: Write the usage doc**

Create `scripts/patches/README-call-diagnostics.md`:

```markdown
# Linux call diagnostics — how to run

Diagnostics-only. Finds why Zalo voice/video calls don't work on the Linux build by
logging the webview + permission + console events during a REAL call. See the design at
`docs/superpowers/specs/2026-07-12-linux-call-diagnostics-design.md`.

## Build + run

    SETUP=true BUILD=true node scripts/main.js       # builds dist/Zalo-*.deb with the diagnostics patch
    sudo dpkg -i dist/Zalo-*.deb
    rm -f ~/zalo-call-diag.log
    zalo                                              # log in with YOUR account

Place a real 1-1 call (this Linux machine -> your own phone), try audio then video, let it
ring/connect for ~15s, then hang up.

    cat ~/zalo-call-diag.log

Send that log. It shows, in order: whether the call `<webview>` attached
(`DID-ATTACH-WEBVIEW` / `WEBVIEW-CREATED`), whether it loaded the voicecall-wpa page
(`WEBVIEW-DID-FINISH-LOAD` vs `DID-FAIL-LOAD`), any in-page errors (`CONSOLE`, e.g.
`getUserMedia` NotAllowedError), and every media permission request/grant
(`PERMISSION-REQUEST` / `PERMISSION-CHECK`). That log is the gap report input.

## Notes
- Only touches the app's own `persist:zalo` session, your own account. No third party.
- Remove this patch (and `app/native/.../__call_diag.js`) before any shipping build.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/main.js scripts/patches/README-call-diagnostics.md
git commit -m "call-diag: wire diagnostics patch into pipeline + usage instructions"
```

---

## Self-Review

**Spec coverage:** webview lifecycle logging (Task 1 Step 5: WEBVIEW-CREATED/DID-FINISH-LOAD/DID-FAIL-LOAD/CONSOLE/RENDER-GONE/DID-ATTACH-WEBVIEW); permission log+grant on persist:zalo (Task 1 Step 5: setPermissionRequestHandler/CheckHandler); webviewTag enable (Task 2 Step 3); log file `~/zalo-call-diag.log` fail-open (Task 1 Steps 3+5); patch idempotent + fail-loud (Task 2 test); patch unit test + module valid-JS (Tasks 1–2 tests); build/run/capture loop (Task 3 README). The spec's "getListDevices result" item is covered by the universal `CONSOLE` hook (the device picker runs in a renderer whose console errors are captured) — noted in the README's "in order" list; no separate probe needed (YAGNI). Covered.

**Placeholder scan:** No TBD/TODO/"handle edge cases". The regex in Task 2 Step 3 is complete and the test asserts its exact effect (2 matches). All code blocks are complete.

**Type consistency:** `formatLine(when, role, tag, obj)` and `safeJson(obj)` are defined in Task 1 Step 3 and consumed in the Task 1 test with the same signatures. `main()` is defined in Task 2 Step 3 and consumed in the Task 2 test + Task 3 pipeline with the same shape. `REQUIRE_LINE`/anchors are consistent between the patch (Task 2) and its test assertions.

**Note on realism of the injection:** the `webviewTag` regex inserts before `partition:"persist:zalo"` and its own negative-lookahead (`(?!webviewTag)`) makes re-runs no-ops, so idempotency holds even though the require-prepend is guarded separately by `startsWith`. If, on the REAL bundle, the call webview turns out to be hosted by a window whose webPreferences does NOT carry `partition:"persist:zalo"`, the empirical run's `DID-ATTACH-WEBVIEW` line will be ABSENT — that itself is a diagnostic signal (the plan's Task 3 README calls this out), and the fix (widen the webviewTag anchor) becomes the first follow-up. This is acceptable for a diagnostics-first task.
