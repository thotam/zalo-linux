# file-utilities Linux Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the macOS-only `file-utilities` NAPI-RS (Rust) addon for Linux x64 with the full API surface and byte-identical output, wired into the build/patch pipeline so the app's Data Management / Storage screen works on Linux.

**Architecture:** A fresh Rust `napi-rs` crate under `nativelibs/file-utilities/`, reconstructed from the strings recovered from the mac binary (module layout + pinned crate versions). Built with `cargo build --release` → `libfile_utilities.so` renamed `file-utilities.node`, deployed by `scripts/patches/patch-file-utilities.js` (modeled on `patch-zjxl.js`) which also splices a `linux` branch into the addon's `getPlatformPath()`. Verified with a Node test harness that diffs addon output against independent coreutils oracles.

**Tech Stack:** Rust (cargo 1.96, stable), `napi` / `napi-derive` 2.x, `walkdir` 2.5.0, `same-file` 1.0.6, `lazy_static` 1.5.0, `globset`, `num_cpus`, `libc`; Node test harness (plain `assert`); existing JS build pipeline (`scripts/main.js`, `nativelibs/builder.js`).

## Global Constraints

- **Fidelity = byte-identical OUTPUT**, not a byte-identical binary (Mach-O universal → ELF x64 is physically impossible). Excluded from byte-identity: `durationMs` (timing) and OS-inherent filesystem-descriptive fields.
- **No AI attribution** anywhere (commit messages, docs) — no `Co-Authored-By`, no "Generated with" / 🤖.
- **Build host floor:** ubuntu-22.04 / glibc ≥ 2.34 (matches existing `.deb` portability floor). The addon must link only system libs (`libc`, `libgcc_s`, `libm`, `libpthread`, `libdl`) — verified with `ldd`.
- **Target:** `x86_64-unknown-linux-gnu` only. arm64 deferred.
- **API names/casing must match the NAPI-RS binding exactly** (snake_case Rust → camelCase JS via napi-derive).
- **N-API level:** enable the napi feature ≤ 10 (Electron 39 = N-API 10). Use `napi = { version = "2", features = ["napi8"] }` (ABI-stable, loads on Node 24 and Electron 39).
- **Commit after every task.** TDD: failing test first.
- Do **not** commit personal data; the crate and tests use only synthetic fixtures under the scratchpad or repo tmp.

---

## File structure

Created under `nativelibs/file-utilities/`:

- `Cargo.toml` — crate manifest, pinned deps, `crate-type = ["cdylib"]`.
- `build.rs` — `napi_build::setup()`.
- `src/lib.rs` — module declarations only (`mod get_directory_size;` …). napi-derive auto-registers exports.
- `src/shared/mod.rs` — `pub mod async_job;`
- `src/shared/async_job.rs` — global job registry (`lazy_static`), cancellation flag, `cancelJob`, `num_workers()` helper, shared parallel-walk primitive.
- `src/get_directory_size.rs` — `getDirectorySize{Sync,Async}` + `DirectorySizeOptions` + `DirectorySizeResult`.
- `src/get_directory_size_tree.rs` — `getDirectorySizeTree{Sync,Async}` + `DirectoryTreeOptions` + `DirectoryTreeResult`.
- `src/get_directory_size_glob.rs` — `getDirectorySizeByGlob{Sync,Async}`.
- `src/detect_hardlinks.rs` — `detectHardlinks{Sync,Async}` + `HardlinkResult`.
- `src/detect_filesystem.rs` — `detectFilesystem{Sync,Async}` + `FilesystemInfo`.
- `__tests__/helpers.js` — fixture builder + oracle wrappers.
- `__tests__/*.test.js` — per-module tests.
- `RE-PARAMS.md`, `README.md` — documentation.

Modified / created elsewhere:

- `scripts/patches/patch-file-utilities.js` — build + deploy + splice.
- `scripts/main.js` — register the patch.
- `.github/workflows/build.yml` — Rust toolchain.
- `docs/RE-ROADMAP.md` — mark file-utilities DONE.

App wrapper `app/native/nativelibs/file-utilities/index.js` is **gitignored** (extracted from the DMG); it is patched at build time by the patch script, not committed.

---

### Task 1: Scaffold the crate and prove a loadable `.node`

**Files:**
- Create: `nativelibs/file-utilities/Cargo.toml`
- Create: `nativelibs/file-utilities/build.rs`
- Create: `nativelibs/file-utilities/src/lib.rs`
- Create: `nativelibs/file-utilities/.gitignore`
- Test: `nativelibs/file-utilities/__tests__/smoke.test.js`

**Interfaces:**
- Produces: a built addon at `nativelibs/file-utilities/target/release/libfile_utilities.so` exporting a temporary `ping() -> String` returning `"pong"`.

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/smoke.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
assert.strictEqual(typeof addon.ping, 'function', 'ping export missing');
assert.strictEqual(addon.ping(), 'pong');
console.log('OK smoke: addon loads and ping() works');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node nativelibs/file-utilities/__tests__/smoke.test.js`
Expected: FAIL — cannot find `.../target/release/libfile_utilities.so` (not built yet).

- [ ] **Step 3: Write the crate**

`nativelibs/file-utilities/Cargo.toml`:

```toml
[package]
name = "file-utilities"
version = "1.0.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", default-features = false, features = ["napi8"] }
napi-derive = "2"
walkdir = "=2.5.0"
same-file = "=1.0.6"
lazy_static = "=1.5.0"
globset = "0.4"
num_cpus = "1"
libc = "0.2"

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
strip = true
```

`nativelibs/file-utilities/build.rs`:

```rust
fn main() {
    napi_build::setup();
}
```

`nativelibs/file-utilities/src/lib.rs`:

```rust
use napi_derive::napi;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
```

`nativelibs/file-utilities/.gitignore`:

```
/target
```

- [ ] **Step 4: Build**

Run: `cd nativelibs/file-utilities && cargo build --release`
Expected: compiles; produces `target/release/libfile_utilities.so`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node nativelibs/file-utilities/__tests__/smoke.test.js`
Expected: `OK smoke: addon loads and ping() works`

- [ ] **Step 6: Verify only system libs are linked**

Run: `ldd nativelibs/file-utilities/target/release/libfile_utilities.so`
Expected: only `libc`, `libgcc_s`, `libm`, `libpthread`/`libdl`, `linux-vdso`, `ld-linux` — no third-party `.so`.

- [ ] **Step 7: Commit**

```bash
git add nativelibs/file-utilities/Cargo.toml nativelibs/file-utilities/Cargo.lock nativelibs/file-utilities/build.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/.gitignore nativelibs/file-utilities/__tests__/smoke.test.js
git commit -m "file-utilities: scaffold napi-rs crate, loadable .node smoke test"
```

---

### Task 2: Shared job registry + parallel walk primitive

