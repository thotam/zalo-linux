# Linux Tray Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Zalo's existing (macOS-gated) system tray on Linux by un-gating it, giving it a runtime-resized PNG icon, and fixing the XWayland blank on show-from-tray.

**Architecture:** One new fail-loud/idempotent patch `scripts/patches/patch-tray.js` makes three literal-anchor splices in `app/main-dist/main.js`, registered in the SETUP orchestrator. No image asset is committed — the icon is `nativeImage.resize()`d at runtime from the app's own `apple-icon-57x57.png`.

**Tech Stack:** Node (fs-extra), the repo's existing patch framework (`scripts/patches/*.js` + `scripts/utils/logger.js`), Node's `assert` for tests, electron-builder for the `.deb`.

## Global Constraints

- Patches must be **fail-loud** (throw on anchor drift) and **idempotent** (re-run = no-op). Copy the style of `scripts/patches/patch-relaunch-reveal.js`.
- Commit messages: **no** `Co-Authored-By`, **no** "Generated with Claude"/🤖.
- Only commit when the plan step says to. Do not push.
- Always run `node --check app/main-dist/main.js` before building a `.deb`.
- `app/` is gitignored and regenerated every SETUP — never hand-edit it as the source of truth; the patch is the source of truth.
- Reuse the local DMG for SETUP: `ZALO_DMG="$(pwd)/ZaloSetup-universal-26.6.11.dmg"`.
- Branch: `feat/linux-tray`.

---

### Task 1: `patch-tray.js` + unit test

**Files:**
- Create: `scripts/patches/patch-tray.js`
- Create: `scripts/patches/__tests__/patch-tray.test.js`

**Interfaces:**
- Produces: `module.exports = { main, patchMainJs }`. `patchMainJs(file: string): 'patched' | 'already'` — applies (idempotently) three splices to the file at `file`; throws on anchor drift. `main(): Promise<void>` — runs `patchMainJs` on `app/main-dist/main.js`.

- [ ] **Step 1: Write the failing test**

Create `scripts/patches/__tests__/patch-tray.test.js`:

```js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { patchMainJs } = require('../patch-tray.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-'));

// Stub containing the three literal anchors patch-tray targets.
const stub =
  'G.requestQuitApp()};if(J()===q){const t=s.Menu;xe||(xe=new u(Nt));}' +
  'const Nt=p.createFromPath(c.join(te(),"favicon.ico")),At={};' +
  'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),void e.focus();return 0}}';

const f = path.join(tmp, 'main.js');
fs.writeFileSync(f, stub);

assert.strictEqual(patchMainJs(f), 'patched', 'should patch');
const c = fs.readFileSync(f, 'utf8');
assert(c.includes('if(J()===q||"linux"===process.platform){const t=s.Menu;'), 'edit1: gate opened');
assert(c.includes('c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})'), 'edit2: icon resized');
assert(!c.includes('"favicon.ico"'), 'edit2: favicon.ico replaced');
assert(c.includes('e.show(),"linux"===process.platform&&e.isMaximized()&&setTimeout'), 'edit3: reveal toggle injected');
assert(c.includes('(e.unmaximize(),e.maximize())'), 'edit3: toggle body');

// idempotent
assert.strictEqual(patchMainJs(f), 'already', 'second run no-op');
assert.strictEqual(fs.readFileSync(f, 'utf8'), c, 'no double patch');

// fail-loud: an anchor missing (drift) -> throw
const drift = path.join(tmp, 'drift.js');
fs.writeFileSync(drift,
  'G.requestQuitApp()};if(J()===q){const t=s.Menu;}' +
  'const Nt=p.createFromPath(c.join(te(),"favicon.ico"));'); // no en() anchor
assert.throws(() => patchMainJs(drift), /show-from-tray reveal: expected exactly 1 anchor, found 0/, 'drift throws');

fs.removeSync(tmp);
console.log('OK patch-tray');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/patches/__tests__/patch-tray.test.js`
Expected: FAIL — `Cannot find module '../patch-tray.js'`.

- [ ] **Step 3: Write the patch**

Create `scripts/patches/patch-tray.js`:

