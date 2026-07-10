# RE file-utilities — Linux native addon (Rust napi-rs)

**Date:** 2026-07-10
**Branch:** `re/file-utilities`
**Goal:** Port the macOS-only `file-utilities` native module to Linux (**x64 only** for
now) by faithfully rebuilding its Rust `napi-rs` crate, exposing the **full API
surface**, with **byte-identical output** verified against an independent oracle.

> **Scope note:** the full API and full `DirectoryTree` are in scope. Only the
> `linux_x64` binary is built/deployed for now; `linux_arm64` is deliberately deferred
> (the crate stays arch-agnostic so arm64 is a later `cargo build` away).

---

## 1. Background

`app/native/nativelibs/file-utilities/index.js` is an auto-generated NAPI-RS binding.
Its `getPlatformPath()` supports only `darwin`/`darwin-arm` (+ win32 cases with no
shipped binaries) and `throw`s `Unsupported OS: linux`. The barrel
(`app/native/nativelibs/index.js`) wraps `fileUtilities()` in try/catch returning `{}`,
and every call-site degrades with `if (!fn) return 0`. Net effect: the **Data
Management / Storage** screen shows `0` / no data on Linux instead of crashing.

This module is **distinct** from the sibling `file-utils` (older C++ addon, provides
`getDiskUsage`, also unported — out of scope here).

### What the binary reveals

`file-utilities.node` is a Rust `napi-rs` addon. Strings expose the exact crate layout,
dependency versions, and struct field names:

- **Source modules:** `src/lib.rs`, `src/get_directory_size.rs`,
  `src/get_directory_size_tree.rs`, `src/get_directory_size_glob.rs`,
  `src/detect_hardlinks.rs`, `src/detect_filesystem.rs`, `src/shared/async_job.rs`
- **Crate deps (pin exactly):** `napi` / `napi-derive` 2.x, `walkdir` 2.5.0,
  `same-file` 1.0.6, `lazy_static` 1.5.0, `globset` (glob), `num_cpus` (worker default).
  rustc registry paths confirm these versions verbatim.
- **Syscalls:** `stat`, `lstat`, `fstat`, `opendir`, `readdir_r`, `statfs`, `closedir` —
  all standard Unix. Threads (`pthread_attr_setstacksize`, `pthread_setname_np`) back the
  `workers` option.

Because the interesting per-OS logic (the macOS `statfs` → filesystem-name mapping)
lives only in the macOS build, `detect_filesystem` **must be authored fresh for Linux**
— there is nothing in the mac binary to "port" for that path. The other functions are
OS-agnostic filesystem walks.

---

## 2. Fidelity target — "byte-to-byte"

The macOS binary is **Mach-O (arm64 + x64 universal)**; the Linux build is **ELF
x64/arm64**. A byte-identical *binary* is physically impossible across OS/arch (the same
honest gap documented for zimage: a Mach-O cannot run on Linux).

"byte-to-byte" therefore means **byte-identical OUTPUT**: every result field
(`totalSize`, `fileCount`, tree structure, `filesystemType`, hardlink status, …) matches
exactly what the mac binary returns for the same input, verified via an independent
oracle. Two classes are excluded as *inherently* non-deterministic or OS-specific:

- `durationMs` — a wall-clock measurement, never reproducible byte-for-byte.
- Filesystem-descriptive fields that depend on the host OS (`volumeName`,
  `supportsCompression`, etc.) — the mac binary has no Linux values to match against;
  these are authored to be *correct for Linux*, not identical to macOS.

This is the same model that succeeded for zimage (byte-identical thumbnails, not a
byte-identical binary).

---

## 3. Full API surface (all 11 exports)

The rebuilt crate exposes the complete binding — not just the four functions the app
currently calls. Names/casing must match the NAPI-RS binding exactly.

| Export | Native signature (as the JS wrapper calls it) |
| --- | --- |
| `getDirectorySizeSync` | `(path, options?: { workers? })` → `DirectorySizeResult` |
| `getDirectorySizeAsync` | `(path, options?, jobId)` → `Promise<DirectorySizeResult>` |
| `getDirectorySizeTreeSync` | `(path, { maxDepth, workers?, includeRoot? })` → `DirectoryTreeResult` |
| `getDirectorySizeTreeAsync` | `(path, treeOptions, jobId)` → `Promise<DirectoryTreeResult>` |
| `getDirectorySizeByGlobSync` | `(pattern, options?: { workers? })` → `DirectorySizeResult` |
| `getDirectorySizeByGlobAsync` | `(pattern, options?, jobId)` → `Promise<DirectorySizeResult>` |
| `detectHardlinksSync` | `(path)` → hardlink result (shape locked via TDD) |
| `detectHardlinksAsync` | `(path)` → `Promise<...>` |
| `detectFilesystemSync` | `(path)` → `FilesystemInfo` |
| `detectFilesystemAsync` | `(path)` → `Promise<FilesystemInfo>` |
| `cancelJob` | `(jobId)` → cancels an in-flight async job |

### Structs (`#[napi(object)]`, camelCase js fields)

- `DirectorySizeOptions { workers }`
- `DirectoryTreeOptions { maxDepth, workers, includeRoot }`
- `DirectorySizeResult { totalSize, fileCount, durationMs }`
- `DirectoryTreeResult { ...node fields (name, path, relativePath, depth, size), children: Vec<DirectoryTreeResult> }`
  — exact node field set confirmed via strings (`name`, `relativePath`, `depth`,
  `children`) + TDD.
- `FilesystemInfo { filesystemType, volumeName, maxFilenameLength, supportsCaseSensitiveNames, supportsUnicodeFilenames, supportsCompression, supportsEncryption }`