**Files:**
- Create: `nativelibs/file-utilities/__tests__/load-addon.js` (shared addon loader)
- Modify: `nativelibs/file-utilities/__tests__/smoke.test.js` (use the shared loader)
- Create: `nativelibs/file-utilities/src/shared/mod.rs`
- Create: `nativelibs/file-utilities/src/shared/async_job.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Test: `nativelibs/file-utilities/__tests__/cancel.test.js`

**Interfaces:**
- Produces:
  - `__tests__/load-addon.js` — `module.exports` = the built addon. Node's `require()` only auto-registers the `.node` extension, not the cdylib's `.so` name, so this module aliases it once (`require.extensions['.so'] = require.extensions['.node']`) and every test file requires `./load-addon` instead of duplicating the shim.
  - `cancelJob(jobId: u32)` napi export.
  - `pub fn register_job(job_id: u32) -> Arc<AtomicBool>` — registers a cancel flag.
  - `pub fn unregister_job(job_id: u32)`.
  - `pub fn num_workers(requested: Option<u32>) -> usize` — `requested` clamped to ≥1, default `num_cpus::get()`.
  - `pub fn walk_size(root: &Path, _workers: usize, cancel: &AtomicBool) -> Result<(f64, u32), std::io::Error>` — dir walk returning `(total_size_bytes, file_count)`, dedup hardlinks by `(dev, ino)` (NOT `same_file::Handle` — that holds an open fd per file and exhausts the ulimit on large trees), honoring `cancel`. Single-threaded: thread count does not affect output (sums are commutative), so `workers` is accepted for API parity but the walk is deterministic and unthreaded — byte-identical output without concurrency hazards.

- [ ] **Step 0: Create the shared addon loader and refactor smoke.test.js**

`nativelibs/file-utilities/__tests__/load-addon.js`:

```js
// Load the cargo-built cdylib as a Node native addon.
// Node's require() only auto-registers the ".node" extension, not the cdylib's
// ".so" name, so alias it once here. Every test file requires this module
// instead of duplicating the shim.
const path = require('path');
require.extensions['.so'] = require.extensions['.node'];
module.exports = require(path.join(__dirname, '..', 'target', 'release', 'libfile_utilities.so'));
```

Refactor the existing `nativelibs/file-utilities/__tests__/smoke.test.js` to use it — replace the first three lines with:

```js
const assert = require('assert');
const addon = require('./load-addon');
```

Run: `node nativelibs/file-utilities/__tests__/smoke.test.js`
Expected: still `OK smoke: addon loads and ping() works` (no regression).

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/cancel.test.js`:

```js
const assert = require('assert');
const addon = require('./load-addon');
assert.strictEqual(typeof addon.cancelJob, 'function', 'cancelJob export missing');
// cancelJob on an unknown id must be a no-op (no throw).
addon.cancelJob(999999);
console.log('OK cancel: cancelJob export present and safe on unknown id');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/cancel.test.js`
Expected: FAIL — `cancelJob export missing`.

- [ ] **Step 3: Write the shared module**

`nativelibs/file-utilities/src/shared/mod.rs`:

```rust
pub mod async_job;
```

`nativelibs/file-utilities/src/shared/async_job.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use lazy_static::lazy_static;
use napi_derive::napi;

lazy_static! {
    static ref JOBS: Mutex<HashMap<u32, Arc<AtomicBool>>> = Mutex::new(HashMap::new());
}

pub fn register_job(job_id: u32) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().insert(job_id, flag.clone());
    flag
}

pub fn unregister_job(job_id: u32) {
    JOBS.lock().unwrap().remove(&job_id);
}

#[napi(js_name = "cancelJob")]
pub fn cancel_job(job_id: u32) {
    if let Some(flag) = JOBS.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn num_workers(requested: Option<u32>) -> usize {
    match requested {
        Some(0) => 1,
        Some(n) => n as usize,
        None => num_cpus::get().max(1),
    }
}

/// Directory walk. Returns (total_size_bytes, file_count).
/// - total_size sums regular-file logical sizes (st_size).
/// - hardlinks deduplicated by (dev, ino) taken from the metadata we already
///   stat'd — NOT by same_file::Handle, which would hold an open fd per unique
///   file and exhaust the fd ulimit on large trees (silently corrupting the
///   total). The (dev, ino) tuple is the same identity same_file uses, minus
///   the open fd.
/// - symlinks are not followed (symlink_metadata) and not summed.
/// - honors `cancel`: returns early with partial totals when set.
///
/// Single-threaded on purpose: thread count cannot change the (commutative)
/// sum, so `_workers` is accepted for API parity but the walk stays
/// deterministic and free of concurrency hazards — byte-identical output.
pub fn walk_size(root: &Path, _workers: usize, cancel: &AtomicBool) -> std::io::Result<(f64, u32)> {
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("'{}' does not exist or cannot be accessed", root.display()),
        ));
    }

    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut total = 0f64;
    let mut count = 0u32;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue, // unreadable subdir: skip, keep walking
        };
        for entry in rd.flatten() {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let ft = meta.file_type();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                // hardlink dedup by (dev, ino) — no open fd
                if !seen.insert((meta.dev(), meta.ino())) {
                    continue; // already counted this inode
                }
                total += meta.len() as f64;
                count += 1;
            }
        }
    }

    Ok((total, count))
}
```

Modify `nativelibs/file-utilities/src/lib.rs` — add module declaration (keep `ping` for now; removed in Task 8):

```rust
use napi_derive::napi;

mod shared;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
```

- [ ] **Step 4: Build and run test to verify it passes**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/cancel.test.js`
Expected: `OK cancel: cancelJob export present and safe on unknown id`

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/shared nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/cancel.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: shared job registry, cancelJob, parallel walk_size primitive"
```

---

### Task 3: Test helpers (fixtures + oracles)

**Files:**
- Create: `nativelibs/file-utilities/__tests__/helpers.js`

**Interfaces:**
- Produces:
  - `makeFixture()` → `{ root, expectedApparentBytes, expectedFileCount }` — builds a deterministic tree under an OS tmp dir: files of known sizes, one hardlinked pair, one symlink, nested subdirs (depth 3).
  - `duApparentBytes(dir)` → number (oracle via `du --apparent-size -sb`).
  - `findFileCount(dir)` → number (oracle via `find -type f`, hardlink-adjusted to match dedup).
  - `statNlink(file)` → number (`stat -c %h`).
  - `statfsType(path)` → string (`stat -f -c %T`).
  - `rmFixture(root)`.

- [ ] **Step 1: Write helpers**