```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Enable Zalo's system tray on Linux. The tray (icon + tooltip + context menu +
// unread badge + status switching + show/quit) is fully implemented in the ported
// macOS main bundle but wrapped in a macOS-only gate, so no Tray is created on
// Linux. See docs/superpowers/specs/2026-07-08-linux-tray-design.md.
//
//   1. un-gate : the tray IIFE body is `if(J()===q){…}` (q=MAC_CLIENT_TYPE);
//                also run it on Linux.
//   2. icon    : load the app's apple-icon-57x57.png and nativeImage.resize() it
//                to 44x44 at runtime (follows the app icon on version bumps; .ico
//                renders poorly on Linux trays).
//   3. reveal  : the show helper `en()` calls e.show() on Linux -> a maximized
//                frameless window stays blank under XWayland; force one native
//                reconfigure (unmaximize->maximize), same fix as patch-relaunch-reveal.
// ---------------------------------------------------------------------------

const MAIN_JS = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

const EDITS = [
  {
    name: 'un-gate tray',
    marker: 'J()===q||"linux"===process.platform',
    anchor: 'G.requestQuitApp()};if(J()===q){const t=s.Menu;',
    replacement: 'G.requestQuitApp()};if(J()===q||"linux"===process.platform){const t=s.Menu;',
  },
  {
    name: 'tray icon',
    marker: 'apple-icon-57x57.png',
    anchor: 'Nt=p.createFromPath(c.join(te(),"favicon.ico"))',
    replacement: 'Nt=p.createFromPath(c.join(te(),"apple-icon-57x57.png")).resize({width:44,height:44})',
  },
  {
    name: 'show-from-tray reveal',
    marker: 'e.isMaximized()&&setTimeout(function(){try{!e.isDestroyed()&&e.isMaximized()&&(e.unmaximize(),e.maximize())',
    anchor: 'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),void e.focus();',
    replacement: 'function en(e){if(e){if(J()===K)return e.isMinimized()?e.restore():e.show(),' +
      '"linux"===process.platform&&e.isMaximized()&&setTimeout(function(){' +
      'try{!e.isDestroyed()&&e.isMaximized()&&(e.unmaximize(),e.maximize())}catch(_){}},60),' +
      'void e.focus();',
  },
];

function patchMainJs(file) {
  let s = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const e of EDITS) {
    if (s.includes(e.marker)) continue; // idempotent
    const n = s.split(e.anchor).length - 1;
    if (n !== 1) {
      throw new Error(`patch-tray: ${e.name}: expected exactly 1 anchor, found ${n} — bundle format changed, re-derive.`);
    }
    s = s.replace(e.anchor, e.replacement);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, s, 'utf8');
  return changed ? 'patched' : 'already';
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`patch-tray: ${logger.formatPath(MAIN_JS)} not found (run extract first)`);
  }
  const r = patchMainJs(MAIN_JS);
  logger.success(`linux tray: ${r}`);
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main, patchMainJs };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/patches/__tests__/patch-tray.test.js`
Expected: `OK patch-tray`.

- [ ] **Step 5: Commit**

```bash
git add scripts/patches/patch-tray.js scripts/patches/__tests__/patch-tray.test.js
git commit -m "patch-tray: enable macOS tray on Linux (un-gate + runtime-resized icon + reveal)"
```

---

### Task 2: Register in orchestrator, apply, build

**Files:**
- Modify: `scripts/main.js` (patch list + the comment block above it)

**Interfaces:**
- Consumes: `require('./patches/patch-tray.js').main` from Task 1.

- [ ] **Step 1: Register the patch**

In `scripts/main.js`, in the `logger.step('Applying patches')` block, add the tray patch right after `patch-relaunch-reveal` (order among main-dist patches is independent):

```js
      await require('./patches/patch-relaunch-reveal.js').main();
      await require('./patches/patch-tray.js').main();
      await require('./patches/patch-renderer-win32.js').main();
```

And add one line to the patch-order comment block, after the `relaunch-reveal` entry:

```js
      //      tray          : main-dist -> un-gate the macOS tray on Linux + resize the
      //                      app icon at runtime + repaint on show-from-tray
```

- [ ] **Step 2: Run the full patch test suite**

Run: `for t in scripts/patches/__tests__/*.test.js; do node "$t" 2>&1 | tail -1; done`
Expected: each prints its `OK …` line (including `OK patch-tray`). The pre-existing `patch-linux-guards.test.js` may print a `Node.js` error line — that is an unrelated stale-fixture failure, ignore it.

