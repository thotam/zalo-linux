# Zalo for Linux — Clean Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-port the Zalo desktop app from the official macOS DMG to a clean, native-feeling Linux x64 `.deb` — boot, login, E2EE message-history sync, and text messaging — by wrapping the untouched Zalo bundle in a minimal build harness.

**Architecture:** A build harness (Electron shell `main.js` + a `scripts/` orchestrator) extracts `app.asar` from the macOS DMG into `app/`, applies 6 surgical fail-loud patches, and rebuilds the 3 buildable native modules from source for Linux (N-API v6). Nothing in Zalo is rewritten; `app/` and all `.node` are gitignored and regenerated every SETUP.

**Tech Stack:** Electron 22.3.27 (N-API v6), Node.js 18+, `@electron/asar`, electron-builder (`.deb`), node-gyp, C++17 (db-cross-v4, zfile), SQLCipher (sqlite3), 7z (DMG extraction), GitHub Actions.

## Global Constraints

- **Electron pinned to `22.3.27`** (matches the bundle's Electron 22.3.9; ABI = N-API v6). All native builds target it via `node-gyp --target=22.3.27 --dist-url=https://electronjs.org/headers`.
- **Source = the macOS DMG `ZaloSetup-universal-26.6.11.dmg` only.** No Windows/`.exe` source.
- **Target arch = x64 only.**
- **Native `.node` are NEVER committed** (`.gitignore` `*.node`) and are **rebuilt from source every SETUP** — no prebuilt downloads, no cache.
- **Only 3 native modules are buildable from source** and are built: `sqlite3` (with SQLCipher), `db-cross-v4`, `zfile`. The other 8 (`zwalker`, `zimage`, `zjxl`, `mp4thumb`, `file-utilities`, `file-utils`, `zcall`, `v8-profiles`) are proprietary/prebuilt-only and stay guarded/stubbed (out of v1 scope).
- **sqlite3 MUST be built with SQLCipher** (`PRAGMA cipher_version` non-empty) — a vanilla build silently stores the Zalo DB in plaintext.
- **Client-type is spoofed to 24 (WIN32)** in both main (`patch-platform-id`) and renderer (`patch-renderer-win32`): unlocks E2EE history sync AND makes the renderer draw window controls.
- **Windows stay frameless** (`frame:false` + `titleBarStyle:"hidden"`). Do NOT switch to a native GNOME frame and do NOT use `titleBarOverlay`.
- **Critical patches fail loud**: they `throw` if their minified anchor/pattern no longer matches (never silently ship a broken build).
- **Patch runtime order** (enforced by the orchestrator, Task 11) — platform-id → renderer-win32 → sqlite3 → db-cross-v4 → zfile → linux-guards — differs from the task-authoring order below (tasks are numbered by build/dependency order).
- **System deps** (Debian/Ubuntu): `p7zip-full build-essential libssl-dev liblzma-dev libsqlcipher-dev dpkg fakeroot` (+ `xvfb` for the smoke test).
- **Commits**: the per-task commit steps are review checkpoints. Per project rule, actually run `git commit` only when the user explicitly approves.
- **Lock files are NOT tracked** (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` are gitignored). Never `git add` a lock file; CI uses `npm install`, not `npm ci`.

---

### Task 1: Project scaffold
**Files:**
- Create: `/mnt/data/Work/zalo-linux/.gitignore`
- Create: `/mnt/data/Work/zalo-linux/package.json`
- Create: `/mnt/data/Work/zalo-linux/run-dev.sh`
- Create: `/mnt/data/Work/zalo-linux/scripts/utils/logger.js`
- Create: `/mnt/data/Work/zalo-linux/README.md`

**Interfaces:**
- Consumes: nothing (first task; `docs/` and `ZaloSetup-universal-26.6.11.dmg` already exist at repo root).
- Produces:
  - `scripts/utils/logger.js` exporting `{ step(msg), info(...args), success(...args), warn(...args), error(...args), dim(...args), formatPath(p) }` — consumed by every later script/patch via `require('./utils/logger')` (or relative depth thereof).
  - `package.json` with npm scripts `setup` / `build` / `main` / `start` and pinned `devDependencies.electron = "22.3.27"` — the shell runtime every later task builds against.
  - The `build` (electron-builder) block consumed by Task's `scripts/build.js`.
  - `run-dev.sh` — dev entrypoint used for smoke boot.

- [ ] **Step 1: Initialize the git repo.**
  Run: `cd /mnt/data/Work/zalo-linux && git init && git config user.name "thotam" && git config user.email "thanhtamtqno1@gmail.com"`
  Expected: `Initialized empty Git repository in /mnt/data/Work/zalo-linux/.git/`

- [ ] **Step 2: Create `.gitignore`.**
  Write `/mnt/data/Work/zalo-linux/.gitignore` with EXACTLY this content:
  ```gitignore
  # Extracted Zalo bundle (never committed — rebuilt every SETUP)
  app/

  # Build output
  dist/
  build/

  # Dependencies
  node_modules/

  # Native modules (rebuilt from source every SETUP, never committed)
  *.node

  # Scratch / installer / logs
  temp/
  *.dmg
  *.log
  ```

- [ ] **Step 3: Create the root `package.json`.**
  Write `/mnt/data/Work/zalo-linux/package.json` with EXACTLY this content. Note: `electron` is pinned to an exact `"22.3.27"` (no caret) per the ABI N-API v6 requirement; `description` names the macOS DMG source; `appId` is `com.zalo.linux`; `maintainer` is corrected. The `build` block is adapted from the reference `package.json` build block (spec §8).
  ```json
  {
    "name": "zalo-linux",
    "version": "1.0.0",
    "description": "Zalo desktop re-ported to Linux x64 from the official macOS DMG (ZaloSetup-universal), packaged as .deb",
    "main": "main.js",
    "license": "MIT",
    "scripts": {
      "setup": "SETUP=true node scripts/main.js",
      "build": "BUILD=true node scripts/main.js",
      "main": "SETUP=true BUILD=true node scripts/main.js",
      "start": "electron . --no-sandbox"
    },
    "devDependencies": {
      "@electron/asar": "^4.0.1",
      "electron": "22.3.27",
      "electron-builder": "^26.0.12",
      "fs-extra": "^11.2.0",
      "node-addon-api": "^5.0.0"
    },
    "build": {
      "appId": "com.zalo.linux",
      "productName": "Zalo",
      "directories": { "output": "dist" },
      "files": ["main.js", "package.json"],
      "extraFiles": [
        { "from": "app", "to": "app", "filter": ["**/*", "!node_modules", "!package-lock.json", "!package.json.bak"] }
      ],
      "asarUnpack": ["**/*.node"],
      "buildDependenciesFromSource": false,
      "nodeGypRebuild": false,
      "npmRebuild": false,
      "linux": {
        "target": "deb",
        "category": "Network",
        "maintainer": "thotam <thanhtamtqno1@gmail.com>",
        "synopsis": "Zalo messaging app for Linux",
        "icon": "app/pc-dist/favicon-512x512.png"
      }
    }
  }
  ```

- [ ] **Step 4: Create `run-dev.sh` (copied from reference).**
  Write `/mnt/data/Work/zalo-linux/run-dev.sh` with EXACTLY this content:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  cd "$(dirname "$0")"
  unset ELECTRON_RUN_AS_NODE
  exec npx electron . --no-sandbox --disable-gpu "$@"
  ```

- [ ] **Step 5: Make `run-dev.sh` executable.**
  Run: `chmod +x /mnt/data/Work/zalo-linux/run-dev.sh`
  Expected: no output; then `test -x /mnt/data/Work/zalo-linux/run-dev.sh && echo OK` prints `OK`.

- [ ] **Step 6: Create `scripts/utils/logger.js` (copied verbatim from reference `/mnt/data/Work/Zalo/Zalo-linux/scripts/utils/logger.js`).**
  Write `/mnt/data/Work/zalo-linux/scripts/utils/logger.js` with EXACTLY this content:
  ```javascript
  const path = require('path');
  const BASE_DIR = path.resolve(__dirname, '../..');

  function formatPath(p) {
    if (typeof p !== 'string') return p;
    if (p.startsWith(BASE_DIR)) {
      let rel = p.slice(BASE_DIR.length);
      if (rel.startsWith('/')) rel = rel.slice(1);
      return rel || '.';
    }
    return p;
  }

  function cleanArgs(args) {
    return args.map(arg => (typeof arg === 'string' ? formatPath(arg) : arg));
  }

  module.exports = {
    step: (msg) => console.log(`\n\x1b[1m\x1b[34m==>\x1b[0m \x1b[1m${msg}\x1b[0m`),
    info: (...args) => console.log('  \x1b[36mℹ\x1b[0m', ...cleanArgs(args)),
    success: (...args) => console.log('  \x1b[32m✔\x1b[0m', ...cleanArgs(args)),
    warn: (...args) => console.warn('  \x1b[33m⚠\x1b[0m', ...cleanArgs(args)),
    error: (...args) => console.error('  \x1b[31m✖\x1b[0m', ...cleanArgs(args)),
    dim: (...args) => console.log('    \x1b[2m' + cleanArgs(args).join(' ') + '\x1b[0m'),
    formatPath
  };
  ```

- [ ] **Step 7: Create a minimal `README.md`.**
  Write `/mnt/data/Work/zalo-linux/README.md` with EXACTLY this content:
  ```markdown
  # Zalo for Linux

  A clean re-port of the Zalo desktop app (Electron, Vietnamese messenger by VNG)
  to **Linux x64**, packaged as a `.deb`. The bundle is extracted from the official
  **macOS DMG** (`ZaloSetup-universal`), patched minimally, with native modules
  rebuilt from source for Linux.

  > Zalo is a trademark of VNG Corporation. This project is not affiliated with or
  > endorsed by VNG. It repackages the original bundle with minimal patches and
  > rebuilds native modules from source for Linux.

  ## Requirements

  System packages (Debian/Ubuntu):

  ```bash
  sudo apt install build-essential libssl-dev liblzma-dev libsqlcipher-dev \
    p7zip-full dpkg fakeroot
  ```

  Node.js 18+ and npm.

  ## Usage

  ```bash
  npm install          # install the Electron shell + build deps
  npm run setup        # download DMG, extract bundle to app/, patch, build native
  npm start            # run the app (dev)
  npm run build        # produce dist/Zalo-<version>.deb
  npm run main         # setup + build in one shot
  ```

  Set `ZALO_DMG=/path/to/ZaloSetup-universal-<ver>.dmg` to skip the download and
  use a local DMG.

  ## Layout

  - `main.js` — Electron shell entry (loads the extracted bundle).
  - `scripts/` — orchestrator, download/extract, build, and patches.
  - `nativelibs/` — native module sources built from scratch every setup.
  - `app/` — extracted Zalo bundle (git-ignored, never committed).

  ## License

  MIT (harness only). The Zalo bundle itself is proprietary to VNG.
  ```

- [ ] **Step 8: Install dependencies.**
  Run: `cd /mnt/data/Work/zalo-linux && npm install`
  Expected: completes without error; `node_modules/` and `package-lock.json` are created; Electron's postinstall downloads the `22.3.27` binary (log line `Downloading electron ...` or a cached copy).

- [ ] **Step 9: Verify Electron resolves.**
  Run: `cd /mnt/data/Work/zalo-linux && node -p "require('electron')"`
  Expected: prints an absolute path ending in `node_modules/electron/dist/electron` (a filesystem path string, not an error).

- [ ] **Step 10: Verify the pinned Electron version.**
  Run: `cd /mnt/data/Work/zalo-linux && node -p "require('electron/package.json').version"`
  Expected: `22.3.27`

- [ ] **Step 11: Verify the logger module loads and exposes its interface.**
  Run: `cd /mnt/data/Work/zalo-linux && node -e "const l=require('./scripts/utils/logger'); ['step','info','dim','success','warn','error','formatPath'].forEach(k=>{if(typeof l[k]!=='function')throw new Error('missing '+k)}); l.success('logger ok')"`
  Expected: prints a green-check line ending in `logger ok`.

- [ ] **Step 12: Commit the scaffold.**
  Run:
  ```bash
  cd /mnt/data/Work/zalo-linux && git add package.json run-dev.sh scripts/utils/logger.js README.md && git commit -m "Task 1: project scaffold (package.json, logger, run-dev, gitignore, README)"
  ```
  Expected: a commit is created; `git status` shows `node_modules/` untracked/ignored (not staged) and a clean tree otherwise.

---

### Task 2: DMG extraction pipeline

**Files:**
- Create `/mnt/data/Work/zalo-linux/scripts/download-installer.js` (full code below, verbatim reproduction).
- Create `/mnt/data/Work/zalo-linux/scripts/extract-installer.js` (full code below, verbatim reproduction).
- Modify `/mnt/data/Work/zalo-linux/package.json` — ensure `devDependencies` contains `@electron/asar` and `fs-extra` (add if absent; do not touch `electron` pin `"22.3.27"` set in Task 1).
- Consumes (read-only, created in Task 1): `/mnt/data/Work/zalo-linux/scripts/utils/logger.js`.
- Populates (runtime output, gitignored, NOT committed): `/mnt/data/Work/zalo-linux/app/` (`bootstrap.js`, `main-dist/`, `pc-dist/`, `native/nativelibs/*/index.js`, `native/nativelibs/db-cross-v4/dist/binding.js`, `package.json.bak`).

**Interfaces:**
- **Consumes:** `logger.{info,success,warn,error}` from `scripts/utils/logger.js` (Task 1).
- **Produces:**
  - `scripts/download-installer.js` → `module.exports = { main, getLatestVersion, parseVersionFromLocation, buildDmgUrl, assertValidVersion }`. Key signatures the orchestrator (Task: `scripts/main.js`) relies on: `async main() → { version, dest }` (sets `process.env.ZALO_DMG`); `assertValidVersion(v: string) → string` (throws on `!/^[0-9.]+$/`); `buildDmgUrl(version: string) → string`; `parseVersionFromLocation(loc: string) → string`.
  - `scripts/extract-installer.js` → `module.exports = { main }`. Signature: `async main() → void`; reads `process.env.ZALO_DMG` (or newest `.dmg` in `temp/`), writes `app/`. The orchestrator calls `extract.main()` after `download.main()` and before running the 6 patches.

---

- [ ] **Step 1: Ensure extraction deps are declared and installed.** These two packages are required by `extract-installer.js` (`fs-extra` for `copySync`/`removeSync`, `@electron/asar` for `extractAll`). The command is idempotent — if Task 1's scaffold already listed them, npm just reconfirms.
  - Run: `cd /mnt/data/Work/zalo-linux && npm install --save-dev @electron/asar@^4.0.1 fs-extra@^11.2.0`
  - Expected: exits 0; `package.json` `devDependencies` now includes `"@electron/asar": "^4.0.1"` and `"fs-extra": "^11.2.0"`.

- [ ] **Step 2: Create `scripts/download-installer.js` (verbatim reproduction).** Write `/mnt/data/Work/zalo-linux/scripts/download-installer.js` with EXACTLY this content:
```js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('./utils/logger');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DOWNLOAD_PAGE = 'https://zalo.me/download/zalo-pc?utm=90000';

function parseVersionFromLocation(loc) {
  const m = String(loc).match(/ZaloSetup-universal-([0-9.]+)\.dmg/);
  if (!m) throw new Error(`Cannot parse version from: ${loc}`);
  return m[1];
}

function buildDmgUrl(version) {
  return `https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-${version}.dmg`;
}

function assertValidVersion(v) {
  if (!/^[0-9.]+$/.test(v)) throw new Error(`Invalid ZALO_VERSION: ${v}`);
  return v;
}

function getLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(DOWNLOAD_PAGE, { headers: { 'User-Agent': MAC_UA } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try { resolve(parseVersionFromLocation(res.headers.location)); }
        catch (e) { reject(e); }
      } else {
        reject(new Error(`Unexpected HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const version = (process.env.ZALO_VERSION && process.env.ZALO_VERSION.trim()) || await getLatestVersion();
  assertValidVersion(version);
  const url = buildDmgUrl(version);
  const dest = path.join(TEMP_DIR, `ZaloSetup-universal-${version}.dmg`);

  if (fs.existsSync(dest) && !process.env.FORCE_DOWNLOAD) {
    logger.info(`Installer already present: ZaloSetup-universal-${version}.dmg`);
  } else {
    logger.info(`Downloading ZaloSetup-universal-${version}.dmg ...`);
    execSync(`wget --progress=bar:force --user-agent="${MAC_UA}" "${url}" -O "${dest}"`, { stdio: 'inherit' });
  }

  process.env.ZALO_DMG = dest;
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `ZALO_DMG=${dest}\n`);
  logger.success(`Ready: ${dest}`);
  return { version, dest };
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main, getLatestVersion, parseVersionFromLocation, buildDmgUrl, assertValidVersion };
```

- [ ] **Step 3: Create `scripts/extract-installer.js` (verbatim reproduction).** Write `/mnt/data/Work/zalo-linux/scripts/extract-installer.js` with EXACTLY this content. Note the preserved critical behaviors: `resolveDmg()` honors `ZALO_DMG` for a local file (falls back to newest `.dmg` in `temp/`); `7z` extracts both `app.asar` and `app.asar.unpacked/*` from the DMG (the `Zalo*/` glob absorbs the space in the top folder `Zalo 26.6.11-universal`); `@electron/asar extractAll` → `app/`; then the mandatory `fs.copySync(unpacked, APP_DIR, { overwrite: true })` overlay; then rename `app/package.json` → `app/package.json.bak`.
```js
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('./utils/logger');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const TEMP_DIR = path.join(ROOT, 'temp');

function commandExists(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function resolveDmg() {
  if (process.env.ZALO_DMG) {
    const p = path.resolve(process.env.ZALO_DMG);
    if (!fs.existsSync(p)) throw new Error(`ZALO_DMG not found: ${p}`);
    return p;
  }
  if (!fs.existsSync(TEMP_DIR)) throw new Error('No ZALO_DMG and temp/ is empty');
  const dmgs = fs.readdirSync(TEMP_DIR).filter(f => f.toLowerCase().endsWith('.dmg'));
  if (dmgs.length === 0) throw new Error('No .dmg in temp/ and no ZALO_DMG');
  dmgs.sort();
  return path.join(TEMP_DIR, dmgs[dmgs.length - 1]);
}

async function main() {
  if (!commandExists('7z')) {
    throw new Error('7z not installed. Run: sudo apt-get install -y p7zip-full');
  }

  const dmgPath = resolveDmg();
  logger.info('Installer (DMG):', dmgPath);

  fs.removeSync(APP_DIR);
  fs.ensureDirSync(TEMP_DIR);
  const work = path.join(TEMP_DIR, 'extract');
  fs.removeSync(work);
  fs.ensureDirSync(work);

  // DMG -> app.asar + app.asar.unpacked (macOS layout: Zalo*/Zalo.app/Contents/Resources/).
  // 7z reads the compressed DMG directly. The top folder name contains a space
  // ("Zalo <ver>-universal"), so the glob keeps a wildcard before Zalo.app.
  logger.info('Extracting app.asar and app.asar.unpacked from DMG...');
  execSync(
    `7z x "${dmgPath}" "Zalo*/Zalo.app/Contents/Resources/app.asar" "Zalo*/Zalo.app/Contents/Resources/app.asar.unpacked/*" -o"${work}" -y`,
    { stdio: 'pipe' }
  );

  const resources = execSync(`find "${work}" -path "*/Resources/app.asar" -type f`, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)[0];
  if (!resources) throw new Error('app.asar not found after DMG extraction');
  const resourcesDir = path.dirname(resources);

  // asar extractAll -> app/
  logger.info('Unpacking app.asar to app/...');
  const asar = require('@electron/asar');
  await asar.extractAll(path.join(resourcesDir, 'app.asar'), APP_DIR);

  // overlay app.asar.unpacked (real native loader JS + prebuilt dirs)
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    logger.info('Overlaying app.asar.unpacked...');
    fs.copySync(unpacked, APP_DIR, { overwrite: true });
  } else {
    logger.warn('app.asar.unpacked not found — native loaders may be missing');
  }

  // rename package.json so our shell package.json wins at runtime
  const pkg = path.join(APP_DIR, 'package.json');
  if (fs.existsSync(pkg)) fs.renameSync(pkg, path.join(APP_DIR, 'package.json.bak'));

  logger.success('app/ prepared');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
```

- [ ] **Step 4: Smoke-test the download-installer pure helpers (no network).** Confirms version parsing/validation and shell-injection guard work.
  - Run: `cd /mnt/data/Work/zalo-linux && node -e 'const d=require("./scripts/download-installer.js"); console.log(d.assertValidVersion(d.parseVersionFromLocation("https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-26.6.11.dmg"))); console.log(d.buildDmgUrl("26.6.11")); try{d.assertValidVersion("1.0; rm -rf /")}catch(e){console.log(e.message)}'`
  - Expected (three lines):
    ```
    26.6.11
    https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-26.6.11.dmg
    Invalid ZALO_VERSION: 1.0; rm -rf /
    ```

- [ ] **Step 5: Run extraction against the real local DMG.** Uses `ZALO_DMG` to point at the DMG already present in the repo root (no download). Takes ~2s.
  - Run: `cd /mnt/data/Work/zalo-linux && ZALO_DMG=/mnt/data/Work/zalo-linux/ZaloSetup-universal-26.6.11.dmg node scripts/extract-installer.js`
  - Expected (final line, ignoring ANSI color): `✔ app/ prepared`

- [ ] **Step 6: Assert the extraction postconditions.** Proves the `.unpacked` overlay ran (`db-cross-v4/dist/binding.js` present) and the shell package.json will win at runtime (`package.json.bak` present, original renamed away).
  - Run: `cd /mnt/data/Work/zalo-linux && test -f app/native/nativelibs/db-cross-v4/dist/binding.js && echo OK-binding && test -f app/package.json.bak && echo OK-bak && test ! -f app/package.json && echo OK-renamed && test -f app/bootstrap.js && test -d app/main-dist && test -d app/pc-dist && echo OK-shell`
  - Expected (four lines):
    ```
    OK-binding
    OK-bak
    OK-renamed
    OK-shell
    ```

- [ ] **Step 7: Commit the two scripts (do NOT commit `app/`).** `app/`, `temp/`, `*.dmg` are gitignored per spec §3; add files explicitly so nothing from `app/` is staged.
  - Run: `cd /mnt/data/Work/zalo-linux && git add scripts/download-installer.js scripts/extract-installer.js package.json && git commit -m "Add DMG extraction pipeline (download + 7z extract + asar extractAll + unpacked overlay)"`
  - Expected: commit succeeds; `git status --porcelain app/` prints nothing (the extracted bundle stays untracked).

---

---

### Task 3: nativelibs/builder.js — node-gyp source builder (shared infra)

**Files:**
- Create: `/mnt/data/Work/zalo-linux/nativelibs/builder.js` (full code below — copied verbatim from `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/builder.js`)
- Test: `node --check` (syntax); functional exercise happens in Task 4 (first real consumer).

**Interfaces:**
- **Consumes:**
  - `/mnt/data/Work/zalo-linux/package.json` → `devDependencies.electron` = `"22.3.27"` (created by Task 1). `builder.js` reads it via `require(../package.json)` and strips any leading `^`/`~`.
  - `/mnt/data/Work/zalo-linux/scripts/utils/logger.js` exposing `logger.dim/success` (created by Task 1, copied from reference).
  - `fs-extra` installed at repo-root `node_modules` (root `dependencies`, from Task 1).
- **Produces:** A CLI script invoked as `node nativelibs/builder.js <absLibDir>`. Contract: given `<absLibDir>` containing a `binding.gyp` + `package.json`, it (1) runs `npm install` in that dir if `node_modules` is absent, (2) runs `npx node-gyp rebuild --target=22.3.27 --arch=x64 --dist-url=https://electronjs.org/headers`, (3) throws if no `*.node` lands in `<absLibDir>/build/Release/`. No exported JS functions — later tasks (Task 4 db-cross-v4, Task 6 zfile) call it via `execSync('node "<BUILDER>" "<LIB_DIR>"')`.

- [ ] **Step 1: Create the nativelibs directory.**
  Run: `mkdir -p /mnt/data/Work/zalo-linux/nativelibs`
  Expected: no output, exit 0.

- [ ] **Step 2: Write `/mnt/data/Work/zalo-linux/nativelibs/builder.js`** with this exact content:
  ```js
  const { execSync } = require('child_process');
  const fs = require('fs-extra');
  const path = require('path');
  const logger = require('../scripts/utils/logger');

  const ROOT_PKG = require(path.join(__dirname, '..', 'package.json'));
  const ELECTRON_VERSION = ROOT_PKG.devDependencies.electron.replace(/^[\^~]/, '');

  const libDir = path.resolve(process.argv[2]);
  const releaseDir = path.join(libDir, 'build', 'Release');

  logger.dim(`Lib dir: ${libDir}`);
  logger.dim(`Electron: ${ELECTRON_VERSION}`);

  if (!fs.existsSync(path.join(libDir, 'node_modules'))) {
    execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: libDir, stdio: 'inherit' });
  }

  execSync(
    `npx node-gyp rebuild --target=${ELECTRON_VERSION} --arch=x64 --dist-url=https://electronjs.org/headers`,
    { cwd: libDir, stdio: 'inherit' }
  );

  const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
  if (nodeFiles.length === 0) throw new Error(`Build produced no .node in ${releaseDir}`);
  logger.success(`Built ${nodeFiles[0]} (${(fs.statSync(path.join(releaseDir, nodeFiles[0])).size / 1024).toFixed(1)} KB)`);
  ```

- [ ] **Step 3: Syntax-check the script** (does not execute requires, so it passes even before `app/`/deps exist).
  Run: `node --check /mnt/data/Work/zalo-linux/nativelibs/builder.js && echo CHECK_OK`
  Expected: `CHECK_OK`

- [ ] **Step 4: Commit.**
  Run:
  ```bash
  cd /mnt/data/Work/zalo-linux && git add nativelibs/builder.js && git commit -m "Add nativelibs/builder.js: node-gyp source builder targeting Electron 22.3.27"
  ```
  Expected: one commit created, `nativelibs/builder.js` listed.

---

### Task 4: db-cross-v4 native (build from source) + patch-db-cross-v4.js

**Files:**
- Create (copy VERBATIM — do NOT retype `main.cc`, it is 1012 lines):
  - `/mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/binding.gyp` ← `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/binding.gyp`
  - `/mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/package.json` ← `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/package.json`
  - `/mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/src/main.cc` ← `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/src/main.cc`
- Create: `/mnt/data/Work/zalo-linux/scripts/patches/patch-db-cross-v4.js` (full code below — reference-derived, with critical warns upgraded to fail-loud throws).

**System dependencies** (must be installed before building; state to the operator / CI):
```
build-essential   # g++, make (compiles src/main.cc, C++17)
libssl-dev        # openssl/evp.h + openssl/aes.h, -lcrypto (AES-256-CBC)
liblzma-dev       # lzma.h, -llzma (XZ stream decode)
```
Install: `sudo apt-get update && sudo apt-get install -y build-essential libssl-dev liblzma-dev`

**Interfaces:**
- **Consumes:**
  - `nativelibs/builder.js` (Task 3) — invoked via `execSync('node "<BUILDER>" "<LIB_DIR>"')`.
  - `scripts/utils/logger.js` (Task 2) — `logger.info/dim/success/warn/error`.
  - Root `package.json` `devDependencies.electron = "22.3.27"` (read transitively by builder.js).
  - `fs-extra` at repo root (Task 1).
  - Extracted bundle at `app/native/nativelibs/db-cross-v4/dist/binding.js` (produced by the extract task, Task 2/earlier). The vendored `package.json` here declares `node-addon-api ^5.0.0`, which builder.js `npm install`s into the lib on first build.
- **Produces:** `scripts/patches/patch-db-cross-v4.js` exporting `module.exports = { main }` where `main(): Promise<void>`. The orchestrator (`scripts/main.js`, later task) `require`s it and `await`s `main()` as the 4th SETUP patch (order: platform-id → renderer-win32 → sqlite3 → **db-cross-v4** → zfile → linux-guards). Side effects: builds `db-cross-v4-native.node`, copies it to `app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node`, and splices a `process.platform === 'linux'` branch into `app/native/nativelibs/db-cross-v4/dist/binding.js` (idempotent, fail-loud).

- [ ] **Step 1: Create the vendored source tree.**
  Run: `mkdir -p /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/src`
  Expected: no output, exit 0.

- [ ] **Step 2: Copy `binding.gyp` verbatim.**
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/binding.gyp /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/binding.gyp`
  (For reference, the file is 13 lines: target `db-cross-v4-native`, `sources:["src/main.cc"]`, node-addon-api include/gyp, `defines:["NAPI_DISABLE_CPP_EXCEPTIONS"]`, `libraries:["-llzma","-lcrypto"]`, `cflags_cc:["-std=c++17","-O2"]`.)
  Verify: `test -f /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/binding.gyp && echo GYP_OK`
  Expected: `GYP_OK`

- [ ] **Step 3: Copy `package.json` verbatim.**
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/package.json /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/package.json`
  (14 lines: name `db-cross-v4-linux`, `main:"index.js"`, `private:true`, `dependencies:{ "node-addon-api":"^5.0.0" }`.)
  Verify: `test -f /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/package.json && echo PKG_OK`
  Expected: `PKG_OK`

- [ ] **Step 4: Copy `src/main.cc` verbatim (~1012 lines — the C++ clean-room decrypt/decompress addon; do NOT edit).**
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/db-cross-v4/src/main.cc /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/src/main.cc`
  Verify: `wc -l /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/src/main.cc`
  Expected: `1012 /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/src/main.cc`

- [ ] **Step 5: Install system build dependencies.**
  Run: `sudo apt-get update && sudo apt-get install -y build-essential libssl-dev liblzma-dev`
  Expected: apt finishes with `build-essential`, `libssl-dev`, `liblzma-dev` installed (or already newest).
  Verify: `dpkg -s libssl-dev liblzma-dev build-essential | grep -c '^Status: install ok installed'`
  Expected: `3`

- [ ] **Step 6: Create the patches directory.**
  Run: `mkdir -p /mnt/data/Work/zalo-linux/scripts/patches`
  Expected: no output, exit 0.

- [ ] **Step 7: Write `/mnt/data/Work/zalo-linux/scripts/patches/patch-db-cross-v4.js`** with this exact content. It reproduces the reference patch, but — per CANONICAL CONVENTIONS (§3 of spec: "Patch critical **throw** khi không khớp pattern") and the fail-loud requirement — the three critical failure modes (vendored source missing, regex no-match, `binding.js` absent) **throw** instead of the reference's silent `warn`. db-cross-v4 is Critical: a shared-worker calls `dbUtils()` at import, so a bad splice must never ship silently.
  ```js
  const { execSync } = require('child_process');
  const fs = require('fs-extra');
  const path = require('path');
  const logger = require('../utils/logger');

  const ROOT = path.join(__dirname, '..', '..');
  const APP_DIR = path.join(ROOT, 'app');
  const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
  const LIB_DIR = path.join(ROOT, 'nativelibs', 'db-cross-v4');

  async function main() {
    if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
      // Critical patch: the vendored source is mandatory in the clean port — fail loud.
      throw new Error(`db-cross-v4 source missing at ${LIB_DIR}/binding.gyp`);
    }

    logger.info('Building db-cross-v4 from source...');
    execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });

    const releaseDir = path.join(LIB_DIR, 'build', 'Release');
    const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
    if (nodeFiles.length === 0) throw new Error('db-cross-v4 build produced no .node');

    const destDir = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'prebuilt', 'linux', 'electron', 'x64');
    fs.ensureDirSync(destDir);
    // The Zalo binding.js requires the file named exactly db-cross-v4-native.node
    fs.copyFileSync(path.join(releaseDir, nodeFiles[0]), path.join(destDir, 'db-cross-v4-native.node'));
    logger.dim('Installed Linux db-cross-v4-native.node');

    const bindingJs = path.join(APP_DIR, 'native', 'nativelibs', 'db-cross-v4', 'dist', 'binding.js');
    if (!fs.existsSync(bindingJs)) {
      // Critical: binding.js only exists if extraction overlaid app.asar.unpacked — fail loud.
      throw new Error(`binding.js not found at ${bindingJs} — did extraction overlay app.asar.unpacked?`);
    }

    let c = fs.readFileSync(bindingJs, 'utf8');
    if (c.includes("process.platform === 'linux'")) {
      logger.dim('binding.js already has linux branch');
    } else {
      const before = c;
      c = c.replace(
        /else \{\s*if \(process\.arch === 'x64'\)/,
        `else if (process.platform === 'linux') {\n    addon = require('../prebuilt/linux/electron/x64/db-cross-v4-native.node');\n}\nelse {\n    if (process.arch === 'x64')`
      );
      if (c === before) {
        // Critical fail-loud: upstream binding.js format changed; do NOT ship a broken splice.
        throw new Error("binding.js linux branch NOT inserted — the /else { if (process.arch === 'x64')/ pattern no longer matches; update the regex in patch-db-cross-v4.js");
      }
      fs.writeFileSync(bindingJs, c, 'utf8');
      logger.dim('Patched binding.js with linux branch');
    }

    logger.success('db-cross-v4 installed');
  }

  if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
  module.exports = { main };
  ```

- [ ] **Step 8: Syntax-check the patch.**
  Run: `node --check /mnt/data/Work/zalo-linux/scripts/patches/patch-db-cross-v4.js && echo PATCH_OK`
  Expected: `PATCH_OK`

- [ ] **Step 9: Functionally build the native module and probe it** (requires Tasks 1–2 done: root `package.json` with `electron` 22.3.27, `scripts/utils/logger.js`, `fs-extra` installed, and Step 5's system deps). This exercises `builder.js` end-to-end and validates the produced `.node`.
  Run:
  ```bash
  cd /mnt/data/Work/zalo-linux && node nativelibs/builder.js nativelibs/db-cross-v4
  ```
  Expected: node-gyp compiles `main.cc` and prints (via logger) `Built db-cross-v4-native.node (… KB)`; file `nativelibs/db-cross-v4/build/Release/db-cross-v4-native.node` exists.

- [ ] **Step 10: Assert the `.node` is an ELF x86-64 shared object.**
  Run: `file /mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/build/Release/db-cross-v4-native.node`
  Expected: contains `ELF 64-bit LSB shared object, x86-64` (e.g. `… ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, …`).

- [ ] **Step 11: Load the module and call a harmless export.** N-API v6 is ABI-stable, so system Node can `require` the Electron-targeted `.node`. `parseBinNet()` with no args returns `{ result: 1, error_message: "Wrong arguments" }` without side effects — a safe probe.
  Run:
  ```bash
  node -e "const a=require('/mnt/data/Work/zalo-linux/nativelibs/db-cross-v4/build/Release/db-cross-v4-native.node'); if(typeof a.parseBinNet!=='function'||typeof a.decompressAndDecryptDb!=='function') throw new Error('missing exports'); const r=a.parseBinNet(); if(r.result!==1) throw new Error('bad probe: '+JSON.stringify(r)); console.log('PROBE_OK result='+r.result);"
  ```
  Expected: `PROBE_OK result=1`

- [ ] **Step 12: (Splice check — runs during full SETUP, after the extract task creates `app/`.)** Guarded fallback assertion that the linux branch was written into the real bundle's `binding.js`. Skips cleanly if `app/` is not yet extracted in isolation.
  Run:
  ```bash
  B=/mnt/data/Work/zalo-linux/app/native/nativelibs/db-cross-v4/dist/binding.js; if [ -f "$B" ]; then grep -q "process.platform === 'linux'" "$B" && echo SPLICE_OK || echo SPLICE_MISSING; else echo APP_NOT_EXTRACTED_SKIP; fi
  ```
  Expected: `SPLICE_OK` after a full SETUP run; `APP_NOT_EXTRACTED_SKIP` when running this task before extraction.

- [ ] **Step 13: Commit.**
  Run:
  ```bash
  cd /mnt/data/Work/zalo-linux && git add nativelibs/db-cross-v4/binding.gyp nativelibs/db-cross-v4/package.json nativelibs/db-cross-v4/src/main.cc scripts/patches/patch-db-cross-v4.js && git commit -m "Add db-cross-v4 native source + patch-db-cross-v4 (build from source, fail-loud binding.js splice)"
  ```
  Expected: one commit with the four files. Note: `nativelibs/db-cross-v4/build/` and any `*.node` are gitignored (per `.gitignore` from Task 1) and MUST NOT be committed — verify with `git status --short` showing no `build/` or `.node` entries staged.

---

### Task 5: sqlite3 built from source WITH SQLCipher

**Files:**
- **Create** `/mnt/data/Work/zalo-linux/scripts/patches/verify-sqlite3.js` (full code below) — standalone SQLCipher verifier, also invoked by the patch.
- **Create** `/mnt/data/Work/zalo-linux/scripts/patches/patch-sqlite3.js` (full code below) — replaces the old vanilla-copy version.
- **Test/Run** (no file): `node scripts/patches/patch-sqlite3.js` then `node scripts/patches/verify-sqlite3.js`.
- **No change** to root `package.json`: we deliberately do **not** add `sqlite3` to `devDependencies`. If it were declared, the repo's `npm install` would run node-sqlite3's install script `prebuild-install -r napi || node-gyp rebuild`, which either pulls a **vanilla** (non-SQLCipher) prebuilt or fails the whole install (node-gyp 12.x can't resolve `napi_build_version`). Instead the patch fetches the source on demand into an isolated temp dir with `--ignore-scripts` and builds it itself.
- **System dependency (build):** `libsqlcipher-dev` (headers under `/usr/include/sqlcipher`). Add it to `.github/workflows/build.yml` apt list and §6.4. **Runtime dependency (primary build only):** the produced `.node` dynamically links `libsqlcipher.so.0`, so the packaging task MUST add `libsqlcipher0` to `build.linux.depends` in `package.json`. The fallback build statically bundles SQLCipher and only needs `libcrypto`/OpenSSL (`libssl3`, ubiquitous) — no `libsqlcipher0`.
- The built `node_sqlite3.node` is **never committed** (matched by `.gitignore` `*.node`); it is rebuilt every SETUP and lands at `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node` (also under gitignored `app/`).

**Interfaces:**
- **Consumes:**
  - From Task 1 (repo scaffold): root `package.json` with `devDependencies.electron === "22.3.27"`, `fs-extra` installed, and `scripts/utils/logger.js` exposing `logger.step/info/dim/success/warn/error`.
  - From Task 2 (extract): extracted bundle at `app/`, specifically the Zalo sqlite3 wrapper chain `app/native/nativelibs/sqlite3/index.js` → `sqlite3.js` → `sqlite3-binding.js`, where `sqlite3-binding.js` does `require('./binding/napi-v6-' + process.platform + '-' + process.arch + '/node_sqlite3.node')` (i.e. on Linux x64 it loads the `napi-v6-linux-x64` slot). The dir already contains the macOS slots (`napi-v6-darwin-x64`, `napi-v6-darwin-arm64`); we only add the linux slot.
  - From the orchestrator (`scripts/main.js`, Task 11): calls `await require('./patches/patch-sqlite3.js').main()` 3rd in the fixed patch order (after `patch-renderer-win32`, before `patch-db-cross-v4`).
- **Produces:**
  - `scripts/patches/patch-sqlite3.js` exporting `async function main(): Promise<void>` (idempotent, fail-loud). Side effect: installs `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node` (ELF, N-API v6, SQLCipher codec) and throws on any build/verify failure.
  - `scripts/patches/verify-sqlite3.js`: standalone (`node scripts/patches/verify-sqlite3.js`), exit 0 on pass, exit 1 with a loud message on failure. No later task depends on its exports.

---

- [ ] **Step 1: Create the verifier `scripts/patches/verify-sqlite3.js`.** This is the key deliverable — it loads the freshly-installed `.node` through the *real* Zalo wrapper, sets `PRAGMA key`, asserts `PRAGMA cipher_version` is non-empty (proves the codec is present), and asserts the on-disk DB header is not the plaintext `SQLite format 3` magic (proves it actually encrypts). Write the full file:

```js
#!/usr/bin/env node
// Standalone SQLCipher verifier for the installed Zalo sqlite3 binding.
// Proves the built node_sqlite3.node has a WORKING SQLCipher codec — not vanilla sqlite3,
// which silently ignores `PRAGMA key` and would store the Zalo DB in PLAINTEXT.
//
//   node scripts/patches/verify-sqlite3.js
//
// Runs under plain Node: the binding is pure N-API v6 (ABI-stable), so a napi-v6 module
// built against Electron 22 headers loads fine under Node 18+. To verify under the exact
// Electron runtime instead: xvfb-run -a npx electron scripts/patches/verify-sqlite3.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SLOT = path.join(ROOT, 'app', 'native', 'nativelibs', 'sqlite3',
  'binding', 'napi-v6-linux-x64', 'node_sqlite3.node');
const WRAPPER = path.join(ROOT, 'app', 'native', 'nativelibs', 'sqlite3', 'index.js');
const KEY = 'zalo-sqlcipher-verify-key';

function fail(msg) {
  console.error('\n\x1b[1m\x1b[31mSQLCIPHER VERIFY FAILED:\x1b[0m ' + msg + '\n');
  process.exit(1);
}

// [1/4] The binding must exist and be an ELF (Linux) shared object.
if (!fs.existsSync(SLOT)) fail('node_sqlite3.node missing at ' + SLOT);
const head4 = Buffer.alloc(4);
const fd = fs.openSync(SLOT, 'r');
fs.readSync(fd, head4, 0, 4, 0);
fs.closeSync(fd);
if (!(head4[0] === 0x7f && head4[1] === 0x45 && head4[2] === 0x4c && head4[3] === 0x46)) {
  fail('binding is not an ELF object (magic=' + head4.toString('hex') + ')');
}
console.log('[1/4] ELF magic OK: ' + SLOT);

// [2/4] Load it through the REAL Zalo code path (the bundle's own wrapper + loader).
let sqlite3;
try {
  sqlite3 = require(WRAPPER);
} catch (e) {
  fail('failed to load node_sqlite3.node via Zalo wrapper (' + WRAPPER + '): ' + e.message +
    '\n(A load error here usually means an N-API/ABI mismatch or a missing shared library — ' +
    'e.g. libsqlcipher0 not installed for the primary/system-linked build.)');
}
console.log('[2/4] Loaded binding through Zalo sqlite3 wrapper');

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-sqlcipher-')), 'probe.db');

function probe() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) reject(new Error('open failed: ' + err.message));
    });
    // serialize() guarantees PRAGMA key runs before any read/write.
    db.serialize(() => {
      db.exec("PRAGMA key='" + KEY + "'", (e) => {
        if (e) reject(new Error('PRAGMA key failed: ' + e.message));
      });
      db.get('PRAGMA cipher_version', (e, row) => {
        if (e) return reject(new Error('PRAGMA cipher_version errored: ' + e.message));
        const ver = row && row.cipher_version;
        if (!ver || String(ver).trim() === '') return reject(new Error('CIPHER_ABSENT'));
        db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42);', (e2) => {
          if (e2) return reject(new Error('encrypted write failed: ' + e2.message));
          db.close((e3) => (e3 ? reject(e3) : resolve(ver)));
        });
      });
    });
  });
}

probe().then((ver) => {
  console.log('[3/4] PRAGMA cipher_version => ' + JSON.stringify(ver));
  // [4/4] The file on disk must NOT start with the plaintext SQLite header.
  const magic = fs.readFileSync(dbPath).subarray(0, 16).toString('latin1');
  if (magic.startsWith('SQLite format 3')) {
    fail('DB on disk is PLAINTEXT ("SQLite format 3") — the codec did not encrypt. Build lacks SQLCipher.');
  }
  console.log('[4/4] On-disk header is not plaintext SQLite => database is encrypted');
  console.log('\n\x1b[1m\x1b[32mSQLCIPHER VERIFY PASSED\x1b[0m (codec active, DB encrypted)\n');
  process.exit(0);
}).catch((err) => {
  if (err.message === 'CIPHER_ABSENT') {
    fail('PRAGMA cipher_version returned EMPTY.\n' +
      'The built node_sqlite3.node is VANILLA sqlite3 with NO SQLCipher codec.\n' +
      'A vanilla build silently ignores "PRAGMA key" and would store the Zalo DB in PLAINTEXT.\n' +
      'Rebuild against libsqlcipher (see scripts/patches/patch-sqlite3.js) or set ' +
      'ZALO_SQLCIPHER_FALLBACK=1 to use the @journeyapps/sqlcipher static build.');
  }
  fail(err.message);
});
```

- [ ] **Step 2: Create the patch `scripts/patches/patch-sqlite3.js`.** Builds node-sqlite3 from source linking system libsqlcipher (PRIMARY), with an automatic `@journeyapps/sqlcipher` static fallback, copies the `.node` into the linux slot, then runs the Step 1 verifier and throws on failure. Both builds happen in isolated temp dirs (each anchored with its own `package.json` so `npm install` cannot walk up and pollute the repo's `node_modules`). Write the full file:

```js
const { execSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');

// mapbox/TryGhost node-sqlite3 — its v6 N-API wrapper matches the bundle's own sqlite3.js.
const SQLITE_VERSION = '6.0.1';
// Fallback fork: statically bundles the SQLCipher amalgamation (no libsqlcipher0 runtime dep).
const FALLBACK_SPEC = '@journeyapps/sqlcipher@6.0.0';

// Electron shell version (ABI = N-API v6), pinned in root package.json.
const ELECTRON_VERSION = require(path.join(ROOT, 'package.json'))
  .devDependencies.electron.replace(/^[\^~]/, '');

const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding', 'napi-v6-linux-x64');
const DEST_NODE = path.join(DEST_DIR, 'node_sqlite3.node');
const SQLCIPHER_HEADER = '/usr/include/sqlcipher/sqlite3.h';

function sh(cmd, opts = {}) {
  logger.dim('$ ' + cmd);
  execSync(cmd, Object.assign({ stdio: 'inherit' }, opts));
}

// Isolated build dir anchored with a package.json so `npm install` installs HERE,
// never walking up into the repo's node_modules.
function mkScratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'zalo-native-build', private: true }) + '\n');
  return dir;
}

function nodeGyp(cwd, extraArgs, env) {
  const cmd = ['npx node-gyp rebuild', ...extraArgs,
    `--target=${ELECTRON_VERSION}`, '--arch=x64',
    '--dist-url=https://electronjs.org/headers'].join(' ');
  sh(cmd, { cwd, env: Object.assign({}, process.env, env || {}) });
}

// System dep: libsqlcipher-dev (headers under /usr/include/sqlcipher).
function ensureSqlcipherDev() {
  if (fs.existsSync(SQLCIPHER_HEADER)) { logger.dim('libsqlcipher headers: ' + SQLCIPHER_HEADER); return; }
  logger.info('Installing libsqlcipher-dev (requires sudo)...');
  try {
    sh('sudo apt-get update -qq');
    sh('sudo apt-get install -y libsqlcipher-dev');
  } catch (e) {
    throw new Error('Install libsqlcipher-dev manually: sudo apt-get install -y libsqlcipher-dev\n' + e.message);
  }
  if (!fs.existsSync(SQLCIPHER_HEADER)) {
    throw new Error('libsqlcipher-dev installed but header missing at ' + SQLCIPHER_HEADER);
  }
}

// PRIMARY: node-sqlite3 built from source, dynamically linking system libsqlcipher.
function buildPrimary() {
  ensureSqlcipherDev();
  const scratch = mkScratch('zalo-sqlite3-');
  logger.info(`PRIMARY: node-sqlite3@${SQLITE_VERSION} linked against system libsqlcipher`);
  sh(`npm install --no-save --ignore-scripts sqlite3@${SQLITE_VERSION}`, { cwd: scratch });
  const pkgDir = path.join(scratch, 'node_modules', 'sqlite3');
  if (!fs.existsSync(path.join(pkgDir, 'binding.gyp'))) throw new Error('node-sqlite3 source not fetched');

  // SQLCipher's sqlite3.h is in /usr/include/sqlcipher, NOT /usr/include. node-gyp folds env
  // CPPFLAGS into every compile (make.py: CXXFLAGS.target ?= $(CPPFLAGS) $(CXXFLAGS)), so this
  // makes `#include <sqlite3.h>` resolve. Prefer pkg-config; fall back to the fixed path.
  let cflags = '-I/usr/include/sqlcipher';
  try {
    const pc = execSync('pkg-config --cflags sqlcipher', { encoding: 'utf8' }).trim();
    if (pc) cflags = pc;
  } catch (_) { /* pkg-config or sqlcipher.pc absent — keep the fixed include path */ }

  nodeGyp(pkgDir, [
    '--napi_build_version=6',      // node-gyp 12.x won't set it; binding.gyp needs NAPI_VERSION=<(napi_build_version)
    '--sqlite=/usr',               // switch node-sqlite3 to external-link mode
    '--sqlite_libname=sqlcipher',  // -> links -lsqlcipher instead of -lsqlite3
  ], { CPPFLAGS: `${cflags} ${process.env.CPPFLAGS || ''}`.trim() });

  return path.join(pkgDir, 'build', 'Release', 'node_sqlite3.node');
}

// FALLBACK: @journeyapps/sqlcipher — binding.gyp hardcodes NAPI_VERSION=6 and compiles the
// bundled SQLCipher amalgamation with SQLITE_HAS_CODEC + SQLCIPHER_CRYPTO_OPENSSL (-lcrypto).
// No --napi/--sqlite flags needed; only runtime dep is libcrypto/OpenSSL.
function buildFallback() {
  const scratch = mkScratch('zalo-sqlcipher-');
  logger.info(`FALLBACK: ${FALLBACK_SPEC} (static SQLCipher amalgamation, links libcrypto)`);
  sh(`npm install --no-save --ignore-scripts ${FALLBACK_SPEC}`, { cwd: scratch });
  const jdir = path.join(scratch, 'node_modules', '@journeyapps', 'sqlcipher');
  if (!fs.existsSync(path.join(jdir, 'binding.gyp'))) throw new Error('@journeyapps/sqlcipher source not fetched');
  nodeGyp(jdir, []);
  return path.join(jdir, 'build', 'Release', 'node_sqlite3.node');
}

async function main() {
  let built;
  if (process.env.ZALO_SQLCIPHER_FALLBACK === '1') {
    built = buildFallback();
  } else {
    try {
      built = buildPrimary();
    } catch (e) {
      logger.warn('Primary SQLCipher build failed: ' + e.message);
      logger.warn('Falling back to ' + FALLBACK_SPEC + '...');
      built = buildFallback();
    }
  }
  if (!fs.existsSync(built)) throw new Error('SQLCipher build produced no node_sqlite3.node at ' + built);

  fs.ensureDirSync(DEST_DIR);
  fs.copyFileSync(built, DEST_NODE);
  logger.success('Installed SQLCipher node_sqlite3.node -> ' + DEST_NODE);

  // Fail-loud codec verification (child process so its exit code is captured, not our own).
  logger.info('Verifying SQLCipher codec is active...');
  try {
    sh(`node "${path.join(__dirname, 'verify-sqlite3.js')}"`, { cwd: ROOT });
  } catch (e) {
    throw new Error('SQLCipher verification FAILED — the built node_sqlite3.node lacks a working codec.');
  }
  logger.success('sqlite3 (SQLCipher) ready');
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
```

- [ ] **Step 3: Install the build-time system dependency.**
  - Run: `sudo apt-get update -qq && sudo apt-get install -y libsqlcipher-dev`
  - Run: `test -f /usr/include/sqlcipher/sqlite3.h && echo HEADER_OK`
  - Expected: `HEADER_OK` (the patch also self-installs this via `ensureSqlcipherDev()`, but installing now avoids a sudo prompt mid-build).

- [ ] **Step 4: Build the SQLCipher binding (requires `app/` extracted from Task 3).**
  - Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-sqlite3.js`
  - Expected (tail): node-gyp compiles without error, then
    ```
      ✔ Installed SQLCipher node_sqlite3.node -> app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node
    [1/4] ELF magic OK: ...
    [2/4] Loaded binding through Zalo sqlite3 wrapper
    [3/4] PRAGMA cipher_version => "4.6.1 community"
    [4/4] On-disk header is not plaintext SQLite => database is encrypted
    SQLCIPHER VERIFY PASSED (codec active, DB encrypted)
      ✔ sqlite3 (SQLCipher) ready
    ```
  - (The exact `cipher_version` string may differ, e.g. `"4.5.x community"`; only non-empty matters.)

- [ ] **Step 5: Confirm the binding is ELF and sits in the linux slot; confirm no repo pollution.**
  - Run: `file app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node`
  - Expected: `... ELF 64-bit LSB shared object, x86-64 ...`
  - Run: `ldd app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node | grep -E 'sqlcipher|crypto' || echo NONE`
  - Expected: primary build shows `libsqlcipher.so.0 => ...` (reminder: packaging must add `libsqlcipher0` to `build.linux.depends`); fallback build shows `libcrypto.so.* => ...` instead (no `libsqlcipher0` needed).
  - Run: `git status --porcelain | grep -E ' node_sqlite3.node$| app/' || echo CLEAN`
  - Expected: `CLEAN` — `app/` and `*.node` are gitignored, so only the two script files are new/untracked.

- [ ] **Step 6: Re-run the verifier standalone to confirm idempotent, independent pass.**
  - Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/verify-sqlite3.js; echo "exit=$?"`
  - Expected: prints `[1/4] ... [4/4] ...`, `SQLCIPHER VERIFY PASSED`, and `exit=0`.

- [ ] **Step 7: Commit (scripts only — the `.node` and `app/` are gitignored and never committed).**
  - Run:
    ```
    cd /mnt/data/Work/zalo-linux && \
    git add scripts/patches/patch-sqlite3.js scripts/patches/verify-sqlite3.js && \
    git commit -m "patch-sqlite3: build sqlite3 from source with SQLCipher + fail-loud codec verify"
    ```
  - Expected: one commit containing exactly `scripts/patches/patch-sqlite3.js` and `scripts/patches/verify-sqlite3.js`; `git show --stat HEAD` lists no `.node` and nothing under `app/`.

---

### Task 6: zfile native (build from source)

**Files:**
- Create `/mnt/data/Work/zalo-linux/nativelibs/zfile/binding.gyp` (copy verbatim)
- Create `/mnt/data/Work/zalo-linux/nativelibs/zfile/package.json` (copy verbatim)
- Create `/mnt/data/Work/zalo-linux/nativelibs/zfile/src/zfile.cc` (copy verbatim, ~293 lines — DO NOT paste)
- Create `/mnt/data/Work/zalo-linux/nativelibs/zfile/zfile-linux.js` (copy verbatim)
- Create `/mnt/data/Work/zalo-linux/scripts/patches/patch-zfile.js` (full code below)
- Test/Modify at runtime (produced by extraction, gitignored): `/mnt/data/Work/zalo-linux/app/native/nativelibs/zfile/linux/zfile-native.node`, `.../linux/zfile-linux.js`, patched `.../zfile/index.js`

**Interfaces:**
- **Consumes:** `nativelibs/builder.js` invoked as `node <builder> <libDir>` (from the builder task; reads root `package.json` `devDependencies.electron` = `"22.3.27"`, runs `node-gyp rebuild --target=<ver> --arch=x64 --dist-url=https://electronjs.org/headers`, npm-installs `node-addon-api` in libDir on first run). `scripts/utils/logger.js` exposing `{ step, info, dim, success, warn, error }`. Extracted bundle file `app/native/nativelibs/zfile/index.js` (from the extract task; original has a `win32`/`else` stub, no linux branch). Vendored source `nativelibs/zfile/*`.
- **Produces:** `scripts/patches/patch-zfile.js` exporting `async function main()` and `module.exports = { main }`. Invoked by the orchestrator `scripts/main.js` as the **5th** SETUP patch (order: patch-platform-id → patch-renderer-win32 → patch-sqlite3 → patch-db-cross-v4 → **patch-zfile** → patch-linux-guards). At runtime produces `app/native/nativelibs/zfile/linux/zfile-native.node` (ELF), `.../linux/zfile-linux.js` (Proxy wrapper), and splices `else if(process.platform === 'linux')` into `app/native/nativelibs/zfile/index.js`.

Confirmed source shape (already verified, so the implementer knows the regex will hit): the extracted `app/native/nativelibs/zfile/index.js` `getLib()` has `if(process.platform === 'win32'){…}` then `\n    else {\n        return {\n            stat: () => {},` — the patch's regex `/\}\s*else\s*\{\s*return\s*\{\s*\n?\s*stat:/` matches that `}else{return{...stat:` block and inserts the linux branch before the stub `else`.

- [ ] **Step 1: Create the vendored zfile source directory.**
  Run: `mkdir -p /mnt/data/Work/zalo-linux/nativelibs/zfile/src`
  Expected: no output, exit 0.

- [ ] **Step 2: Copy `binding.gyp` verbatim.**
  Copy verbatim from `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/binding.gyp` to `/mnt/data/Work/zalo-linux/nativelibs/zfile/binding.gyp`.
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/binding.gyp /mnt/data/Work/zalo-linux/nativelibs/zfile/binding.gyp`
  Expected: no output, exit 0. (Content: single `zfile-native` target, sources `src/zfile.cc`, `node-addon-api` include+gyp deps, `NAPI_DISABLE_CPP_EXCEPTIONS`, `-std=c++17 -O2`.)

- [ ] **Step 3: Copy `package.json` verbatim.**
  Copy verbatim from `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/package.json` to `/mnt/data/Work/zalo-linux/nativelibs/zfile/package.json`.
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/package.json /mnt/data/Work/zalo-linux/nativelibs/zfile/package.json`
  Expected: no output, exit 0. (Content: name `zfile-linux`, `main: index.js`, `dependencies: { node-addon-api: "^5.0.0" }`.)

- [ ] **Step 4: Copy `src/zfile.cc` verbatim (~293 lines, do not hand-edit).**
  Copy verbatim from `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/src/zfile.cc` to `/mnt/data/Work/zalo-linux/nativelibs/zfile/src/zfile.cc`.
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/src/zfile.cc /mnt/data/Work/zalo-linux/nativelibs/zfile/src/zfile.cc`
  Expected: no output, exit 0.
  Run: `grep -c 'NODE_API_MODULE(zfile_native, Init)' /mnt/data/Work/zalo-linux/nativelibs/zfile/src/zfile.cc`
  Expected: `1`

- [ ] **Step 5: Copy `zfile-linux.js` wrapper verbatim.**
  Copy verbatim from `/mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/zfile-linux.js` to `/mnt/data/Work/zalo-linux/nativelibs/zfile/zfile-linux.js`.
  Run: `cp /mnt/data/Work/Zalo/Zalo-linux/nativelibs/zfile/zfile-linux.js /mnt/data/Work/zalo-linux/nativelibs/zfile/zfile-linux.js`
  Expected: no output, exit 0. (Content: `require('./zfile-native.node')`, `resolveByPath` longest-prefix mount matcher, `getDiskInfo` returns a `Proxy` whose `get` trap resolves any absolute path to its containing mount entry.)

- [ ] **Step 6: Author `scripts/patches/patch-zfile.js` (full code, reproduced from reference — builds via `builder.js`, copies `.node` + wrapper, splices linux branch with fail-loud regex, runs `diskInfo()` post-condition probe).**
  Create `/mnt/data/Work/zalo-linux/scripts/patches/patch-zfile.js` with exactly:
  ```js
  const { execSync } = require('child_process');
  const fs = require('fs-extra');
  const path = require('path');
  const logger = require('../utils/logger');

  const ROOT = path.join(__dirname, '..', '..');
  const APP_DIR = path.join(ROOT, 'app');
  const BUILDER = path.join(ROOT, 'nativelibs', 'builder.js');
  const LIB_DIR = path.join(ROOT, 'nativelibs', 'zfile');
  const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zfile', 'linux');
  const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'zfile', 'index.js');

  async function main() {
    if (!fs.existsSync(path.join(LIB_DIR, 'binding.gyp'))) {
      throw new Error('zfile source not found at nativelibs/zfile — cannot build');
    }

    logger.info('Building zfile-native from source...');
    execSync(`node "${BUILDER}" "${LIB_DIR}"`, { cwd: ROOT, stdio: 'inherit' });

    const releaseDir = path.join(LIB_DIR, 'build', 'Release');
    const nodeFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'));
    if (nodeFiles.length === 0) throw new Error('zfile build produced no .node');

    fs.ensureDirSync(DEST_DIR);
    const destNode = path.join(DEST_DIR, 'zfile-native.node');
    fs.copyFileSync(path.join(releaseDir, nodeFiles[0]), destNode);
    logger.dim('Installed Linux zfile-native.node');

    // Install the JS wrapper that adds the path-resolving Proxy to getDiskInfo
    // (the renderer looks up disk info by absolute path, not by mount point).
    const wrapperSrc = path.join(LIB_DIR, 'zfile-linux.js');
    const destWrapper = path.join(DEST_DIR, 'zfile-linux.js');
    if (!fs.existsSync(wrapperSrc)) {
      throw new Error('zfile wrapper source not found at nativelibs/zfile/zfile-linux.js');
    }
    fs.copyFileSync(wrapperSrc, destWrapper);
    logger.dim('Installed Linux zfile-linux.js wrapper');

    // Insert a linux branch into index.js BEFORE the non-win32 stub `else`.
    if (!fs.existsSync(INDEX_JS)) {
      throw new Error('zfile/index.js not found — did extraction overlay app.asar.unpacked?');
    }
    let c = fs.readFileSync(INDEX_JS, 'utf8');
    if (!c.includes("process.platform === 'linux'")) {
      const before = c;
      // matches the stub: `}else{ return { stat... }` (whitespace-tolerant)
      c = c.replace(
        /\}\s*else\s*\{\s*return\s*\{\s*\n?\s*stat:/,
        "}else if(process.platform === 'linux'){\n        addon = require('./linux/zfile-linux.js');\n    }else{\n        return {\n            stat:"
      );
      if (c === before) {
        throw new Error("patch-zfile: could not insert linux branch — zfile/index.js format changed, update the regex");
      }
      fs.writeFileSync(INDEX_JS, c, 'utf8');
      logger.dim('Patched zfile/index.js with linux branch');
    } else {
      logger.dim('zfile/index.js already has linux branch');
    }

    // Post-conditions: fail hard if the native lib, the wrapper, or the branch did not land.
    if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) {
      throw new Error(`patch-zfile: post-condition failed — ${destNode} missing/empty`);
    }
    if (!fs.existsSync(destWrapper) || fs.statSync(destWrapper).size === 0) {
      throw new Error(`patch-zfile: post-condition failed — ${destWrapper} missing/empty`);
    }
    const after = fs.readFileSync(INDEX_JS, 'utf8');
    if (!after.includes("process.platform === 'linux'")) {
      throw new Error('patch-zfile: post-condition failed — linux branch not present in index.js');
    }
    // Load the wrapper the way the app does and assert diskInfo works.
    delete require.cache[require.resolve(INDEX_JS)];
    const zfile = require(INDEX_JS);
    const disks = await zfile.diskInfo();
    if (!disks || typeof disks !== 'object' || Object.keys(disks).length === 0) {
      throw new Error('patch-zfile: post-condition failed — zfile().diskInfo() returned no drives');
    }
    // The renderer looks up disk info by absolute path (e.g. the home dir), not
    // by mount point. Assert the path-resolving Proxy maps an arbitrary absolute
    // path to its containing mount entry (with a numeric totalSpace) — otherwise
    // the Data-Management screen throws `undefined.label` and spins forever.
    const probe = disks['/some/deep/nonexistent/path/for/postcondition'];
    if (!probe || typeof probe.totalSpace !== 'number' || probe.totalSpace <= 0) {
      throw new Error('patch-zfile: post-condition failed — diskInfo() Proxy did not resolve an absolute path to a mount entry (renderer by-path lookup would throw)');
    }

    logger.success('zfile installed');
  }

  if (require.main === module) main();
  module.exports = { main };
  ```

- [ ] **Step 7: Syntax-check the patch (no execution, no module resolution).**
  Run: `node --check /mnt/data/Work/zalo-linux/scripts/patches/patch-zfile.js`
  Expected: no output, exit 0.

- [ ] **Step 8: Run the patch against the extracted bundle and verify the native output.** (Preconditions: the extract task has populated `app/native/nativelibs/zfile/index.js`; root `package.json` has `devDependencies.electron = "22.3.27"`; build toolchain present: `build-essential`, `node-gyp`, and network for `node-addon-api` + Electron headers.)
  Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-zfile.js`
  Expected: build logs ending with `zfile installed` (last line), no thrown error, exit 0.
  Run: `file /mnt/data/Work/zalo-linux/app/native/nativelibs/zfile/linux/zfile-native.node`
  Expected: contains `ELF 64-bit LSB shared object, x86-64` (dynamically linked).
  Run: `grep -c "process.platform === 'linux'" /mnt/data/Work/zalo-linux/app/native/nativelibs/zfile/index.js`
  Expected: `1`

- [ ] **Step 9: Commit.**
  Run: `cd /mnt/data/Work/zalo-linux && git add nativelibs/zfile/binding.gyp nativelibs/zfile/package.json nativelibs/zfile/src/zfile.cc nativelibs/zfile/zfile-linux.js scripts/patches/patch-zfile.js && git commit -m "Add zfile native source + patch-zfile (build from source, splice linux branch)"`
  Expected: one commit created. (Note: `app/`, `nativelibs/zfile/build/`, and `*.node` are gitignored and must NOT be committed.)

---

### Task 7: patch-platform-id

**Files:**
- Create `/mnt/data/Work/zalo-linux/scripts/patches/patch-platform-id.js` (full code below)
- Modifies at runtime: `/mnt/data/Work/zalo-linux/app/main-dist/main.js` (single occurrence `case"LINUX":return 25;` → `case"LINUX":return 24;`)

**Interfaces:**
- **Consumes:** `scripts/utils/logger.js` exposing `{ step, info, dim, success, warn, error }`. Extracted bundle file `app/main-dist/main.js` (from the extract task).
- **Produces:** `scripts/patches/patch-platform-id.js` exporting `async function main()` and `module.exports = { main }`. Invoked by the orchestrator `scripts/main.js` as the **1st** SETUP patch (order: **patch-platform-id** → patch-renderer-win32 → patch-sqlite3 → patch-db-cross-v4 → patch-zfile → patch-linux-guards).

**Confirmed grep of the extracted 26.6.11 bundle** (source of truth for the target pattern): the minified main-process `getClientType` switch is `…toUpperCase()){case"DARWIN":return 23;case"WIN32":return 24;case"LINUX":return 25;default:throw new Er…`. The literal `case"LINUX":return 25;` occurs **exactly once** in each of:
- `main-dist/main.js` — **1 occurrence** → this is the patch target.
- `main-dist/compact-app.js` — 1 occurrence (identical switch; **not** targeted by the v1 reference patch).
- `main-dist/utility-process-media.js` — 1 occurrence (identical switch; **not** targeted).

Per the task scope ("main-process `getClientType`", verify on `app/main-dist/main.js` only) and the reference `patch-platform-id.js`, this patch touches **only `main-dist/main.js`**. The `compact-app.js` / `utility-process-media.js` occurrences are recorded here as a documented follow-up if renderer/utility client-type parity is later required. (`return 25;` in isolation also appears in unrelated DNS-record tables, e.g. `case"KEY":return 25;` — so all matching/verification is scoped to the `case"LINUX":` prefix, never bare `return 25`.)

**Deviations from the reference `patch-platform-id.js`** (to satisfy the canonical fail-loud convention for this critical patch, and §9's per-patch post-condition): the missing-file and pattern-not-found branches **throw** instead of `warn`+skip, and a post-condition re-reads the file to assert the replacement landed. The 25→24 replacement, the global `/g` regex, and the idempotent already-patched branch are reproduced unchanged.

- [ ] **Step 1: Author `scripts/patches/patch-platform-id.js` (full code).**
  Create `/mnt/data/Work/zalo-linux/scripts/patches/patch-platform-id.js` with exactly:
  ```js
  const fs = require('fs-extra');
  const path = require('path');
  const logger = require('../utils/logger');

  const MAIN = path.join(__dirname, '..', '..', 'app', 'main-dist', 'main.js');

  async function main() {
    if (!fs.existsSync(MAIN)) {
      throw new Error(`patch-platform-id: ${MAIN} not found — did extraction run (asar.extractAll -> app/)?`);
    }
    let c = fs.readFileSync(MAIN, 'utf8');
    if (c.includes('case"LINUX":return 25;')) {
      c = c.replace(/case"LINUX":return 25;/g, 'case"LINUX":return 24;');
      fs.writeFileSync(MAIN, c, 'utf8');
      logger.dim('platform-id: LINUX 25 -> 24 (client-type WIN32, enables E2EE history sync)');
    } else if (c.includes('case"LINUX":return 24;')) {
      logger.dim('platform-id: already patched (LINUX -> 24)');
    } else {
      throw new Error('patch-platform-id: pattern case"LINUX":return 25; not found in main.js — Zalo bundle format changed, update the regex');
    }
    // Post-condition (fail loud): the LINUX branch must now return 24 and never 25.
    const after = fs.readFileSync(MAIN, 'utf8');
    if (after.includes('case"LINUX":return 25;')) {
      throw new Error('patch-platform-id: post-condition failed — case"LINUX":return 25; still present');
    }
    if (!after.includes('case"LINUX":return 24;')) {
      throw new Error('patch-platform-id: post-condition failed — case"LINUX":return 24; not present');
    }
    logger.success('platform-id patched (getClientType LINUX -> 24)');
  }

  if (require.main === module) main();
  module.exports = { main };
  ```

- [ ] **Step 2: Syntax-check the patch (no execution).**
  Run: `node --check /mnt/data/Work/zalo-linux/scripts/patches/patch-platform-id.js`
  Expected: no output, exit 0.

- [ ] **Step 3: Run the patch against the extracted bundle and verify.** (Precondition: the extract task has populated `app/main-dist/main.js`.)
  Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-platform-id.js`
  Expected: log line ending with `platform-id patched (getClientType LINUX -> 24)`, no thrown error, exit 0.
  Run: `grep -c 'case"LINUX":return 24;' /mnt/data/Work/zalo-linux/app/main-dist/main.js`
  Expected: `1`
  Run: `grep -c 'case"LINUX":return 25;' /mnt/data/Work/zalo-linux/app/main-dist/main.js`
  Expected: `0`

- [ ] **Step 4: Verify idempotency (second run is a no-op, no throw).**
  Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-platform-id.js`
  Expected: log line `platform-id: already patched (LINUX -> 24)` then `platform-id patched ...`, exit 0.

- [ ] **Step 5: Commit.**
  Run: `cd /mnt/data/Work/zalo-linux && git add scripts/patches/patch-platform-id.js && git commit -m "Add patch-platform-id (main-dist getClientType LINUX 25 -> 24, fail-loud)"`
  Expected: one commit created. (`app/` is gitignored and must NOT be committed.)

---

### Task 8: patch-renderer-win32

**Files:**
- Create: `/mnt/data/Work/zalo-linux/scripts/patches/patch-renderer-win32.js`
- Create (test): `/mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-renderer-win32.test.js`
- Modifies at SETUP time (in place, not committed): every `.js` under `/mnt/data/Work/zalo-linux/app/pc-dist/` containing an anchor — specifically the 2 `platform:"DARWIN"` sites and the 6 `getClientType(){return 23}` sites listed above.

**Interfaces:**
- Consumes: `app/pc-dist/**/*.js` produced by the extract task (Task: extract-installer); `scripts/utils/logger.js` (`logger.dim/success/warn/error/formatPath`).
- Produces: `module.exports = { main }` — `async function main(): Promise<void>`. Called by orchestrator as `await require('./patches/patch-renderer-win32.js').main()` (2nd of the 6 patches).

- [ ] **Step 1: Create the patch file.** Write `/mnt/data/Work/zalo-linux/scripts/patches/patch-renderer-win32.js` with EXACTLY this content:
```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const PC_DIST = path.join(__dirname, '..', '..', 'app', 'pc-dist');

// Exact literals from bundle 26.6.11 (verified by grep). Load-bearing for the win32
// titlebar the renderer draws on Zalo's frameless (frame:false) Linux windows:
//   - platform prop: the login title bar renders min/close only on `"WIN32"===platform`
//     (q.a.createElement("div",{className:"login-title-bar"},"WIN32"===e&&...fa-Minus/fa-Close))
//   - getClientType: renderer client-type, 23=DARWIN -> 24=WIN32
// The many COSMETIC "DARWIN" occurrences (CSS classNames via "DARWIN".toLowerCase(),
// OS:{DARWIN:"DARWIN"} const map, platform:["WEB","DARWIN","WIN32"] arrays, os/os_name
// logging, parseKeyFromUrl("DARWIN",...)) are intentionally NOT matched — we only replace
// the two prefixed literals below, never a bare "DARWIN".
const REPLACEMENTS = [
  { name: 'platform prop', from: 'platform:"DARWIN"', to: 'platform:"WIN32"', expected: 2 },
  { name: 'getClientType', from: 'getClientType(){return 23}', to: 'getClientType(){return 24}', expected: 6 },
];

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function main() {
  if (!fs.existsSync(PC_DIST)) {
    throw new Error(`patch-renderer-win32: ${logger.formatPath(PC_DIST)} not found (run extract first)`);
  }

  const files = collectJsFiles(PC_DIST);
  if (files.length === 0) {
    throw new Error(`patch-renderer-win32: no .js files under ${logger.formatPath(PC_DIST)}`);
  }

  for (const rep of REPLACEMENTS) {
    let replaced = 0;
    let alreadyPatched = 0;

    for (const file of files) {
      let content = fs.readFileSync(file, 'utf8');
      const hitsOld = countOccurrences(content, rep.from);
      // Count existing target markers BEFORE we touch this file (idempotency signal).
      alreadyPatched += countOccurrences(content, rep.to);
      if (hitsOld > 0) {
        content = content.split(rep.from).join(rep.to);
        fs.writeFileSync(file, content, 'utf8');
        replaced += hitsOld;
        logger.dim(`${rep.name}: ${hitsOld}x in ${logger.formatPath(file)}`);
      }
    }

    if (replaced === 0 && alreadyPatched === 0) {
      // Fail loud: anchor vanished => Zalo changed the bundle. Do not ship a titlebar-less build.
      throw new Error(
        `patch-renderer-win32: anchor for "${rep.name}" (${rep.from}) not found in any pc-dist .js, ` +
        `and no already-patched marker (${rep.to}) present. Bundle format changed — patch must be re-derived.`
      );
    }

    if (replaced === 0) {
      logger.dim(`${rep.name}: already patched (${alreadyPatched}x ${rep.to} present)`);
    } else {
      logger.success(`${rep.name}: replaced ${replaced}x -> ${rep.to}`);
      if (replaced !== rep.expected) {
        logger.warn(`${rep.name}: expected ${rep.expected} occurrences for 26.6.11, replaced ${replaced} — verify bundle version.`);
      }
    }
  }

  logger.success('renderer-win32: platform+client-type spoofed to WIN32 (Zalo draws min/max/close on frameless Linux windows)');
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main };
```

- [ ] **Step 2: Create a fixture-based unit test.** Write `/mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-renderer-win32.test.js` with EXACTLY this content (uses only Node built-ins + the patch module; no test framework required — run with `node`):
```js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Point the patch at a temp "app/pc-dist" by faking the repo root two levels up.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zrw-'));
const repo = path.join(tmp, 'repo');
const pcDist = path.join(repo, 'app', 'pc-dist', 'lazy');
fs.ensureDirSync(pcDist);
// scripts/patches/patch-renderer-win32.js resolves PC_DIST as ../../app/pc-dist
const patchDir = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-renderer-win32.js'), path.join(patchDir, 'patch-renderer-win32.js'));

const sample = 'a({platform:"DARWIN",v:1});getClientType(){return 23}getClientType(){return 23}"DARWIN".toLowerCase();OS:{DARWIN:"DARWIN"}';
const file = path.join(pcDist, 'main-startup.abcdef.js');
fs.writeFileSync(file, sample, 'utf8');

const { main } = require(path.join(patchDir, 'patch-renderer-win32.js'));

(async () => {
  await main();
  let out = fs.readFileSync(file, 'utf8');
  assert(out.includes('platform:"WIN32"'), 'platform prop replaced');
  assert(!out.includes('platform:"DARWIN"'), 'no platform:"DARWIN" left');
  assert.strictEqual(out.split('getClientType(){return 24}').length - 1, 2, 'both getClientType replaced');
  assert(!out.includes('getClientType(){return 23}'), 'no return 23 left');
  // Cosmetic DARWIN untouched:
  assert(out.includes('"DARWIN".toLowerCase()'), 'cosmetic className untouched');
  assert(out.includes('OS:{DARWIN:"DARWIN"}'), 'const map untouched');
  // Idempotent second run must not throw and must not double-change:
  await main();
  const out2 = fs.readFileSync(file, 'utf8');
  assert.strictEqual(out, out2, 'idempotent');
  // Fail-loud when anchors absent:
  fs.writeFileSync(file, 'nothing to see here', 'utf8');
  let threw = false;
  try { await main(); } catch (_) { threw = true; }
  assert(threw, 'fail-loud when anchors gone');
  fs.removeSync(tmp);
  console.log('OK patch-renderer-win32');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the unit test.**
  Run: `node /mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-renderer-win32.test.js`
  Expected: last line `OK patch-renderer-win32` and exit code 0.

- [ ] **Step 4: Verify against the real extracted bundle (requires a prior SETUP extract).**
  Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-renderer-win32.js`
  Expected: log lines including `platform prop: replaced 2x -> platform:"WIN32"` and `getClientType: replaced 6x -> getClientType(){return 24}` (a re-run instead prints `already patched`).

- [ ] **Step 5: Post-condition greps confirm the flip.**
  Run: `cd /mnt/data/Work/zalo-linux && grep -roF 'platform:"WIN32"' app/pc-dist | wc -l && grep -roF 'platform:"DARWIN"' app/pc-dist | wc -l && grep -roF 'getClientType(){return 24}' app/pc-dist | wc -l && grep -roF 'getClientType(){return 23}' app/pc-dist | wc -l`
  Expected (four lines): `2`, `0`, `6`, `0`.

- [ ] **Step 6: Manual GNOME render check (runtime, documented — not automatable here).** After a full SETUP + `./run-dev.sh` on a GNOME/x64 desktop: the **login** window must show minimize + close controls (win32 branch); confirm the **main** window's min/max/close render and that drag/double-click-maximize works. If the main window lacks controls, the fix belongs to the shell/main task (not this patch) — record the result per spec §12.

- [ ] **Step 7: Commit.**
  Run: `cd /mnt/data/Work/zalo-linux && git add scripts/patches/patch-renderer-win32.js scripts/patches/__tests__/patch-renderer-win32.test.js && git commit -m "Add patch-renderer-win32: spoof renderer platform/client-type to WIN32 for titlebar controls"`

---

### Task 9: patch-linux-guards

**Files:**
- Create: `/mnt/data/Work/zalo-linux/scripts/patches/patch-linux-guards.js`
- Create (test): `/mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-linux-guards.test.js`
- Modifies at SETUP time (in place, not committed):
  - `/mnt/data/Work/zalo-linux/app/main-dist/main.js` — insert a Linux short-circuit at the start of `checkAppSigned()` (single site).
  - `/mnt/data/Work/zalo-linux/app/native/nativelibs/zwalker/index.js` — replace the final `if (!nativeBinding) {…}` throw block with a Linux stub branch.
  - `/mnt/data/Work/zalo-linux/app/native/nativelibs/mp4thumb/index.js` — inject a Linux short-circuit as the first statement of `getLib()`'s `try` (routes to its existing stub).
  - `/mnt/data/Work/zalo-linux/app/native/nativelibs/v8-profiles/index.js` — wrap the top-level `binding` require in try/catch with a Linux stub.

**Interfaces:**
- Consumes: `app/main-dist/main.js` and `app/native/nativelibs/{zwalker,mp4thumb,v8-profiles}/index.js` produced by extract (+ its `.unpacked` overlay); `scripts/utils/logger.js`.
- Produces: `module.exports = { main }` — `async function main(): Promise<void>`. Called LAST by the orchestrator: `await require('./patches/patch-linux-guards.js').main()`.

- [ ] **Step 1: Create the patch file.** Write `/mnt/data/Work/zalo-linux/scripts/patches/patch-linux-guards.js` with EXACTLY this content:
```js
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP = path.join(__dirname, '..', '..', 'app');
const MAIN = path.join(APP, 'main-dist', 'main.js');
const NL = path.join(APP, 'native', 'nativelibs');
const ZWALKER = path.join(NL, 'zwalker', 'index.js');
const MP4THUMB = path.join(NL, 'mp4thumb', 'index.js');
const V8PROF = path.join(NL, 'v8-profiles', 'index.js');

// ---- (a) main.js: short-circuit checkAppSigned() on Linux -------------------
// Original (bundle 26.6.11) spawns macOS `codesign --verify <app>`; on Linux that
// fails. We return isAppSigned=false immediately (no spawn). Effect per spec §7:
// isAppSigned=false => secure key stored via safeStorage/libsecret if present,
// otherwise raw (accepted for v1).
const CAS_ANCHOR = 'async checkAppSigned(){return null!=this.isAppSigned?';
const CAS_PATCHED = "async checkAppSigned(){if(process.platform==='linux')return this.isAppSigned=!1,!1;return null!=this.isAppSigned?";
const CAS_MARKER = "async checkAppSigned(){if(process.platform==='linux')";

// ---- (b) native loaders: don't crash when the Linux binary is absent --------

// zwalker throws at LOAD via the final block when no linux .node exists.
const ZW_ANCHOR = [
  'if (!nativeBinding) {',
  '  if (loadError) {',
  '    throw loadError',
  '  }',
  '  throw new Error(`Failed to load native binding`)',
  '}',
].join('\n');
const ZW_PATCHED = [
  'if (!nativeBinding) {',
  '  if (process.platform === \'linux\') {',
  '    // Linux v1: no prebuilt zwalker binary (storage-GC out of scope). Stub so load does not crash.',
  '    nativeBinding = {',
  '      scanDirectory: () => [],',
  '      updateReferenceMessageId: () => {},',
  '      deleteHomelessFiles: () => [],',
  '      statUnmarkedFiles: () => [],',
  '      deleteEmptyFolders: () => [],',
  '    };',
  '  } else if (loadError) {',
  '    throw loadError',
  '  } else {',
  '    throw new Error(`Failed to load native binding`)',
  '  }',
  '}',
].join('\n');
const ZW_MARKER = 'no prebuilt zwalker binary';

// mp4thumb already installs a stub in its catch; force Linux straight into it
// (avoids require()-ing a Mach-O .node on Linux and the noisy console.error path).
const MP_ANCHOR = '    let thumbModule = null;\n    try {';
const MP_PATCHED = '    let thumbModule = null;\n    try {\n        if (process.platform === \'linux\') throw new Error("mp4thumb: no Linux prebuilt (video thumbnails out of v1 scope)");';
const MP_MARKER = 'mp4thumb: no Linux prebuilt';

// v8-profiles requires a Mac .node at module top on Linux => throws at LOAD.
const V8_ANCHOR = "var binding = process.platform === 'win32' ? (process.arch === 'ia32' ? require('./profiler_electron1.8_win32_ia32.node') : require('./profiler_electron1.8_win32_x64.node')) : require('./profiler_electron1.8_mac.node')";
const V8_PATCHED = [
  'var binding;',
  'try {',
  "  binding = process.platform === 'win32' ? (process.arch === 'ia32' ? require('./profiler_electron1.8_win32_ia32.node') : require('./profiler_electron1.8_win32_x64.node')) : require('./profiler_electron1.8_mac.node');",
  '} catch (e) {',
  '  // Linux v1: no prebuilt v8-profiles binary (CPU profiler out of scope). Stub so load does not crash.',
  '  binding = { cpu: { profiles: {}, startProfiling: function () {}, stopProfiling: function () { return {}; }, setSamplingInterval: function () {} } };',
  '}',
].join('\n');
const V8_MARKER = 'no prebuilt v8-profiles binary';

// Apply one anchor->replacement edit, idempotently and fail-loud.
function applyGuard(file, anchor, replacement, marker, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`patch-linux-guards: ${logger.formatPath(file)} not found (run extract + .unpacked overlay first)`);
  }
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes(marker)) {
    logger.dim(`${label}: already patched`);
    return;
  }
  if (!content.includes(anchor)) {
    throw new Error(`patch-linux-guards: anchor for ${label} not found in ${logger.formatPath(file)}. Bundle format changed — patch must be re-derived.`);
  }
  content = content.split(anchor).join(replacement);
  fs.writeFileSync(file, content, 'utf8');
  logger.success(`${label}: guarded`);
}

async function main() {
  applyGuard(MAIN, CAS_ANCHOR, CAS_PATCHED, CAS_MARKER, 'checkAppSigned (Linux skip)');
  applyGuard(ZWALKER, ZW_ANCHOR, ZW_PATCHED, ZW_MARKER, 'zwalker loader');
  applyGuard(MP4THUMB, MP_ANCHOR, MP_PATCHED, MP_MARKER, 'mp4thumb loader');
  applyGuard(V8PROF, V8_ANCHOR, V8_PATCHED, V8_MARKER, 'v8-profiles loader');
  logger.success('linux-guards: codesign short-circuited + zwalker/mp4thumb/v8-profiles loaders guarded');
}

if (require.main === module) {
  main().catch((e) => { logger.error(e.message); process.exit(1); });
}

module.exports = { main };
```

- [ ] **Step 2: Create a unit test for the loader guards.** Write `/mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-linux-guards.test.js` with EXACTLY this content (copies the real unpacked loader sources into a temp tree, patches them, then requires each on Linux and asserts no throw):
```js
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('assert');
const cp = require('child_process');

const REF = '/tmp/claude-1000/-mnt-data-Work-zalo-linux/4b920b94-ed2d-4cc3-95bc-d6ce8bb9f3bd/scratchpad/asar-src';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zlg-'));
const repo = path.join(tmp, 'repo');
const appNL = path.join(repo, 'app', 'native', 'nativelibs');
const appMD = path.join(repo, 'app', 'main-dist');
fs.ensureDirSync(path.join(appNL, 'zwalker'));
fs.ensureDirSync(path.join(appNL, 'mp4thumb'));
fs.ensureDirSync(path.join(appNL, 'v8-profiles'));
fs.ensureDirSync(appMD);
fs.ensureDirSync(path.join(repo, 'scripts', 'utils'));
const scriptsPatches = path.join(repo, 'scripts', 'patches');
fs.ensureDirSync(scriptsPatches);

// Copy real loader sources + a minimal main.js containing the checkAppSigned anchor.
fs.copyFileSync(path.join(REF, 'native/nativelibs/zwalker/index.js'), path.join(appNL, 'zwalker', 'index.js'));
fs.copyFileSync(path.join(REF, 'native/nativelibs/mp4thumb/index.js'), path.join(appNL, 'mp4thumb', 'index.js'));
fs.copyFileSync(path.join(REF, 'native/nativelibs/v8-profiles/index.js'), path.join(appNL, 'v8-profiles', 'index.js'));
fs.writeFileSync(path.join(appMD, 'main.js'),
  'class C{async checkAppSigned(){return null!=this.isAppSigned?this.isAppSigned:!1}}\nmodule.exports=C;', 'utf8');

fs.copyFileSync(path.join(__dirname, '..', '..', 'utils', 'logger.js'), path.join(repo, 'scripts', 'utils', 'logger.js'));
fs.copyFileSync(path.join(__dirname, '..', 'patch-linux-guards.js'), path.join(scriptsPatches, 'patch-linux-guards.js'));

const { main } = require(path.join(scriptsPatches, 'patch-linux-guards.js'));

(async () => {
  await main();

  // main.js: Linux short-circuit inserted.
  const m = fs.readFileSync(path.join(appMD, 'main.js'), 'utf8');
  assert(m.includes("async checkAppSigned(){if(process.platform==='linux')return this.isAppSigned=!1,!1;"), 'checkAppSigned guarded');

  // Each guarded loader must require() without throwing on Linux (run in a child so
  // a stray throw fails the child, not this process).
  for (const mod of ['zwalker', 'mp4thumb', 'v8-profiles']) {
    const p = path.join(appNL, mod, 'index.js');
    const r = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(p)});console.log('ok')`], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${mod} require threw: ${r.stderr}`);
    assert(r.stdout.includes('ok'), `${mod} require did not complete`);
  }

  // zwalker stub exports the 5 functions.
  const zw = require(path.join(appNL, 'zwalker', 'index.js'));
  for (const fn of ['scanDirectory', 'updateReferenceMessageId', 'deleteHomelessFiles', 'statUnmarkedFiles', 'deleteEmptyFolders']) {
    assert.strictEqual(typeof zw[fn], 'function', `zwalker.${fn} present`);
  }

  // Idempotent second run must not throw.
  await main();

  fs.removeSync(tmp);
  console.log('OK patch-linux-guards');
})().catch((e) => { console.error(e); process.exit(1); });
```
> Note: this test assumes it runs on Linux (the target platform). `process.platform==='linux'` is the branch under test.

- [ ] **Step 3: Run the unit test.**
  Run: `node /mnt/data/Work/zalo-linux/scripts/patches/__tests__/patch-linux-guards.test.js`
  Expected: last line `OK patch-linux-guards` and exit code 0.

- [ ] **Step 4: Apply against the real extracted bundle (requires a prior SETUP extract + overlay).**
  Run: `cd /mnt/data/Work/zalo-linux && node scripts/patches/patch-linux-guards.js`
  Expected: `checkAppSigned (Linux skip): guarded`, `zwalker loader: guarded`, `mp4thumb loader: guarded`, `v8-profiles loader: guarded` (a re-run prints `already patched` for each).

- [ ] **Step 5: Verify the checkAppSigned short-circuit landed exactly once.**
  Run: `cd /mnt/data/Work/zalo-linux && grep -oF "checkAppSigned(){if(process.platform==='linux')" app/main-dist/main.js | wc -l`
  Expected: `1`.

- [ ] **Step 6: Verify each guarded loader requires without throwing on Linux.**
  Run: `cd /mnt/data/Work/zalo-linux && for m in zwalker mp4thumb v8-profiles; do node -e "require('./app/native/nativelibs/$m/index.js'); console.log('$m ok')"; done`
  Expected: `zwalker ok`, `mp4thumb ok`, `v8-profiles ok` (mp4thumb may print a `Failed to load mp4thumb module: mp4thumb: no Linux prebuilt …` line to stderr — that is the intended stub path, exit code stays 0).

- [ ] **Step 7: Commit.**
  Run: `cd /mnt/data/Work/zalo-linux && git add scripts/patches/patch-linux-guards.js scripts/patches/__tests__/patch-linux-guards.test.js && git commit -m "Add patch-linux-guards: skip macOS codesign on Linux and guard zwalker/mp4thumb/v8-profiles loaders"`

---

### Task 10: Electron shell `main.js`

**Files:**
- Create `/mnt/data/Work/zalo-linux/main.js`
- (reference only, read-only) `/mnt/data/Work/Zalo/Zalo-linux/main.js` — reuse the boot-order comment, strip the `console.log` titlebar injection.

**Interfaces:**
- **Consumes:** the extracted bundle at `app/` (produced by Task 2 extract) — specifically `app/bootstrap.js` and the XDG-aware `app/main-dist/*`. Renderer now draws its own win32 titlebar (produced by Task 8 `patch-renderer-win32`), so the shell adds no window chrome.
- **Produces:** the Electron app entry (`package.json.main == "main.js"`, set in Task 1). No exports. Resolves `appDir`, `process.chdir(appDir)`, then `require(app/bootstrap.js)` **synchronously at top level**.

Steps:

- [ ] **Step 1: Write the clean shell entry.** Create `/mnt/data/Work/zalo-linux/main.js` with EXACTLY this content (no titlebar hack, no `console-message` plumbing — the renderer's win32 controls handle min/max/close via the bundle's own IPC):

```js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Resolve the extracted Zalo bundle. During dev, app/ sits next to this shell
// entry (repo root). Once packaged, electron-builder copies it via extraFiles to
// sit next to the Electron executable, so fall back to <execPath>/../app.
const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');

// Hide the GTK menu bar on every window. Zalo draws its own win32 titlebar in the
// renderer now (see patch-renderer-win32: client-type is spoofed to WIN32/24), so
// no native window chrome is wanted. Do NOT flip frame:false -> true and do NOT
// inject a custom titlebar — that path (old main.js) is dropped by design.
app.on('browser-window-created', (_e, win) => {
  try { win.setMenuBarVisibility(false); } catch (_) {}
});

// Zalo's bootstrap.js -> main-dist/main.js registers app.on('ready') at TOP LEVEL,
// so it MUST be required synchronously BEFORE 'ready' fires. Requiring it inside
// app.whenReady() would run after 'ready' and no window would ever open. This
// mirrors the bundle's original entry point (its package.json main == bootstrap.js).
const bootstrapPath = path.join(appDir, 'bootstrap.js');
if (!fs.existsSync(bootstrapPath)) {
  console.error('Zalo bootstrap.js not found at:', bootstrapPath);
  process.exit(1);
}
process.chdir(appDir);
try {
  require(bootstrapPath);
} catch (e) {
  console.error('Error loading Zalo:', e);
  process.exit(1);
}
```

- [ ] **Step 2: Verify it parses and reports a clear error without a bundle.** With no `app/` present yet, the shell must fail loud (not hang):
  - Run: `cd /mnt/data/Work/zalo-linux && node -e "require('./main.js')" 2>&1 | head -1`
  - Expected: `Zalo bootstrap.js not found at: /mnt/data/Work/zalo-linux/app/bootstrap.js` (process exits 1). This confirms `appDir` resolution and the fail-loud guard. (Under plain `node` the `electron` require may throw first; that is fine — the assertion is that it does NOT silently succeed.)

- [ ] **Step 3: Confirm the titlebar hack is gone.** The old `console.log`-signalled titlebar must not reappear:
  - Run: `grep -c '__ZTB__\|console-message\|TITLEBAR_JS' /mnt/data/Work/zalo-linux/main.js`
  - Expected: `0`

- [ ] **Step 4: Commit.**
  - Run: `cd /mnt/data/Work/zalo-linux && git add main.js && git commit -m "Add clean Electron shell entry (main.js)"`

---

### Task 11: Orchestrator `scripts/main.js`

**Files:**
- Create `/mnt/data/Work/zalo-linux/scripts/main.js`
- (reference, read-only) `/mnt/data/Work/Zalo/Zalo-linux/scripts/main.js` — same SETUP/BUILD gating, updated patch list.

**Interfaces:**
- **Consumes** (each is `module.exports = { main }`, `main()` is `async`):
  - `scripts/download-installer.js` `main()` — Task 2. Sets `process.env.ZALO_DMG` on success.
  - `scripts/extract-installer.js` `main()` — Task 2. Reads `process.env.ZALO_DMG`, writes `app/`.
  - `scripts/patches/patch-platform-id.js` `main()` — Task 7
  - `scripts/patches/patch-renderer-win32.js` `main()` — Task 8
  - `scripts/patches/patch-sqlite3.js` `main()` — Task 5
  - `scripts/patches/patch-db-cross-v4.js` `main()` — Task 4
  - `scripts/patches/patch-zfile.js` `main()` — Task 6
  - `scripts/patches/patch-linux-guards.js` `main()` — Task 9
  - `scripts/build.js` `main()` — Task 13
  - `scripts/utils/logger.js` — Task 1 (`step/info/dim/success/warn/error`).
- **Produces:** the CLI orchestrator driven by `SETUP` / `BUILD` env vars (invoked via `npm run setup` / `npm run build` / `npm run main`, defined in Task 1's package.json).

Steps:

- [ ] **Step 1: Write the orchestrator wiring the 6 patches in canonical order.** Create `/mnt/data/Work/zalo-linux/scripts/main.js` with EXACTLY:

```js
const logger = require('./utils/logger');

async function main() {
  logger.step('Zalo for Linux workflow');
  try {
    if (process.env.SETUP === 'true') {
      // 1. Download the macOS DMG unless a local one is provided via ZALO_DMG.
      //    download-installer sets process.env.ZALO_DMG so extract picks it up.
      if (!process.env.ZALO_DMG) {
        logger.step('Downloading installer');
        await require('./download-installer.js').main();
      }

      // 2. Extract app.asar -> app/, overlay app.asar.unpacked, rename package.json.
      logger.step('Extracting installer');
      await require('./extract-installer.js').main();

      // 3. Patches, in fixed order. Each is idempotent; critical ones throw on
      //    pattern drift (fail loud when Zalo bumps version).
      //      platform-id   : main-dist -> client-type LINUX 25 -> 24 (unlocks E2EE sync)
      //      renderer-win32: pc-dist   -> DARWIN->WIN32 + getClientType 23->24
      //                      (renderer draws native win32 min/max/close on frameless win)
      //      sqlite3       : build SQLCipher .node -> napi-v6-linux-x64 slot
      //      db-cross-v4   : build .node + splice linux branch into dist/binding.js
      //      zfile         : build .node + splice linux branch into index.js (parity)
      //      linux-guards  : short-circuit codesign() + guard zwalker/mp4thumb/v8-profiles
      logger.step('Applying patches');
      await require('./patches/patch-platform-id.js').main();
      await require('./patches/patch-renderer-win32.js').main();
      await require('./patches/patch-sqlite3.js').main();
      await require('./patches/patch-db-cross-v4.js').main();
      await require('./patches/patch-zfile.js').main();
      await require('./patches/patch-linux-guards.js').main();
      logger.success('All patches applied');
    }

    if (process.env.BUILD === 'true') {
      logger.step('Building .deb');
      await require('./build.js').main();
    }
  } catch (e) {
    logger.error('Workflow failed:', e.message);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Verify the module loads and the patch order is the canonical six.** (Dependencies may not exist yet, so only check the require wiring and ordering statically.)
  - Run: `cd /mnt/data/Work/zalo-linux && grep -oE "patch-[a-z0-9-]+\.js" scripts/main.js | sed 's/patch-//;s/\.js//' | paste -sd,`
  - Expected: `platform-id,renderer-win32,sqlite3,db-cross-v4,zfile,linux-guards`

- [ ] **Step 3: Verify SETUP is skipped when neither env var is set (no accidental work).**
  - Run: `cd /mnt/data/Work/zalo-linux && node scripts/main.js`
  - Expected: prints the `==> Zalo for Linux workflow` step header and exits 0 (no download/extract because `SETUP` unset).

- [ ] **Step 4: Commit.**
  - Run: `cd /mnt/data/Work/zalo-linux && git add scripts/main.js && git commit -m "Add SETUP/BUILD orchestrator with 6-patch pipeline"`

---

### Task 12: Smoke boot test

**Files:**
- Create `/mnt/data/Work/zalo-linux/scripts/_smoke-main.js` (throwaway Electron entry that wraps the real `main.js` with assertions — keeps `main.js` clean).
- Create `/mnt/data/Work/zalo-linux/scripts/_smoke-boot.sh` (headless runner, `chmod +x`).

**Interfaces:**
- **Consumes:** `main.js` (Task 10) and a fully prepared `app/` — i.e. a real DMG **extracted + patched + native `.node` built** (Tasks 2-9). This test does **not** log in; it only exercises the boot path. Required `.node` slots (asserted before launch):
  - `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node`
  - `app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node`
- **Produces:** an exit-code contract: `0` = a `BrowserWindow` was created and the process stayed alive with no `uncaughtException` / `render-process-gone` / "Error loading Zalo" during the settle window (proving `sqlite3`/`db-cross-v4` imports did not throw the main process); non-zero otherwise.

Steps:

- [ ] **Step 1: Write the instrumented Electron entry.** Create `/mnt/data/Work/zalo-linux/scripts/_smoke-main.js`:

```js
// Smoke-only Electron entry. Registers boot assertions, then loads the REAL shell
// (../main.js). Kept out of main.js so the shipped entry stays clean.
// Run indirectly via scripts/_smoke-boot.sh (needs xvfb + a prepared app/).
const { app } = require('electron');
const path = require('path');

const SETTLE_MS = parseInt(process.env.SMOKE_SETTLE_MS || '10000', 10); // renderer boot grace
const NO_WINDOW_MS = parseInt(process.env.SMOKE_WINDOW_MS || '45000', 10);

let done = false;
function finish(code, msg) {
  if (done) return;
  done = true;
  if (code === 0) console.log('SMOKE_OK:', msg);
  else console.error('SMOKE_FAIL:', msg);
  try { app.exit(code); } catch (_) { process.exit(code); }
}

// If no window ever appears, the boot path is broken -> fail.
const noWindowTimer = setTimeout(
  () => finish(1, `no BrowserWindow within ${NO_WINDOW_MS}ms`), NO_WINDOW_MS);

process.on('uncaughtException', (e) =>
  finish(1, 'uncaughtException: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) =>
  finish(1, 'unhandledRejection: ' + ((e && e.stack) || e)));

app.on('browser-window-created', (_e, win) => {
  clearTimeout(noWindowTimer);
  const wc = win.webContents;
  wc.on('render-process-gone', (_ev, d) =>
    finish(1, 'render-process-gone: ' + JSON.stringify(d)));
  // Let the renderer boot far enough to pull native modules (sqlite3 opens the
  // encrypted DB; db-cross-v4 loads in the shared worker), then declare success.
  setTimeout(() => finish(0, 'window created and stayed alive'), SETTLE_MS);
});

// Boot the real shell (registers Zalo's app.on('ready') synchronously). main.js
// resolves app/ from its own __dirname (repo root), regardless of this wrapper.
require(path.join(__dirname, '..', 'main.js'));
```

- [ ] **Step 2: Write the headless runner.** Create `/mnt/data/Work/zalo-linux/scripts/_smoke-boot.sh`:

```bash
#!/usr/bin/env bash
# Headless smoke boot. Verifies the shell boots the Zalo bundle far enough to
# create a window WITHOUT throwing when native modules (sqlite3, db-cross-v4)
# load. REQUIRES a completed SETUP: app/ extracted + patched + native .node built
# (Tasks 2-9). Does NOT log in. Usage: scripts/_smoke-boot.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset ELECTRON_RUN_AS_NODE

SQLITE_NODE="app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node"
DBCROSS_NODE="app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node"
for f in "app/bootstrap.js" "$SQLITE_NODE" "$DBCROSS_NODE"; do
  if [ ! -e "$f" ]; then
    echo "SMOKE_FAIL: missing $f -- run SETUP first (npm run setup)"; exit 2
  fi
done

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "SMOKE_FAIL: xvfb-run not found -- sudo apt-get install -y xvfb"; exit 2
fi

LOG="$(mktemp)"
# Outer timeout is a backstop; the harness self-exits (0 ok / 1 fail).
timeout 120 xvfb-run -a --server-args="-screen 0 1280x800x24" \
  npx electron scripts/_smoke-main.js --no-sandbox --disable-gpu 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}

if [ "$rc" -eq 0 ] && grep -q "SMOKE_OK:" "$LOG"; then
  echo "smoke boot OK"; rm -f "$LOG"; exit 0
else
  echo "smoke boot FAILED (rc=$rc)"; rm -f "$LOG"; exit 1
fi
```

- [ ] **Step 3: Make it executable.**
  - Run: `chmod +x /mnt/data/Work/zalo-linux/scripts/_smoke-boot.sh`

- [ ] **Step 4: Verify the fail-fast guard (before any SETUP).** With no `app/`, the runner must refuse clearly instead of launching Electron:
  - Run: `cd /mnt/data/Work/zalo-linux && scripts/_smoke-boot.sh; echo "exit=$?"`
  - Expected: `SMOKE_FAIL: missing app/bootstrap.js -- run SETUP first (npm run setup)` then `exit=2`

- [ ] **Step 5: (Deferred — run only after Tasks 2-9 have produced a built `app/`.)** Full headless boot:
  - Run: `cd /mnt/data/Work/zalo-linux && scripts/_smoke-boot.sh`
  - Expected: log ends with `SMOKE_OK: window created and stayed alive` followed by `smoke boot OK` (exit 0). If instead you see `SMOKE_FAIL: uncaughtException:` mentioning `node_sqlite3.node` or `db-cross-v4-native.node`, the corresponding native build (Task 6/7) is broken.

- [ ] **Step 6: Commit.**
  - Run: `cd /mnt/data/Work/zalo-linux && git add scripts/_smoke-main.js scripts/_smoke-boot.sh && git commit -m "Add headless smoke boot test"`

---

### Task 13: Packaging (`build.js` + electron-builder + `.desktop`)

**Files:**
- Create `/mnt/data/Work/zalo-linux/scripts/build.js` (verbatim from reference — already correct).
- Modify `/mnt/data/Work/zalo-linux/package.json` — replace the `build.linux` object (created in Task 1 per spec §8) to add `icon`, `mimeTypes`, and `desktop.entry`.
- (reference, read-only) `/mnt/data/Work/Zalo/Zalo-linux/scripts/build.js`.

**Interfaces:**
- **Consumes:** `app/package.json.bak` (version, written by Task 2 extract); the `build` block in `package.json` (Task 1); `scripts/utils/logger.js` (Task 1). Env: `GITHUB_OUTPUT` (CI, Task 14).
- **Produces:** `scripts/build.js` `module.exports = { main }`; artifact `dist/Zalo-<version>.deb`. Writes `zalo_version`, `deb_name`, `deb_file` to `$GITHUB_OUTPUT` when set.

Steps:

- [ ] **Step 1: Write `build.js`.** Create `/mnt/data/Work/zalo-linux/scripts/build.js` with EXACTLY (identical to the reference — version from `package.json.bak`, `--config.linux.artifactName`, `extraMetadata.version`, `GITHUB_OUTPUT` outputs, fail if artifact missing):

```js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');

async function main() {
  let version = '0.0.0';
  const bak = path.join(APP_DIR, 'package.json.bak');
  if (fs.existsSync(bak)) {
    version = JSON.parse(fs.readFileSync(bak, 'utf8')).version || version;
  } else {
    logger.warn('package.json.bak not found; version unknown');
  }
  logger.info('Zalo version:', version);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${version}\n`);
  }

  const artifact = `Zalo-${version}.deb`;
  const cmd = `npx electron-builder --linux deb ` +
    `--config.linux.artifactName="${artifact}" ` +
    `-c.extraMetadata.version=${version} --publish=never`;
  logger.dim(cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

  const out = path.join(ROOT, 'dist', artifact);
  if (fs.existsSync(out)) {
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    logger.success(`Built ${artifact} (${mb} MB)`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `deb_name=${artifact}\ndeb_file=dist/${artifact}\n`);
    }
  } else {
    throw new Error(`Expected artifact missing: ${out}`);
  }
}

if (require.main === module) main().catch(e => { logger.error(e.message); process.exit(1); });
module.exports = { main };
```

- [ ] **Step 2: Add the `.desktop` config to the `build.linux` block.** Open `/mnt/data/Work/zalo-linux/package.json` and replace the entire `"linux": { … }` object inside `"build"` (created in Task 1) with the following. This keeps the Task 1 essentials (`extraFiles` app/, `asarUnpack: ["**/*.node"]`, `npmRebuild: false`, `nodeGypRebuild: false`, `buildDependenciesFromSource: false` remain untouched above it) and adds the icon, the `x-scheme-handler/zalo` MimeType, and desktop-entry fields:

```json
    "linux": {
      "target": "deb",
      "category": "Network",
      "maintainer": "thotam <thanhtamtqno1@gmail.com>",
      "synopsis": "Zalo messaging app for Linux",
      "description": "Zalo desktop (Vietnamese messenger) re-ported to Linux from the official macOS build, packaged as .deb.",
      "icon": "app/pc-dist/favicon-512x512.png",
      "mimeTypes": ["x-scheme-handler/zalo"],
      "desktop": {
        "entry": {
          "Name": "Zalo",
          "Comment": "Zalo messaging app",
          "Categories": "Network;InstantMessaging;",
          "StartupWMClass": "Zalo"
        }
      }
    }
```

  Notes for the implementer (do NOT paste into JSON):
  - `mimeTypes: ["x-scheme-handler/zalo"]` is the **correct Linux mechanism** for the `zalo://` deep link — electron-builder writes `MimeType=x-scheme-handler/zalo;` into the `.desktop` and, because a scheme handler is present, appends `%U` to `Exec=` so `zalo://…` arrives in `argv` (→ Zalo's `receiveArguments()`). Do **not** use top-level `protocols` for this — that key is **macOS-only** in electron-builder.
  - `icon` points at `app/pc-dist/favicon-512x512.png` (no BrowserWindow sets `icon:`); it exists only after SETUP, so packaging must run after SETUP.
  - `StartupWMClass: "Zalo"` matches Electron's WM_CLASS (derived from `productName: "Zalo"`) so the taskbar maps the window to the icon.

- [ ] **Step 3: Validate the JSON.**
  - Run: `cd /mnt/data/Work/zalo-linux && node -e "const b=require('./package.json').build.linux; console.log(b.icon, JSON.stringify(b.mimeTypes), b.desktop.entry.StartupWMClass)"`
  - Expected: `app/pc-dist/favicon-512x512.png ["x-scheme-handler/zalo"] Zalo`

- [ ] **Step 4: (Deferred — run after a full SETUP so `app/` + native `.node` exist.)** Build the `.deb`:
  - Run: `cd /mnt/data/Work/zalo-linux && npm run build`
  - Expected: `✔ Built Zalo-26.6.11.deb (… MB)` and `dist/Zalo-26.6.11.deb` exists.

- [ ] **Step 5: (Deferred — after Step 4.) Verify the `.deb` ships `app/` and unpacked native modules.**
  - Run: `dpkg -c /mnt/data/Work/zalo-linux/dist/Zalo-*.deb | grep -E '/opt/Zalo/app/|node_sqlite3\.node|db-cross-v4-native\.node' | head`
  - Expected: lines under `./opt/Zalo/app/…`, including `./opt/Zalo/app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node` and `./opt/Zalo/app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node` as plain (unpacked) files.
  - Also Run: `dpkg -c /mnt/data/Work/zalo-linux/dist/Zalo-*.deb | grep -E 'Zalo\.desktop'`
  - Expected: `./usr/share/applications/Zalo.desktop` present.

- [ ] **Step 6: Commit.**
  - Run: `cd /mnt/data/Work/zalo-linux && git add scripts/build.js package.json && git commit -m "Add electron-builder deb packaging with .desktop scheme handler"`

---

### Task 14: CI + docs

**Files:**
- Create `/mnt/data/Work/zalo-linux/.github/workflows/build.yml`
- Create `/mnt/data/Work/zalo-linux/docs/PORTING-GUIDE.md`
- (reference, read-only) `/mnt/data/Work/Zalo/Zalo-linux/.github/workflows/build.yml`, `/mnt/data/Work/Zalo/Zalo-linux/docs/PORTING-GUIDE.md`.

**Interfaces:**
- **Consumes:** `npm run main` (= `SETUP=true BUILD=true node scripts/main.js`, Task 1) which chains download → extract → 6 patches → build. `build.js` writes `deb_name`/`deb_file` to `$GITHUB_OUTPUT` (Task 13).
- **Produces:** a CI workflow that installs system deps **including `libsqlcipher-dev`**, runs SETUP+BUILD, uploads the artifact always, and creates a GitHub Release **only on a git tag**; plus a rewritten porting guide (macOS DMG source, 6 patches, SQLCipher, win32 renderer titlebar, fail-loud version bump).

Steps:

- [ ] **Step 1: Write the CI workflow.** Create `/mnt/data/Work/zalo-linux/.github/workflows/build.yml` with EXACTLY (adds `libsqlcipher-dev` for the SQLCipher build; release step gated on `refs/tags/`; `workflow_dispatch` builds + uploads artifact only):

```yaml
name: Build Zalo for Linux

on:
  push:
    tags:
      - '*'
  workflow_dispatch:
    inputs:
      zalo_version:
        description: 'Zalo version (empty = latest)'
        required: false
        default: ''

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install system deps
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            p7zip-full build-essential libssl-dev liblzma-dev libsqlcipher-dev \
            dpkg fakeroot

      - name: Install npm deps
        run: npm install --no-audit --no-fund

      - name: Setup + Build
        id: build
        env:
          ZALO_VERSION: ${{ github.event.inputs.zalo_version }}
        run: npm run main

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ steps.build.outputs.deb_name }}
          path: ${{ steps.build.outputs.deb_file }}
          retention-days: 30

      - name: Release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v1
        with:
          tag_name: ${{ github.ref_name }}
          name: ${{ github.ref_name }}
          files: ${{ steps.build.outputs.deb_file }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

  Note: `npm run main` = `SETUP=true BUILD=true node scripts/main.js`. `ZALO_VERSION` (from the `workflow_dispatch` input) is read by `download-installer.js`; on a tag push the input is empty so the latest DMG is resolved. `npm install` (not `npm ci`) — lock files are gitignored per project preference, so there is no committed `package-lock.json`. Smoke boot is intentionally **not** in CI (per spec §9 — it needs a display and is a local check); CI is download → extract → patch → build → package.

- [ ] **Step 2: Verify the workflow parses and the SQLCipher dep + tag gate are present.**
  - Run: `cd /mnt/data/Work/zalo-linux && python3 -c "import yaml;d=yaml.safe_load(open('.github/workflows/build.yml'));print(list(d['jobs']['build']['steps'][-1]['if']))" 2>/dev/null | head -c1; echo; grep -c 'libsqlcipher-dev' .github/workflows/build.yml; grep -c "startsWith(github.ref, 'refs/tags/')" .github/workflows/build.yml`
  - Expected: three lines — a non-empty first char (YAML valid), then `1`, then `1`.

- [ ] **Step 3: Write the rewritten porting guide.** Create `/mnt/data/Work/zalo-linux/docs/PORTING-GUIDE.md`:

```markdown
# Porting Guide — Zalo for Linux (.deb)

Dành cho maintainer muốn **re-port một phiên bản Zalo mới** sang Linux. Mô tả *đúng*
những gì repo đang build. Đọc kèm `README.md` và design spec trong
`docs/superpowers/specs/`.

**Nguyên tắc**: không viết lại Zalo. Lấy nguyên bundle JS (`app.asar`) từ **bộ cài
macOS DMG**, patch tối thiểu, và build lại native module cho **Linux x64** từ source.
JS trong `app.asar` là arch-neutral; chỉ các file `.node` cần build mới.

---

## 1. Nguồn & cách lấy bộ cài (macOS DMG)

Bộ cài mới nhất resolve qua một redirect (bắt buộc User-Agent **macOS**):

    GET https://zalo.me/download/zalo-pc?utm=90000   (UA macOS)
    -> HTTP 302  Location: https://res-download-pc.zadn.vn/mac/ZaloSetup-universal-<ver>.dmg

- Version parse từ `Location` bằng regex `ZaloSetup-universal-([0-9.]+)\.dmg`.
- `assertValidVersion(/^[0-9.]+$/)` chống shell-injection.
- Logic ở `scripts/download-installer.js`. Ép version: `ZALO_VERSION=<ver>`; dùng DMG
  có sẵn: `ZALO_DMG=<file.dmg>` (bỏ qua download).

Layout DMG: `Zalo*/Zalo.app/Contents/Resources/app.asar` (+ `app.asar.unpacked/`).

## 2. Extraction (`scripts/extract-installer.js`)

Cần `7z` (`p7zip-full`). Thứ tự:
1. `7z x` tách `app.asar` + `app.asar.unpacked/*` từ DMG.
2. `@electron/asar` `extractAll(app.asar -> app/)`.
3. **Overlay `app.asar.unpacked/*` lên `app/`** (`overwrite:true`) — BẮT BUỘC: loader
   native thật chỉ nằm trong `.unpacked`; bản trong `app.asar` là stub rỗng.
4. Rename `app/package.json` -> `app/package.json.bak` (giữ để lấy version).

`app/` **không commit** (gitignore).

## 3. Sáu patch (`scripts/patches/`), chạy theo thứ tự cố định

Orchestrator `scripts/main.js` chạy: **platform-id → renderer-win32 → sqlite3 →
db-cross-v4 → zfile → linux-guards**. Patch critical **throw** khi pattern không khớp
(fail loud) — không âm thầm ship bản hỏng.

1. **patch-platform-id** — `app/main-dist/main.js` (+`compact-app.js`):
   `case "LINUX": return 25` -> `24`. Client-type 24 = WIN32 → server bật **đồng bộ
   lịch sử E2EE**.
2. **patch-renderer-win32** — `app/pc-dist/**.js`: `platform:"DARWIN"` -> `"WIN32"`;
   `getClientType(){return 23}` -> `24`. Renderer vẽ titlebar **win32 gốc**
   (min/max/close) trên cửa sổ frameless. KHÔNG đổi `frame:false`->`true`; KHÔNG dùng
   `titleBarOverlay`.
3. **patch-sqlite3** — build mapbox sqlite3 **có SQLCipher** từ source, đặt `.node` vào
   `app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node`. Verify
   `PRAGMA cipher_version` trả về giá trị (không chỉ check ELF).
4. **patch-db-cross-v4** — build `.node` (AES-256-CBC + XZ, clean-room), đặt vào
   `.../db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node` + splice nhánh
   `process.platform === 'linux'` vào `dist/binding.js` (regex fail-loud).
5. **patch-zfile** — build `.node` + splice nhánh linux vào `index.js` (parity; 0
   call-site trong bundle này nhưng build theo yêu cầu "all nativelibs from cc").
6. **patch-linux-guards** — short-circuit `checkAppSigned()` (spawn `codesign` của
   macOS) trên Linux; bọc loader `zwalker`/`mp4thumb`/`v8-profiles` để binary vắng mặt
   không throw.

## 4. Native builds (`nativelibs/`)

Electron pin **22.3.27** (ABI N-API v6, khớp Electron 22.3.9 mà Zalo bundle). Build qua
`nativelibs/builder.js`:

    npx node-gyp rebuild --target=<electron-ver> --arch=x64 \
      --dist-url=https://electronjs.org/headers

- **Không** tải prebuilt, **không** commit `.node` (gitignore). **Mỗi SETUP rebuild từ
  source.**
- Chỉ 3 module có source: `sqlite3` (SQLCipher), `db-cross-v4`, `zfile`.
- 8 module proprietary còn lại (`zwalker`, `zimage`, `zjxl`, `mp4thumb`, `zcall`, …)
  giữ guard/stub — ngoài scope v1.

System deps:

    sudo apt-get install -y p7zip-full build-essential libssl-dev liblzma-dev \
      libsqlcipher-dev dpkg fakeroot

## 5. Dev vs Deploy

**Dev** (không download):

    ZALO_DMG=<file.dmg> npm run setup   # extract + 6 patch + build native
    ./run-dev.sh                        # electron . --no-sandbox
    scripts/_smoke-boot.sh              # headless: cửa sổ tạo được, không throw import

**Deploy** (CI — `.github/workflows/build.yml`):
- **Push git tag** (`on: push: tags`) → build **và tạo GitHub Release** kèm `.deb`
  (step Release gate `if: startsWith(github.ref,'refs/tags/')`).
- **`workflow_dispatch`** (input `zalo_version` tùy chọn) → build + upload artifact,
  **KHÔNG** Release.

`.deb` metadata trong `package.json` (`maintainer`, `productName:"Zalo"`,
`appId:"com.zalo.linux"`); tên artifact `Zalo-<ver>.deb` (version từ
`package.json.bak`). `.desktop` có `Icon=` (favicon-512x512) và
`MimeType=x-scheme-handler/zalo;` (deep link `zalo://` qua argv).

## 6. Checklist: Bump lên phiên bản Zalo mới

1. Chạy pipeline cho version mới:

       ZALO_VERSION=<new-ver> npm run main     # download + extract + 6 patch + build .deb
       # hoặc, DMG có sẵn (không build .deb):
       ZALO_DMG=<file.dmg> npm run setup

2. **Đọc log patch.** Patch critical **throw** nếu pattern minified dịch chuyển
   ("pattern not found / no longer matches"). Re-locate trong `app/` rồi cập nhật chuỗi
   trong `scripts/patches/*.js`:
   - platform-id → `case"LINUX":return <n>` trong `app/main-dist/main.js`.
   - renderer-win32 → `platform:"DARWIN"` / `getClientType(){return 23}` trong
     `app/pc-dist/**.js` (xác nhận **số lần thay** khớp).
   - db-cross-v4 → chỗ splice trong `dist/binding.js`.
3. **Smoke boot**: `scripts/_smoke-boot.sh` phải in `SMOKE_OK` (cửa sổ tạo được,
   sqlite3 + db-cross load không throw). Rồi verify thủ công với tài khoản thật: login
   QR → **đồng bộ lịch sử E2EE** → gửi/nhận text → nút min/max/close + kéo cửa sổ → DB
   local đúng là SQLCipher-encrypted.
4. **Verify docs khớp code:**

       grep -q 'napi-v6-linux-x64' docs/PORTING-GUIDE.md \
         && grep -q 'return .24' docs/PORTING-GUIDE.md && echo "doc OK"

5. **Release:** commit (nếu có sửa patch), rồi push git tag:

       git tag <new-ver> && git push origin <new-ver>

   CI build + tạo GitHub Release kèm `Zalo-<ver>.deb`.

## Ghi công

- db-cross-v4 reverse engineering: **realdtn2**.
- Zalo là thương hiệu của VNG Corporation. Dự án không liên kết/được bảo trợ bởi VNG.
```

- [ ] **Step 4: Verify the guide reflects the clean design (macOS DMG, 6 patches, SQLCipher, no dropped `frame` hack).**
  - Run: `cd /mnt/data/Work/zalo-linux && grep -c 'ZaloSetup-universal' docs/PORTING-GUIDE.md; grep -c 'SQLCipher' docs/PORTING-GUIDE.md; grep -c 'renderer-win32' docs/PORTING-GUIDE.md; grep -c 'frame:!1->!0\|frame:!0' docs/PORTING-GUIDE.md`
  - Expected: first three counts `>= 1`, last count `0` (the old `frame:!1→!0` titlebar patch must NOT be mentioned).

- [ ] **Step 5: Commit.**
  - Run: `cd /mnt/data/Work/zalo-linux && git add .github/workflows/build.yml docs/PORTING-GUIDE.md && git commit -m "Add CI workflow (SQLCipher deps, tag-gated release) and rewritten porting guide"`

---