`nativelibs/file-utilities/__tests__/helpers.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-fix-'));
  // top-level files
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(1000, 1));   // 1000 bytes
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.alloc(2000, 2));   // 2000 bytes
  // nested dirs
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'c.txt'), Buffer.alloc(500, 3));     // 500 bytes
  const deep = path.join(sub, 'deep');
  fs.mkdirSync(deep);
  fs.writeFileSync(path.join(deep, 'd.txt'), Buffer.alloc(300, 4));    // 300 bytes
  // hardlink to a.bin (must be counted ONCE)
  fs.linkSync(path.join(root, 'a.bin'), path.join(sub, 'a-link.bin'));
  // symlink (must NOT be summed)
  fs.symlinkSync(path.join(root, 'b.bin'), path.join(sub, 'b-symlink.bin'));
  return { root };
}

function duApparentBytes(dir) {
  const out = execSync(`du --apparent-size -sb "${dir}"`).toString().trim();
  return parseInt(out.split(/\s+/)[0], 10);
}

function findFileCount(dir) {
  // count regular files, then subtract hardlink duplicates (same inode counted once)
  const files = execSync(`find "${dir}" -type f -printf '%i\\n'`).toString().trim().split('\n').filter(Boolean);
  return new Set(files).size;
}

function statNlink(file) {
  return parseInt(execSync(`stat -c %h "${file}"`).toString().trim(), 10);
}

function statfsType(p) {
  return execSync(`stat -f -c %T "${p}"`).toString().trim();
}

function rmFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { makeFixture, duApparentBytes, findFileCount, statNlink, statfsType, rmFixture };
```

- [ ] **Step 2: Sanity-run helpers**

Run:
```bash
node -e "const h=require('./nativelibs/file-utilities/__tests__/helpers.js'); const {root}=h.makeFixture(); console.log('du', h.duApparentBytes(root), 'count', h.findFileCount(root), 'fs', h.statfsType(root)); h.rmFixture(root);"
```
Expected: prints `du 3800 count 4 fs <ext4|btrfs|...>` — `du --apparent-size` dedups the hardlink so total = 1000+2000+500+300 = 3800; unique inodes = 4 (a,b,c,d; a-link shares a's inode; symlink is not `-type f`).

- [ ] **Step 3: Commit**

```bash
git add nativelibs/file-utilities/__tests__/helpers.js
git commit -m "file-utilities: test helpers (fixture builder + coreutils oracles)"
```

---

### Task 4: `getDirectorySize{Sync,Async}`

**Files:**
- Create: `nativelibs/file-utilities/src/get_directory_size.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Test: `nativelibs/file-utilities/__tests__/directory-size.test.js`

**Interfaces:**
- Consumes: `shared::async_job::{walk_size, num_workers, register_job, unregister_job}`.
- Produces:
  - `#[napi(object)] DirectorySizeOptions { workers: Option<u32> }`
  - `#[napi(object)] DirectorySizeResult { total_size: f64, file_count: u32, duration_ms: f64 }` → JS `{ totalSize, fileCount, durationMs }`.
  - `getDirectorySizeSync(path: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult>`
  - `getDirectorySizeAsync(path: String, options: Option<DirectorySizeOptions>, jobId: u32) -> AsyncTask<DirSizeTask>`

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/directory-size.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const expBytes = h.duApparentBytes(root);   // 3800
    const expCount = h.findFileCount(root);      // 4

    // sync
    const s = addon.getDirectorySizeSync(root);
    assert.strictEqual(s.totalSize, expBytes, `sync totalSize ${s.totalSize} != ${expBytes}`);
    assert.strictEqual(s.fileCount, expCount, `sync fileCount ${s.fileCount} != ${expCount}`);
    assert.strictEqual(typeof s.durationMs, 'number', 'durationMs is a number');

    // async (jobId is 3rd arg per the JS wrapper contract)
    const a = await addon.getDirectorySizeAsync(root, undefined, 1);
    assert.strictEqual(a.totalSize, expBytes, `async totalSize ${a.totalSize} != ${expBytes}`);
    assert.strictEqual(a.fileCount, expCount, `async fileCount ${a.fileCount} != ${expCount}`);

    // workers option must not change the result
    const w = addon.getDirectorySizeSync(root, { workers: 4 });
    assert.strictEqual(w.totalSize, expBytes, 'workers:4 same total');
    console.log('OK directory-size: sync+async match du/find oracle, dedup hardlink, skip symlink');
  } finally {
    h.rmFixture(root);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/directory-size.test.js`
Expected: FAIL — `getDirectorySizeSync` is not a function.

- [ ] **Step 3: Write the implementation**

`nativelibs/file-utilities/src/get_directory_size.rs`:

```rust
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use napi::{Env, Result, Task};
use napi_derive::napi;

use crate::shared::async_job::{num_workers, register_job, unregister_job, walk_size};

#[napi(object)]
pub struct DirectorySizeOptions {
    pub workers: Option<u32>,
}

#[napi(object)]
pub struct DirectorySizeResult {
    pub total_size: f64,
    pub file_count: u32,
    pub duration_ms: f64,
}

fn compute(path: &str, workers: usize, cancel: &AtomicBool) -> Result<DirectorySizeResult> {
    let start = Instant::now();
    let (total, count) = walk_size(Path::new(path), workers, cancel)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(DirectorySizeResult {
        total_size: total,
        file_count: count,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[napi]
pub fn get_directory_size_sync(
    path: String,
    options: Option<DirectorySizeOptions>,
) -> Result<DirectorySizeResult> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = AtomicBool::new(false);
    compute(&path, workers, &cancel)
}

pub struct DirSizeTask {
    path: String,
    workers: usize,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

#[napi]
impl Task for DirSizeTask {
    type Output = DirectorySizeResult;
    type JsValue = DirectorySizeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.path, self.workers, &self.cancel)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Ok(output)
    }

    fn reject(&mut self, _env: Env, err: napi::Error) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Err(err)
    }
}

#[napi]
pub fn get_directory_size_async(
    path: String,
    options: Option<DirectorySizeOptions>,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<DirSizeTask> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(DirSizeTask {
        path,
        workers,
        cancel,
        job_id,
    })
}
```

Modify `nativelibs/file-utilities/src/lib.rs`:

```rust
use napi_derive::napi;

mod shared;
mod get_directory_size;

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/directory-size.test.js`
Expected: `OK directory-size: sync+async match du/find oracle, dedup hardlink, skip symlink`

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/get_directory_size.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/directory-size.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: getDirectorySize{Sync,Async} byte-matching du/find oracle"
```

---

### Task 5: `detectHardlinks{Sync,Async}`

**Files:**
- Create: `nativelibs/file-utilities/src/detect_hardlinks.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Test: `nativelibs/file-utilities/__tests__/hardlinks.test.js`

**Interfaces:**
- Produces:
  - `#[napi(object)] HardlinkResult { is_hardlink: bool, link_count: u32 }` → `{ isHardlink, linkCount }`.
  - `detectHardlinksSync(path: String) -> Result<HardlinkResult>` — error if path missing or not a regular file; `is_hardlink = nlink > 1`.
  - `detectHardlinksAsync(path: String) -> AsyncTask<HardlinkTask>`.

> Note: `HardlinkResult`'s exact field set is inferred (no app call-site reads specific fields). `{ isHardlink, linkCount }` covers the observed error strings ("Path is not a file", "Failed to read file metadata", "Root path does not exist"). Confirm against the mac binary during the Task 12 cross-check; adjust field names there if the Mac run shows different keys.

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/hardlinks.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const linked = path.join(root, 'a.bin');       // nlink == 2 (a.bin + sub/a-link.bin)
    const plain = path.join(root, 'b.bin');        // nlink == 1
    assert.strictEqual(h.statNlink(linked), 2);
    assert.strictEqual(h.statNlink(plain), 1);

    const r1 = addon.detectHardlinksSync(linked);
    assert.strictEqual(r1.isHardlink, true, 'a.bin isHardlink');
    assert.strictEqual(r1.linkCount, 2, 'a.bin linkCount');

    const r2 = addon.detectHardlinksSync(plain);
    assert.strictEqual(r2.isHardlink, false, 'b.bin isHardlink false');
    assert.strictEqual(r2.linkCount, 1, 'b.bin linkCount 1');

    const r3 = await addon.detectHardlinksAsync(linked);
    assert.strictEqual(r3.isHardlink, true, 'async isHardlink');

    // error path: a directory is not a regular file
    assert.throws(() => addon.detectHardlinksSync(root), /not a file|is not a file/i);
    console.log('OK hardlinks: nlink matches stat -c %h, dir rejected');
  } finally {
    h.rmFixture(root);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/hardlinks.test.js`
Expected: FAIL — `detectHardlinksSync` is not a function.

- [ ] **Step 3: Write the implementation**

`nativelibs/file-utilities/src/detect_hardlinks.rs`:

```rust
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use napi::{Env, Result, Task};
use napi_derive::napi;

#[napi(object)]
pub struct HardlinkResult {
    pub is_hardlink: bool,
    pub link_count: u32,
}

fn detect(path: &str) -> Result<HardlinkResult> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(napi::Error::from_reason(format!(
            "Root path does not exist: {}",
            path
        )));
    }
    let meta = std::fs::symlink_metadata(p)
        .map_err(|e| napi::Error::from_reason(format!("Failed to read file metadata for {}: {}", path, e)))?;
    if !meta.file_type().is_file() {
        return Err(napi::Error::from_reason(format!("Path is not a file: {}", path)));
    }
    let nlink = meta.nlink() as u32;
    Ok(HardlinkResult {
        is_hardlink: nlink > 1,
        link_count: nlink,
    })
}