- [ ] **Step 3: Regenerate `app/` via SETUP and apply all patches**

Run: `SETUP=true ZALO_DMG="$(pwd)/ZaloSetup-universal-26.6.11.dmg" node scripts/main.js 2>&1 | tail -4`
Expected: ends with `✔ All patches applied` (and a `linux tray: patched` line above it).

- [ ] **Step 4: Verify the three splices landed + syntax is valid**

Run:
```bash
node --check app/main-dist/main.js && echo "parses OK"
grep -c 'J()===q||"linux"===process.platform' app/main-dist/main.js   # expect 1
grep -c 'apple-icon-57x57.png").resize({width:44,height:44})' app/main-dist/main.js  # expect 1
grep -c 'e.show(),"linux"===process.platform&&e.isMaximized()&&setTimeout' app/main-dist/main.js  # expect 1
```
Expected: `parses OK`, then `1`, `1`, `1`.

- [ ] **Step 5: Build the `.deb`**

Run: `BUILD=true node scripts/main.js 2>&1 | tail -1`
Expected: `✔ Built Zalo-26.6.11.deb (…)`.

- [ ] **Step 6: Commit**

```bash
git add scripts/main.js
git commit -m "setup: run patch-tray (enable Linux tray) in the patch pipeline"
```

---

### Task 3: Real-device verification (manual — requires the user)

**Files:** none (verification only).

**Interfaces:**
- Consumes: `dist/Zalo-26.6.11.deb` from Task 2.

- [ ] **Step 1: Install and launch**

Run (user's machine):
```bash
pkill -9 -f /opt/Zalo/zalo-linux; sleep 1
sudo dpkg -i /mnt/data/Work/zalo-linux/dist/Zalo-26.6.11.deb || sudo apt-get -f install -y
```
Then launch Zalo from the app icon and log in.

- [ ] **Step 2: Verify the tray checklist**

Confirm each, reporting failures:
1. A Zalo tray icon appears in the GNOME top bar. If NOT: check the *AppIndicator and KStatusNotifierItem Support* GNOME extension is enabled (`gnome-extensions list | grep -i appindicator`); enable it and relaunch. This is an environment fix, not a code bug.
2. Right-click (or click) the tray icon → context menu shows: `Mở Zalo`, `Đổi trạng thái` ▸ (`Đang online`, `Đang bận (Tắt thông báo tin nhắn)`), separator, `Thoát`.
3. Hide the window (title-bar X), then `Mở Zalo` from the tray → the window reappears **with content** (no blank surface).
4. `Thoát` → the app fully quits (`pgrep -af zalo-linux | grep -v grep` shows nothing).
5. Receive an unread message → the tray icon reflects the unread/badge state.
6. `Đổi trạng thái` → toggling `Đang online` / `Đang bận` updates the checkmark.

- [ ] **Step 3: Decide**

If all pass → the branch is ready to merge (offer to merge `feat/linux-tray` into `main`).
If the tray does not appear even with AppIndicator enabled, or a menu action misbehaves → return to `superpowers:systematic-debugging` with the observed symptom (do not guess-patch).

---

## Self-Review

**Spec coverage:**
- Un-gate (spec Edit 1) → Task 1 EDITS[0]. ✓
- Runtime-resized app icon (spec Edit 2) → Task 1 EDITS[1]. ✓
- Show-from-tray reveal (spec Edit 3) → Task 1 EDITS[2]. ✓
- Fail-loud + idempotent + unit test → Task 1 (`patchMainJs` marker/anchor logic + test). ✓
- Registered in SETUP → Task 2. ✓
- AppIndicator constraint + GNOME click behavior → Task 3 Step 2 checklist. ✓
- Testing checklist (tray appears / menu / show-no-blank / quit / badge / status) → Task 3. ✓

**Placeholder scan:** none — all code and commands are literal.

**Type consistency:** `patchMainJs(file)` / `main()` / `module.exports` names match between the patch, the test (`require('../patch-tray.js')` → `patchMainJs`), and Task 2's `require('./patches/patch-tray.js').main`. Marker strings in `EDITS` are exact substrings of their `replacement`, so idempotency holds. ✓