### Async / cancellation

Async variants run on a worker pool (`workers` defaults to `num_cpus`), returning a
`Promise` via `napi` threadsafe-function / `AsyncTask`, matching `src/shared/async_job.rs`.
`cancelJob(jobId)` signals cancellation through a per-job registry; the JS wrapper wires
`AbortSignal` → `cancelJob`. Error strings are reproduced verbatim
(`Worker count must be greater than 0`, `max_depth must be >= 0`, `Path '…' is not a
directory`, `Root path does not exist: …`, `Invalid glob pattern '…'`, etc.).

---

## 4. Semantics to lock precisely

1. **`totalSize`** = sum of `st_size` (apparent/logical bytes — `walkdir` uses
   `metadata().len()`), **deduplicated across hardlinks by `(dev, ino)`** via the
   `same-file` crate. Confirm the dedup and the size basis (logical vs allocated) by
   TDD against the oracle.
2. **`fileCount`** = number of regular files walked (whether hardlink duplicates are
   counted once or N times → locked by TDD).
3. **glob** = `globset` over the pattern; `getDirectorySizeByGlob*` sums matched entries.
4. **tree** = recursive walk to `maxDepth`; `includeRoot` toggles whether the root node
   is emitted; each node carries its own size + `children`.
5. **`detectHardlinks`** = takes a *file* path; errors if it does not exist / is not a
   regular file; reports hardlink status from `st_nlink`. Return shape locked via TDD.
6. **`detectFilesystem` (Linux, authored fresh):** `statfs().f_type` → filesystem name
   (`EXT4_SUPER_MAGIC 0xEF53`, `BTRFS_SUPER_MAGIC 0x9123683E`, `XFS 0x58465342`,
   `MSDOS/VFAT 0x4d44`, `NTFS 0x5346544e`, `TMPFS 0x01021994`, …); `f_namemax`
   (via `statvfs`) → `maxFilenameLength`; `volumeName` best-effort from `/proc/mounts`
   / mount source; the `supports*` booleans set from a per-filesystem capability table.

---

## 5. Build pipeline

- **Toolchain:** Rust stable via `rustup`. No Electron headers needed — `napi-rs` targets
  the stable **N-API ABI**, so one `.node` works across the Electron/Node versions the
  app uses.
- **Target:** `x86_64-unknown-linux-gnu` (native on the build box). arm64
  (`aarch64-unknown-linux-gnu`) is deferred — no cross toolchain wired for now.
- **Build host:** **ubuntu-22.04** (glibc 2.35) — matches the existing `.deb`
  portability floor (glibc ≥ 2.34, from the sqlite3/deb work).
- **Output:** `cargo build --release` produces a cdylib (`libfile_utilities.so`) →
  renamed `file-utilities.node`. `ldd` must show only `libc`/`libgcc_s`/`libm`/`libpthread`
  (all system) — no bundled deps, no RPATH needed.
- **Integration:**
  - Build step: extend `nativelibs/builder.js` to detect a `Cargo.toml` and run
    `cargo build --release`, or a dedicated `nativelibs/file-utilities/build.sh`.
  - `scripts/patches/patch-file-utilities.js` (modeled on `patch-zjxl.js`): splice a
    `linux` + `x64` branch into `getPlatformPath()` *before* the
    `default: throw`, then copy the built `.node` into
    `app/native/nativelibs/file-utilities/linux_x64/`. Idempotent.
  - Register in `scripts/main.js` next to `patch-zjxl` / `patch-zimage`.
  - `.github/workflows/build.yml`: install `rustup`/cargo (e.g. `actions-rust-lang/setup-rust-toolchain`
    or `rustup` in the apt step). No arm64 cross toolchain for now.

---

## 6. Verification (byte-identical output)

- **TDD fixtures** in `nativelibs/file-utilities/__tests__/`: a synthetic tree with
  known file sizes, a hardlinked pair, a symlink, nested depth (for tree/maxDepth), and
  a glob-matchable subset.
- **Independent oracle** — output must match these byte-for-byte:
  - `totalSize` ⟷ `du --apparent-size -sb <dir>` (coreutils dedups hardlinks by default)
  - `fileCount` ⟷ `find <dir> -type f | wc -l` (adjusted for the hardlink-dedup rule
    once TDD locks it)
  - hardlink status ⟷ `stat -c %h <file>`
  - `filesystemType` ⟷ `stat -f -c %T <path>` / `findmnt`
- **mac-binary cross-check** = run the real `file-utilities.node` on a Mac over the same
  fixtures, diff field-by-field. Deferred as a **residual gap** (Mach-O can't run on
  Linux — same honest caveat as zimage), documented in `RE-PARAMS.md`.
- **Runtime verify in-app:** with `fileUtilities()` loading the Linux binding, open the
  Data Management / Storage screen and confirm real disk usage renders instead of `0`.

---

## 7. Deliverables

- `nativelibs/file-utilities/` — `Cargo.toml`, `Cargo.lock`, `src/**`, `__tests__/`,
  `RE-PARAMS.md`, `README.md`.
- `scripts/patches/patch-file-utilities.js` + registration in `scripts/main.js`.
- `.github/workflows/build.yml` toolchain additions.
- Deployed `.node` under `app/native/nativelibs/file-utilities/linux_x64/`.
- `docs/RE-ROADMAP.md` updated (file-utilities → ✅ DONE).

## 8. Open items (locked during implementation via TDD)

- (a) `fileCount` hardlink-dedup behavior.
- (b) `detectHardlinks*` exact return shape.
- (c) `DirectoryTreeResult` complete node field set.
- (d) `volumeName` / `supports*` best-effort mapping table for Linux filesystems.