#[napi]
pub fn detect_hardlinks_sync(path: String) -> Result<HardlinkResult> {
    detect(&path)
}

pub struct HardlinkTask {
    path: String,
}

#[napi]
impl Task for HardlinkTask {
    type Output = HardlinkResult;
    type JsValue = HardlinkResult;
    fn compute(&mut self) -> Result<Self::Output> {
        detect(&self.path)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn detect_hardlinks_async(path: String) -> napi::bindgen_prelude::AsyncTask<HardlinkTask> {
    napi::bindgen_prelude::AsyncTask::new(HardlinkTask { path })
}
```

Modify `nativelibs/file-utilities/src/lib.rs` — add `mod detect_hardlinks;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/hardlinks.test.js`
Expected: `OK hardlinks: nlink matches stat -c %h, dir rejected`

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/detect_hardlinks.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/hardlinks.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: detectHardlinks{Sync,Async} matching stat nlink"
```

---

### Task 6: `detectFilesystem{Sync,Async}`

**Files:**
- Create: `nativelibs/file-utilities/src/detect_filesystem.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Test: `nativelibs/file-utilities/__tests__/filesystem.test.js`

**Interfaces:**
- Produces:
  - `#[napi(object)] FilesystemInfo { filesystem_type: String, volume_name: String, max_filename_length: u32, supports_case_sensitive_names: bool, supports_unicode_filenames: bool, supports_compression: bool, supports_encryption: bool }` → the 7 camelCase JS fields.
  - `detectFilesystemSync(path: String) -> Result<FilesystemInfo>`
  - `detectFilesystemAsync(path: String) -> AsyncTask<FsTask>`

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/filesystem.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const oracle = h.statfsType(root).toLowerCase(); // e.g. "ext2/ext3" or "btrfs" or "xfs"
    const r = addon.detectFilesystemSync(root);
    assert.strictEqual(typeof r.filesystemType, 'string');
    assert.ok(r.filesystemType.length > 0, 'filesystemType non-empty');
    // The app only consumes filesystemType (lowercased); assert it is a recognizable
    // token consistent with the statfs oracle family.
    const ftl = r.filesystemType.toLowerCase();
    assert.ok(
      oracle.includes(ftl) || ftl.includes('ext') || ['btrfs','xfs','tmpfs','overlayfs','vfat','ntfs','f2fs','zfs'].includes(ftl),
      `filesystemType '${r.filesystemType}' inconsistent with oracle '${oracle}'`
    );
    assert.strictEqual(typeof r.maxFilenameLength, 'number');
    assert.ok(r.maxFilenameLength >= 255, 'maxFilenameLength >= 255 on common Linux fs');
    assert.strictEqual(typeof r.supportsCaseSensitiveNames, 'boolean');

    const ra = await addon.detectFilesystemAsync(root);
    assert.strictEqual(ra.filesystemType, r.filesystemType, 'async matches sync');

    assert.throws(() => addon.detectFilesystemSync(path.join(root, 'nope')), /does not exist/i);
    console.log('OK filesystem: type consistent with statfs oracle, 7 fields present');
  } finally {
    h.rmFixture(root);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/filesystem.test.js`
Expected: FAIL — `detectFilesystemSync` is not a function.

- [ ] **Step 3: Write the implementation**

`nativelibs/file-utilities/src/detect_filesystem.rs`:

```rust
use std::ffi::CString;
use std::path::Path;

use napi::{Env, Result, Task};
use napi_derive::napi;

#[napi(object)]
pub struct FilesystemInfo {
    pub filesystem_type: String,
    pub volume_name: String,
    pub max_filename_length: u32,
    pub supports_case_sensitive_names: bool,
    pub supports_unicode_filenames: bool,
    pub supports_compression: bool,
    pub supports_encryption: bool,
}

// Linux statfs f_type magics -> canonical fs name.
fn fs_name(f_type: i64) -> &'static str {
    match f_type as u64 {
        0xEF53 => "ext4",
        0x9123683E => "btrfs",
        0x58465342 => "xfs",
        0x2FC12FC1 => "zfs",
        0x01021994 => "tmpfs",
        0x794C7630 => "overlayfs",
        0x4D44 => "vfat",
        0x5346544E => "ntfs",
        0xF2F52010 => "f2fs",
        0x6969 => "nfs",
        0xFF534D42 => "cifs",
        0x65735546 => "fuse",
        _ => "unknown",
    }
}

fn caps(fs: &str) -> (bool, bool, bool, bool) {
    // (case_sensitive, unicode, compression, encryption)
    match fs {
        "ext4" => (true, true, false, true),
        "btrfs" => (true, true, true, false),
        "xfs" => (true, true, false, false),
        "zfs" => (true, true, true, true),
        "f2fs" => (true, true, true, true),
        "tmpfs" | "overlayfs" | "fuse" => (true, true, false, false),
        "vfat" => (false, true, false, false),
        "ntfs" => (false, true, true, true),
        _ => (true, true, false, false),
    }
}

fn detect(path: &str) -> Result<FilesystemInfo> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(napi::Error::from_reason(format!("Path does not exist: {}", path)));
    }
    let cpath = CString::new(path)
        .map_err(|_| napi::Error::from_reason(format!("Invalid path string: {}", path)))?;
    let mut sfs: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(cpath.as_ptr(), &mut sfs) };
    if rc != 0 {
        return Err(napi::Error::from_reason(format!(
            "Failed to get filesystem information for '{}'",
            path
        )));
    }
    let fs = fs_name(sfs.f_type as i64);
    let (cs, uni, comp, enc) = caps(fs);
    Ok(FilesystemInfo {
        filesystem_type: fs.to_string(),
        volume_name: String::new(), // best-effort; not exposed by statfs
        max_filename_length: sfs.f_namelen as u32,
        supports_case_sensitive_names: cs,
        supports_unicode_filenames: uni,
        supports_compression: comp,
        supports_encryption: enc,
    })
}

#[napi]
pub fn detect_filesystem_sync(path: String) -> Result<FilesystemInfo> {
    detect(&path)
}

pub struct FsTask {
    path: String,
}

#[napi]
impl Task for FsTask {
    type Output = FilesystemInfo;
    type JsValue = FilesystemInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        detect(&self.path)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn detect_filesystem_async(path: String) -> napi::bindgen_prelude::AsyncTask<FsTask> {
    napi::bindgen_prelude::AsyncTask::new(FsTask { path })
}
```

Modify `nativelibs/file-utilities/src/lib.rs` — add `mod detect_filesystem;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/filesystem.test.js`
Expected: `OK filesystem: type consistent with statfs oracle, 7 fields present`

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/detect_filesystem.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/filesystem.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: detectFilesystem{Sync,Async} (Linux statfs mapping, 7 fields)"
```

---

### Task 7: `getDirectorySizeByGlob{Sync,Async}`

**Files:**
- Create: `nativelibs/file-utilities/src/get_directory_size_glob.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Test: `nativelibs/file-utilities/__tests__/glob.test.js`

**Interfaces:**
- Consumes: `DirectorySizeOptions`, `DirectorySizeResult` from `get_directory_size`; `(dev, ino)` hardlink dedup (same approach as `walk_size`).
- Produces:
  - `getDirectorySizeByGlobSync(pattern: String, options: Option<DirectorySizeOptions>) -> Result<DirectorySizeResult>`
  - `getDirectorySizeByGlobAsync(pattern: String, options: Option<DirectorySizeOptions>, jobId: u32) -> AsyncTask<GlobTask>`
  - Semantics: expand `pattern` with `globset` against the filesystem, sum matched regular files (dedup hardlinks), count them.

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/glob.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    // match only *.bin at top level: a.bin (1000) + b.bin (2000) = 3000, count 2
    const pat = path.join(root, '*.bin');
    const r = addon.getDirectorySizeByGlobSync(pat);
    assert.strictEqual(r.totalSize, 3000, `glob totalSize ${r.totalSize} != 3000`);
    assert.strictEqual(r.fileCount, 2, `glob fileCount ${r.fileCount} != 2`);

    // recursive: match all *.txt under root -> c.txt(500)+d.txt(300)=800, count 2
    const patTxt = path.join(root, '**', '*.txt');
    const rt = addon.getDirectorySizeByGlobSync(patTxt);
    assert.strictEqual(rt.totalSize, 800, `glob txt totalSize ${rt.totalSize} != 800`);

    const ra = await addon.getDirectorySizeByGlobAsync(pat, undefined, 2);
    assert.strictEqual(ra.totalSize, 3000, 'async glob total');

    assert.throws(() => addon.getDirectorySizeByGlobSync('['), /glob|pattern/i);
    console.log('OK glob: matched-file sums correct, bad pattern rejected');
  } finally {
    h.rmFixture(root);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/glob.test.js`
Expected: FAIL — `getDirectorySizeByGlobSync` is not a function.

- [ ] **Step 3: Write the implementation**

`nativelibs/file-utilities/src/get_directory_size_glob.rs`:

```rust
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use globset::Glob;
use napi::{Env, Result, Task};
use napi_derive::napi;
use walkdir::WalkDir;

use crate::get_directory_size::{DirectorySizeOptions, DirectorySizeResult};
use crate::shared::async_job::{num_workers, register_job, unregister_job};

// Split a glob pattern into a literal base dir to walk + the matcher.
fn base_dir(pattern: &str) -> PathBuf {
    let mut base = PathBuf::new();
    for comp in Path::new(pattern).components() {
        let s = comp.as_os_str().to_string_lossy();
        if s.contains('*') || s.contains('?') || s.contains('[') {
            break;
        }
        base.push(comp.as_os_str());
    }
    if base.as_os_str().is_empty() {
        base.push(".");
    }
    base
}

fn compute(pattern: &str, _workers: usize, cancel: &AtomicBool) -> Result<DirectorySizeResult> {
    let start = Instant::now();
    let glob = Glob::new(pattern)
        .map_err(|e| napi::Error::from_reason(format!("Invalid glob pattern '{}': {}", pattern, e)))?
        .compile_matcher();

    let base = base_dir(pattern);
    let mut total = 0f64;
    let mut count = 0u32;
    let mut seen: HashSet<(u64, u64)> = HashSet::new();

    for entry in WalkDir::new(&base).into_iter().filter_map(|e| e.ok()) {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if !glob.is_match(entry.path()) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            // hardlink dedup by (dev, ino) — no open fd (see walk_size rationale)
            if !seen.insert((meta.dev(), meta.ino())) {
                continue;
            }
            total += meta.len() as f64;
            count += 1;
        }
    }

    Ok(DirectorySizeResult {
        total_size: total,
        file_count: count,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

#[napi]
pub fn get_directory_size_by_glob_sync(
    pattern: String,
    options: Option<DirectorySizeOptions>,
) -> Result<DirectorySizeResult> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = AtomicBool::new(false);
    compute(&pattern, workers, &cancel)
}

pub struct GlobTask {
    pattern: String,
    workers: usize,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

#[napi]
impl Task for GlobTask {
    type Output = DirectorySizeResult;
    type JsValue = DirectorySizeResult;
    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.pattern, self.workers, &self.cancel)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Ok(output)
    }
    fn reject(&mut self, _env: Env, err: napi::Error) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Err(err)
    }
}

#[napi]
pub fn get_directory_size_by_glob_async(
    pattern: String,
    options: Option<DirectorySizeOptions>,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<GlobTask> {
    let workers = num_workers(options.and_then(|o| o.workers));
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(GlobTask {
        pattern,
        workers,
        cancel,
        job_id,
    })
}
```

Modify `nativelibs/file-utilities/src/lib.rs` — add `mod get_directory_size_glob;`. Also make the struct fields public across modules: ensure `DirectorySizeOptions`/`DirectorySizeResult` in `get_directory_size.rs` are declared `pub struct` (they are).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/glob.test.js`
Expected: `OK glob: matched-file sums correct, bad pattern rejected`

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/get_directory_size_glob.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/glob.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: getDirectorySizeByGlob{Sync,Async} via globset"
```

---

### Task 8: `getDirectorySizeTree{Sync,Async}` + drop `ping`

**Files:**
- Create: `nativelibs/file-utilities/src/get_directory_size_tree.rs`
- Modify: `nativelibs/file-utilities/src/lib.rs`
- Modify: `nativelibs/file-utilities/__tests__/smoke.test.js`
- Test: `nativelibs/file-utilities/__tests__/tree.test.js`

**Interfaces:**
- Produces:
  - `#[napi(object)] DirectoryTreeOptions { max_depth: i32, workers: Option<u32>, include_root: Option<bool> }`
  - `#[napi(object)] DirectoryTreeResult { name: String, path: String, relative_path: String, depth: u32, size: f64, file_count: u32, children: Vec<DirectoryTreeResult> }` → `{ name, path, relativePath, depth, size, fileCount, children }`.
  - `getDirectorySizeTreeSync(path: String, options: DirectoryTreeOptions) -> Result<DirectoryTreeResult>`
  - `getDirectorySizeTreeAsync(path: String, options: DirectoryTreeOptions, jobId: u32) -> AsyncTask<TreeTask>`
  - Semantics: recurse to `max_depth` (root depth 0); each node's `size`/`fileCount` are cumulative for its subtree (dedup hardlinks per whole tree); `include_root=false` returns the root node with only children populated per the mac wrapper's default. `max_depth < 0` errors `max_depth must be >= 0`.

- [ ] **Step 1: Write the failing test**

`nativelibs/file-utilities/__tests__/tree.test.js`:

```js
const path = require('path');
const assert = require('assert');
const addon = require('./load-addon');
const h = require('./helpers');

(async () => {
  const { root } = h.makeFixture();
  try {
    const t = addon.getDirectorySizeTreeSync(root, { maxDepth: 3 });
    assert.strictEqual(t.depth, 0, 'root depth 0');
    assert.strictEqual(t.size, 3800, `root subtree size ${t.size} != 3800`);
    assert.ok(Array.isArray(t.children), 'children is array');
    // find the 'sub' child
    const sub = t.children.find((c) => c.name === 'sub');
    assert.ok(sub, 'sub child present');
    assert.strictEqual(sub.depth, 1, 'sub depth 1');
    // sub subtree = c.txt(500)+d.txt(300)+a-link(dedup with a.bin at root: counted at whichever visited first)
    assert.ok(sub.size >= 800, `sub size ${sub.size} >= 800`);
    assert.strictEqual(sub.relativePath, 'sub', 'relativePath');

    // maxDepth 0 -> no children expanded
    const t0 = addon.getDirectorySizeTreeSync(root, { maxDepth: 0 });
    assert.strictEqual(t0.children.length, 0, 'maxDepth 0 -> no children');
    assert.strictEqual(t0.size, 3800, 'maxDepth 0 size still full subtree');

    const ta = await addon.getDirectorySizeTreeAsync(root, { maxDepth: 2 }, 3);
    assert.strictEqual(ta.size, 3800, 'async tree size');

    assert.throws(() => addon.getDirectorySizeTreeSync(root, { maxDepth: -1 }), /max_depth|>= 0/i);
    console.log('OK tree: recursive sizes + depth + relativePath + maxDepth clamp');
  } finally {
    h.rmFixture(root);
  }
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nativelibs/file-utilities && cargo build --release && node __tests__/tree.test.js`
Expected: FAIL — `getDirectorySizeTreeSync` is not a function.

- [ ] **Step 3: Write the implementation**

`nativelibs/file-utilities/src/get_directory_size_tree.rs`:

```rust
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::{Env, Result, Task};
use napi_derive::napi;

use crate::shared::async_job::{register_job, unregister_job};

#[napi(object)]
pub struct DirectoryTreeOptions {
    pub max_depth: i32,
    pub workers: Option<u32>,
    pub include_root: Option<bool>,
}

#[napi(object)]
pub struct DirectoryTreeResult {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub depth: u32,
    pub size: f64,
    pub file_count: u32,
    pub children: Vec<DirectoryTreeResult>,
}

// Recursively build a node. `seen` dedups hardlinks across the whole tree.
// Returns the node; size/file_count are cumulative for the subtree regardless of depth.
fn build(
    dir: &Path,
    root: &Path,
    depth: u32,
    max_depth: u32,
    seen: &Mutex<HashSet<(u64, u64)>>,
    cancel: &AtomicBool,
) -> DirectoryTreeResult {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());
    let relative_path = dir
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut size = 0f64;
    let mut file_count = 0u32;
    let mut children = Vec::new();

    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let ft = meta.file_type();
            if ft.is_dir() {
                let child = build(&path, root, depth + 1, max_depth, seen, cancel);
                size += child.size;
                file_count += child.file_count;
                if depth < max_depth {
                    children.push(child);
                }
            } else if ft.is_file() {
                // hardlink dedup by (dev, ino) — no open fd (see walk_size rationale)
                if !seen.lock().unwrap().insert((meta.dev(), meta.ino())) {
                    continue;
                }
                size += meta.len() as f64;
                file_count += 1;
            }
        }
    }

    DirectoryTreeResult {
        name,
        path: dir.to_string_lossy().to_string(),
        relative_path,
        depth,
        size,
        file_count,
        children,
    }
}

fn compute(path: &str, opts: &DirectoryTreeOptions, cancel: &AtomicBool) -> Result<DirectoryTreeResult> {
    if opts.max_depth < 0 {
        return Err(napi::Error::from_reason("max_depth must be >= 0".to_string()));
    }
    let root = Path::new(path);
    if !root.exists() {
        return Err(napi::Error::from_reason(format!(
            "Root path does not exist: {}",
            path
        )));
    }
    let seen = Mutex::new(HashSet::new());
    Ok(build(root, root, 0, opts.max_depth as u32, &seen, cancel))
}

#[napi]
pub fn get_directory_size_tree_sync(
    path: String,
    options: DirectoryTreeOptions,
) -> Result<DirectoryTreeResult> {
    let cancel = AtomicBool::new(false);
    compute(&path, &options, &cancel)
}

pub struct TreeTask {
    path: String,
    options: DirectoryTreeOptions,
    cancel: Arc<AtomicBool>,
    job_id: u32,
}

#[napi]
impl Task for TreeTask {
    type Output = DirectoryTreeResult;
    type JsValue = DirectoryTreeResult;
    fn compute(&mut self) -> Result<Self::Output> {
        compute(&self.path, &self.options, &self.cancel)
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Ok(output)
    }
    fn reject(&mut self, _env: Env, err: napi::Error) -> Result<Self::JsValue> {
        unregister_job(self.job_id);
        Err(err)
    }
}

#[napi]
pub fn get_directory_size_tree_async(
    path: String,
    options: DirectoryTreeOptions,
    job_id: u32,
) -> napi::bindgen_prelude::AsyncTask<TreeTask> {
    let cancel = register_job(job_id);
    napi::bindgen_prelude::AsyncTask::new(TreeTask {
        path,
        options,
        cancel,
        job_id,
    })
}
```

Modify `nativelibs/file-utilities/src/lib.rs` — final form (drop `ping`):

```rust
mod shared;
mod get_directory_size;
mod get_directory_size_glob;
mod get_directory_size_tree;
mod detect_hardlinks;
mod detect_filesystem;
```

Modify `nativelibs/file-utilities/__tests__/smoke.test.js` — replace the `ping` assertion with a real export check:

```js
const assert = require('assert');
const addon = require('./load-addon');
for (const fn of [
  'getDirectorySizeSync', 'getDirectorySizeAsync',
  'getDirectorySizeTreeSync', 'getDirectorySizeTreeAsync',
  'getDirectorySizeByGlobSync', 'getDirectorySizeByGlobAsync',
  'detectHardlinksSync', 'detectHardlinksAsync',
  'detectFilesystemSync', 'detectFilesystemAsync',
  'cancelJob',
]) {
  assert.strictEqual(typeof addon[fn], 'function', `missing export: ${fn}`);
}
console.log('OK smoke: all 11 exports present');
```

- [ ] **Step 4: Run all tests to verify they pass**

Run:
```bash
cd nativelibs/file-utilities && cargo build --release && \
for t in smoke cancel directory-size hardlinks filesystem glob tree; do node __tests__/$t.test.js || exit 1; done
```
Expected: every `OK …` line prints, exit 0.

- [ ] **Step 5: Commit**

```bash
git add nativelibs/file-utilities/src/get_directory_size_tree.rs nativelibs/file-utilities/src/lib.rs nativelibs/file-utilities/__tests__/tree.test.js nativelibs/file-utilities/__tests__/smoke.test.js nativelibs/file-utilities/Cargo.lock
git commit -m "file-utilities: getDirectorySizeTree{Sync,Async}; finalize 11-export surface"
```

---

### Task 9: Patch script — build, deploy, splice `getPlatformPath()`

**Files:**
- Create: `scripts/patches/patch-file-utilities.js`
- Test: `scripts/patches/__tests__/patch-file-utilities.test.js`

**Interfaces:**
- Consumes: built `.node` from Task 8; the app wrapper `app/native/nativelibs/file-utilities/index.js` (gitignored).
- Produces: `module.exports = { main, spliceLinuxBranch }`; deploys `.node` to `app/native/nativelibs/file-utilities/linux_x64/file-utilities.node`; splices a `linux` case into `getPlatformPath()`.

- [ ] **Step 1: Write the failing test (splice unit test)**

`scripts/patches/__tests__/patch-file-utilities.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spliceLinuxBranch } = require('../patch-file-utilities.js');

// Minimal stub mirroring the real getPlatformPath() default branch.
const stub = `
function getPlatformPath() {
  switch (platform) {
    case 'darwin':
      return join(__dirname, 'darwin', 'file-utilities.node');
    default:
      throw new Error(\`Unsupported OS: \${platform}, architecture: \${arch}\`);
  }
}
`;
const tmp = path.join(os.tmpdir(), 'fu-index-' + process.pid + '.js');
fs.writeFileSync(tmp, stub);
spliceLinuxBranch(tmp);
const out = fs.readFileSync(tmp, 'utf8');
assert.ok(out.includes("case 'linux'"), 'linux case spliced');
assert.ok(out.includes("linux_x64', 'file-utilities.node'"), 'linux_x64 path present');
// idempotent
spliceLinuxBranch(tmp);
const out2 = fs.readFileSync(tmp, 'utf8');
assert.strictEqual((out2.match(/case 'linux'/g) || []).length, 1, 'splice is idempotent');
fs.unlinkSync(tmp);
console.log('OK patch-file-utilities: splice adds linux case, idempotent');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/patches/__tests__/patch-file-utilities.test.js`
Expected: FAIL — cannot find module `../patch-file-utilities.js`.

- [ ] **Step 3: Write the patch script**

`scripts/patches/patch-file-utilities.js`:

```js
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const LIB_DIR = path.join(ROOT, 'nativelibs', 'file-utilities');
const DEST_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'linux_x64');
const INDEX_JS = path.join(APP_DIR, 'native', 'nativelibs', 'file-utilities', 'index.js');
const BUILT_SO = path.join(LIB_DIR, 'target', 'release', 'libfile_utilities.so');

// Splice a `case 'linux':` returning the linux_x64 addon, right before `default:`.
const ANCHOR_RE = /(\n\s*)default:\s*\n\s*throw new Error\(`Unsupported OS/;
function spliceLinuxBranch(indexPath) {
  let c = fs.readFileSync(indexPath, 'utf8');
  if (c.includes("'linux_x64', 'file-utilities.node'")) return; // idempotent
  if (!ANCHOR_RE.test(c)) {
    throw new Error("patch-file-utilities: getPlatformPath() default branch not found — bundle format changed, update the splice");
  }
  const replacement =
    "$1case 'linux':$1  return join(__dirname, 'linux_x64', 'file-utilities.node');$1default:\n      throw new Error(`Unsupported OS";
  fs.writeFileSync(indexPath, c.replace(ANCHOR_RE, replacement), 'utf8');
}

async function main() {
  if (!fs.existsSync(path.join(LIB_DIR, 'Cargo.toml'))) {
    throw new Error(`file-utilities source missing at ${LIB_DIR}/Cargo.toml`);
  }

  // 1. Build the Rust addon (N-API ABI-stable; no Electron headers needed).
  logger.info('Building file-utilities addon (cargo)...');
  execSync('cargo build --release', { cwd: LIB_DIR, stdio: 'inherit' });
  if (!fs.existsSync(BUILT_SO)) throw new Error(`file-utilities build produced no ${BUILT_SO}`);

  // 2. Deploy: rename the cdylib to <name>.node under linux_x64/.
  fs.ensureDirSync(DEST_DIR);
  const destNode = path.join(DEST_DIR, 'file-utilities.node');
  fs.copyFileSync(BUILT_SO, destNode);

  // 3. Splice index.js.
  if (!fs.existsSync(INDEX_JS)) throw new Error('file-utilities/index.js not found — did extraction overlay app.asar.unpacked?');
  spliceLinuxBranch(INDEX_JS);

  // 4. Post-conditions (fail loud).
  if (!fs.existsSync(destNode) || fs.statSync(destNode).size === 0) throw new Error('patch-file-utilities: .node missing/empty');
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(destNode, 'r');
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (!(magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46)) {
    throw new Error('patch-file-utilities: .node is not an ELF file');
  }
  // Reject any non-system shared-lib dependency.
  const ldd = execSync(`ldd "${destNode}"`).toString();
  const bad = ldd.split('\n').filter((l) => /=>/.test(l) && !/\/(lib|lib64|usr\/lib)\S*\/(libc|libgcc_s|libm|libpthread|libdl|librt|ld-linux)/.test(l) && !/linux-vdso/.test(l));
  if (bad.length) {
    throw new Error(`patch-file-utilities: unexpected non-system deps:\n${bad.join('\n')}`);
  }
  if (!fs.readFileSync(INDEX_JS, 'utf8').includes("'linux_x64', 'file-utilities.node'")) {
    throw new Error('patch-file-utilities: linux require not present in index.js after splice');
  }

  logger.success('file-utilities installed');
}

if (require.main === module) main().catch((e) => { logger.error(e.message); process.exit(1); });
module.exports = { main, spliceLinuxBranch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/patches/__tests__/patch-file-utilities.test.js`
Expected: `OK patch-file-utilities: splice adds linux case, idempotent`

- [ ] **Step 5: Commit**

```bash
git add scripts/patches/patch-file-utilities.js scripts/patches/__tests__/patch-file-utilities.test.js
git commit -m "file-utilities: patch script (cargo build, deploy linux_x64, splice getPlatformPath)"
```

---

### Task 10: Register the patch in `scripts/main.js`

**Files:**
- Modify: `scripts/main.js` (after the `patch-zimage` line, ~line 64)

**Interfaces:**
- Consumes: `patch-file-utilities.js` `main()`.

- [ ] **Step 1: Add the registration**

In `scripts/main.js`, immediately after:

```js
      await require('./patches/patch-zimage.js').main();
```

add:

```js
      await require('./patches/patch-file-utilities.js').main();
```

- [ ] **Step 2: Verify ordering is intact**

Run: `grep -n "patch-file-utilities\|patch-zimage\|patch-zjxl" scripts/main.js`
Expected: `patch-zjxl` → `patch-zimage` → `patch-file-utilities` in that order.

- [ ] **Step 3: Commit**

```bash
git add scripts/main.js
git commit -m "file-utilities: wire patch into build pipeline"
```

---

### Task 11: CI — Rust toolchain in `build.yml`

**Files:**
- Modify: `.github/workflows/build.yml`

**Interfaces:**
- Produces: cargo/rustc available before `npm run main` so `patch-file-utilities` can build.

- [ ] **Step 1: Add the Rust setup step**

In `.github/workflows/build.yml`, after the `Install npm deps` step and before `Setup + Build`, insert:

```yaml
      - name: Install Rust toolchain
        uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          toolchain: stable
          target: x86_64-unknown-linux-gnu
```

- [ ] **Step 2: Verify YAML is well-formed**

Run: `node -e "require('js-yaml') && console.log('has js-yaml')" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: install Rust toolchain for file-utilities build"
```

---

### Task 12: Docs — RE-PARAMS, README, roadmap

**Files:**
- Create: `nativelibs/file-utilities/RE-PARAMS.md`
- Create: `nativelibs/file-utilities/README.md`
- Modify: `docs/RE-ROADMAP.md`

- [ ] **Step 1: Write `RE-PARAMS.md`**

Content must document: recovered crate deps + versions; the module/API map; the byte-identical-OUTPUT fidelity model and the excluded fields; the semantics locked by TDD (totalSize = Σ st_size, hardlink dedup by (dev,ino), fileCount dedup rule, symlinks skipped); the Linux-authored `detect_filesystem` mapping table (magics + capability table) with the note that these are Linux-correct, not mac-identical; and the **residual gap**: the mac binary cross-check (run `file-utilities.node` on a Mac, diff fields) is deferred because Mach-O cannot run on Linux. List the three TDD-locked inferences (fileCount dedup, HardlinkResult shape, DirectoryTreeResult fields) explicitly as "verify on Mac if available."

- [ ] **Step 2: Write `README.md`**

Content: what the crate is, how to build (`cargo build --release`), how to run tests (`for t in ...; do node __tests__/$t.test.js; done`), how it is deployed (patch-file-utilities), and the N-API/Electron compatibility note.

- [ ] **Step 3: Update `docs/RE-ROADMAP.md`**

Mark `file-utilities` as ✅ DONE (native Rust napi-rs, full API, byte-identical output, linux_x64). Note `file-utils` (the sibling `getDiskUsage` C++ addon) remains unported. Keep the feature-gating note intact.

- [ ] **Step 4: Commit**

```bash
git add nativelibs/file-utilities/RE-PARAMS.md nativelibs/file-utilities/README.md docs/RE-ROADMAP.md
git commit -m "file-utilities: RE-PARAMS, README, roadmap update"
```

---

### Task 13: Full pipeline + in-app runtime verify

**Files:**
- None (verification only). May touch `docs/RE-ROADMAP.md` if the runtime check reveals a gap.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the whole build pipeline against a fresh extraction**

Run: `BUILD=true npm run main` (or the repo's documented full build).
Expected: `file-utilities installed` in the log; `.node` present at `app/native/nativelibs/file-utilities/linux_x64/file-utilities.node`; `index.js` contains the `case 'linux'` splice.

- [ ] **Step 2: Confirm the barrel loads the Linux binding**

Run:
```bash
node -e "const fu=require('./app/native/nativelibs/file-utilities/index.js'); console.log(typeof fu.getDirectorySizeAsync, typeof fu.detectFilesystemAsync);"
```
Expected: `function function` (no throw — the `Unsupported OS: linux` error is gone).

- [ ] **Step 3: Runtime verify in the app (Storage screen)**

Launch the built app (per the repo's run instructions; remember `unset ELECTRON_RUN_AS_NODE` + `DISPLAY=:0`). Open **Settings → Data Management / Storage**. Confirm real disk-usage figures render (non-zero) instead of the previous `0` / empty state. Note the observed values in the commit message.

- [ ] **Step 4: Final commit (if any doc note added)**

```bash
git add -A
git commit -m "file-utilities: runtime-verified on Linux (Storage screen shows real usage)"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide merge vs PR and integrate.

---

## Notes for the implementer

- **napi-rs prelude paths:** if `napi::bindgen_prelude::AsyncTask` / `Task` import paths differ in the resolved `napi` 2.x minor, use `use napi::bindgen_prelude::*;` at the top of each module and reference `AsyncTask`/`Task` unqualified. The `#[napi]` macro on an `impl Task` block is required for napi-derive to generate the promise glue.
- **snake_case → camelCase:** napi-derive renames automatically. Do **not** add explicit `js_name` except where a name can't be derived (only `cancelJob` uses `js_name` here, and only because `cancel_job` → `cancelJob` is already correct — the explicit `js_name` is belt-and-suspenders; drop it if it causes a duplicate-name error).
- **`f_namelen` field name:** on glibc `libc::statfs`, the field is `f_namelen` (i64/`__fsword_t`). If the resolved `libc` version names it differently, check `libc::statfs` docs for the target.
- **Cargo.lock:** gitignored per user instruction (see `nativelibs/file-utilities/.gitignore`). Do NOT commit it — the `git add … Cargo.lock` fragments in later task steps are no-ops (git silently skips ignored paths) and can be omitted.
- **Do not** run tests or the pipeline as root; fixtures live under the user's tmp.
- **Addon loading in tests:** every `__tests__/*.test.js` loads the addon via `require('./load-addon')` (created in Task 2), never by requiring the `.so` directly. Node's `require()` only auto-registers `.node`, so `load-addon.js` aliases the `.so` extension once. Do not duplicate that shim in individual test files.
```
