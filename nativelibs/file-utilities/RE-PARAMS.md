# file-utilities — reverse-engineered parameters

Recovered from the macOS native addon shipped alongside Zalo (`file-utilities.node`,
Mach-O, `napi-rs` binding):

- `app/native/nativelibs/file-utilities/darwin/file-utilities.node`
- `app/native/nativelibs/file-utilities/darwin-arm/file-utilities.node`

Tool: string extraction over the Mach-O binary (rustc registry paths, symbol names,
error-message literals). Unlike zimage/zjxl there is no disassembly here — the mac
binary carries no interesting per-platform *logic* to recover for the OS-agnostic
functions (`walkdir`/`globset` filesystem walks behave the same on any Unix); the one
genuinely OS-specific function, `detectFilesystem`, has **no Linux code to port** in the
mac binary at all (it's built on macOS `statfs`/`getattrlist`) and is authored fresh —
see §5.

This module is **distinct** from the sibling `file-utils` (older C++ addon, exposes
`getDiskUsage`, still unported — out of scope here, see `docs/RE-ROADMAP.md`).

---

## 1. Recovered crate deps + source layout

Versions pinned verbatim from the registry paths embedded in the mac binary's strings,
and reproduced exactly in `nativelibs/file-utilities/Cargo.toml`:

| Crate | Version | Role |
| --- | --- | --- |
| `napi` | `2.x` (`features = ["napi8"]`, `default-features = false`) | N-API bindgen, ABI-stable surface |
| `napi-derive` | `2.x` | `#[napi]` / `#[napi(object)]` macros |
| `walkdir` | `=2.5.0` | recursive directory walk (size, glob, tree) |
| `same-file` | `=1.0.6` | pulled in **transitively by `walkdir` 2.5.0** (not a direct dep of this crate — walkdir itself doesn't need it for our usage, but the version is pinned in `Cargo.lock` because the mac binary's registry strings show it linked at this exact version) |
| `lazy_static` | `=1.5.0` | the `JOBS` static job registry (`shared/async_job.rs`) |
| `globset` | `0.4` | `getDirectorySizeByGlob*` pattern matching |
| `num_cpus` | `1` | default `workers` count when the caller omits it |
| `libc` | `0.2` | `statfs(2)` FFI for `detect_filesystem.rs` (Linux-authored, not present in the mac string dump — added because the Linux implementation needs it) |

The mac binary's registry strings additionally show **`tokio 1.36.0`** and a build
`rustc` hash `25ef9e3d…`. `tokio` backs the mac binding's async runtime; this port uses
`napi::bindgen_prelude::AsyncTask` (libuv threadpool) instead — see §6 "async engine".

**Recovered source-module layout** (from the mac binary's embedded panic/file-path
strings, reproduced 1:1 as the actual Rust module tree):

```
src/lib.rs                       — mod declarations only
src/get_directory_size.rs        — getDirectorySizeSync/Async, DirectorySizeOptions/Result
src/get_directory_size_tree.rs   — getDirectorySizeTreeSync/Async, DirectoryTreeOptions/Result
src/get_directory_size_glob.rs   — getDirectorySizeByGlobSync/Async
src/detect_hardlinks.rs          — detectHardlinksSync/Async, HardlinkResult
src/detect_filesystem.rs         — detectFilesystemSync/Async, FilesystemInfo (Linux-authored, §5)
src/shared/mod.rs                — pub mod async_job;
src/shared/async_job.rs          — JOBS registry, register_job/unregister_job/cancel_job,
                                    num_workers(), walk_size() (shared by size + glob paths)
```

---

## 2. Full 11-export API map

Exported names/casing match the mac `napi-rs` binding exactly (verified against
`__tests__/smoke.test.js`, which asserts all 11 are functions on the loaded addon):

| # | Export | Signature | Returns |
| --- | --- | --- | --- |
| 1 | `getDirectorySizeSync` | `(path, options?: DirectorySizeOptions)` | `DirectorySizeResult` |
| 2 | `getDirectorySizeAsync` | `(path, options?, jobId: number)` | `Promise<DirectorySizeResult>` |
| 3 | `getDirectorySizeTreeSync` | `(path, options: DirectoryTreeOptions)` | `DirectoryTreeResult` |
| 4 | `getDirectorySizeTreeAsync` | `(path, options: DirectoryTreeOptions, jobId)` | `Promise<DirectoryTreeResult>` |
| 5 | `getDirectorySizeByGlobSync` | `(pattern, options?: DirectorySizeOptions)` | `DirectorySizeResult` |
| 6 | `getDirectorySizeByGlobAsync` | `(pattern, options?, jobId)` | `Promise<DirectorySizeResult>` |
| 7 | `detectHardlinksSync` | `(path)` | `HardlinkResult` |
| 8 | `detectHardlinksAsync` | `(path)` | `Promise<HardlinkResult>` |
| 9 | `detectFilesystemSync` | `(path)` | `FilesystemInfo` |
| 10 | `detectFilesystemAsync` | `(path)` | `Promise<FilesystemInfo>` |
| 11 | `cancelJob` | `(jobId: number)` | `void` — flips the job's cancel flag |

No `Task` struct classes are leaked on the JS surface: `DirSizeTask`, `TreeTask`,
`GlobTask`, `HardlinkTask`, `FsTask` implement `napi::Task` but are **not** annotated
with `#[napi]` on their `impl Task` blocks, so only the 11 plain functions above appear
on `module.exports` — matching the mac binding's export list (commit `9507848`).

### Structs (`#[napi(object)]`, camelCase JS field names)

```
DirectorySizeOptions {
  workers?: number
}

DirectorySizeResult {
  totalSize: number     // f64 — sum of st_size, hardlink-deduped
  fileCount: number     // u32 — unique-inode regular files
  durationMs: number     // f64 — wall-clock, EXCLUDED from fidelity checks (§4)
}

DirectoryTreeOptions {
  maxDepth: number        // i32, must be >= 0
  workers?: number
  includeRoot?: boolean   // accepted, not consumed — §7 item 4
}

DirectoryTreeResult {
  name: string             // dir.file_name()
  path: string              // absolute path of this node
  relativePath: string      // path.strip_prefix(root)
  depth: number              // u32, 0 at root
  size: number                // f64, cumulative for the subtree
  fileCount: number           // u32, cumulative for the subtree
  children: DirectoryTreeResult[]  // omitted (not recursed into) once depth == maxDepth
}

HardlinkResult {
  isHardlink: boolean   // nlink > 1
  linkCount: number      // u32, raw st_nlink
}

FilesystemInfo {
  filesystemType: string               // e.g. "ext4", "btrfs", "unknown"
  volumeName: string                    // always "" on Linux — best-effort, not exposed by statfs
  maxFilenameLength: number             // u32, f_namelen from statfs
  supportsCaseSensitiveNames: boolean
  supportsUnicodeFilenames: boolean
  supportsCompression: boolean
  supportsEncryption: boolean
}
```

Field source: `nativelibs/file-utilities/src/get_directory_size.rs`,
`get_directory_size_tree.rs`, `detect_hardlinks.rs`, `detect_filesystem.rs` (napi-derive
auto-converts `snake_case` Rust fields to `camelCase` JS fields — the struct definitions
above use the JS-facing names).

---

## 3. Fidelity model — byte-identical OUTPUT

Same model as zimage/zjxl: the mac binary is Mach-O (arm64+x64), the Linux build is ELF
x64 — a byte-identical *binary* is physically impossible across OS/arch. "byte-to-byte"
here means **byte-identical result values** for the same filesystem input, verified
against an independent oracle (`du --apparent-size -sb`, `find -type f | wc -l`,
`stat -c %h`, `stat -f -c %T`; see `__tests__/*.test.js`).

**Explicitly excluded from the fidelity contract** (both classes match the zimage
precedent of "authored correct for Linux, not diffed against mac"):

1. **`durationMs`** (on `DirectorySizeResult`) — a wall-clock measurement, never
   reproducible byte-for-byte between two runs let alone two OSes.
2. **`detectFilesystem`'s descriptive fields** (`filesystemType`, `volumeName`,
   `maxFilenameLength`, all four `supports*` booleans) — these describe *the Linux
   filesystem under the test path*, which has no macOS counterpart to match against.
   They are authored to be **correct for Linux** (see §5's mapping table), not
   byte-identical to whatever the mac binary would report for a Mac volume.

---

## 4. Semantics locked by TDD

These were not visible in the mac binary's strings and were pinned by writing tests
against an independent coreutils oracle first (`nativelibs/file-utilities/__tests__/`,
commits `7c65264`, `6edc460`, `fa4ef7c`, `17496f7`):

1. **`totalSize`** = Σ `st_size` (`meta.len()`, apparent/logical bytes, matching
   `du --apparent-size`) over **regular files only**, walked via `symlink_metadata`
   (does not follow symlinks — a symlink is neither counted nor traversed through).
2. **Hardlink dedup is by `(dev, ino)`**, taken from already-stat'd metadata — **not**
   `same_file::Handle`. A `Handle`-based approach opens and holds a file descriptor per
   distinct file for the lifetime of the walk, which exhausts the process fd ulimit on
   large trees (commit `6edc460`). `(dev, ino)` achieves the identical dedup semantics
   without holding any fd open.
3. **Symlinks are excluded** — `ft.is_dir()` / `ft.is_file()` checks from
   `symlink_metadata` are false for a symlink, so it contributes to neither `totalSize`
   nor `fileCount`, and (for directory symlinks) is not descended into.
4. **`fileCount`** = number of **unique-inode** regular files — i.e. hardlink duplicates
   are counted **once**, using the same `(dev, ino)` `HashSet` as the size dedup (not
   once per directory entry). This applies uniformly to `getDirectorySize*`,
   `getDirectorySizeByGlob*`, and the per-node counts in `getDirectorySizeTree*`.
5. **`getDirectorySizeTree*`** node `size`/`fileCount` are **cumulative for the
   subtree**, computed bottom-up regardless of whether `children` is populated at that
   depth (see `build()` in `get_directory_size_tree.rs`: the recursive call always
   happens to accumulate `size`/`file_count`; only whether the child node object is
   *pushed into `children`* depends on `depth < max_depth`). Hardlink dedup is
   **global across the whole tree** (one shared `Mutex<HashSet<(u64,u64)>>` for the
   whole walk, not per-subtree), so a file hardlinked into two different subtrees is
   only counted in whichever one visits it first.
6. **`workers` is accepted for API parity but does not change output.** `walk_size()` is
   single-threaded by design (`shared/async_job.rs`, doc comment: "thread count cannot
   change the (commutative) sum, so `_workers` is accepted for API parity but the walk
   stays deterministic and free of concurrency hazards — byte-identical output"). This
   also sidesteps needing a specific parallelization strategy to match the mac binary's
   (unrecoverable-without-a-Mac) internal work-splitting.

---

## 5. `detectFilesystem` — Linux-authored mapping (not mac-identical)

There is nothing to "recover" here: the mac binary's filesystem-name mapping is built on
`statfs`/`getattrlist` semantics that only exist on Darwin (APFS/HFS+ specific fields);
Linux `statfs(2)` returns a different `f_type` magic-number space entirely. This table is
authored fresh against the Linux `statfs(2)` ABI (`src/detect_filesystem.rs`):

### `f_type` magic → canonical name

| Magic (hex) | Name |
| --- | --- |
| `0xEF53` | `ext4` |
| `0x9123683E` | `btrfs` |
| `0x58465342` | `xfs` |
| `0x2FC12FC1` | `zfs` |
| `0x01021994` | `tmpfs` |
| `0x794C7630` | `overlayfs` |
| `0x4D44` | `vfat` |
| `0x5346544E` | `ntfs` |
| `0xF2F52010` | `f2fs` |
| `0x6969` | `nfs` |
| `0xFF534D42` | `cifs` |
| `0x65735546` | `fuse` |
| *(anything else)* | `unknown` |

### Capability table (`caps(fs)` → `case_sensitive, unicode, compression, encryption`)

| Filesystem | Case-sensitive | Unicode | Compression | Encryption |
| --- | --- | --- | --- | --- |
| `ext4` | yes | yes | no | yes *(fscrypt)* |
| `btrfs` | yes | yes | yes | no |
| `xfs` | yes | yes | no | no |
| `zfs` | yes | yes | yes | yes |
| `f2fs` | yes | yes | yes | yes |
| `tmpfs` / `overlayfs` / `fuse` | yes | yes | no | no |
| `vfat` | no | yes | no | no |
| `ntfs` | no | yes | yes | yes |
| everything else / `unknown` | yes | yes | no | no |

Other fields: `maxFilenameLength` = `f_namelen` from the same `statfs(2)` call (not a
separate `statvfs` call, contrary to the original spec sketch — `libc::statfs` on Linux
already carries `f_namelen`). `volumeName` is always `""` — Linux `statfs(2)` exposes no
volume-label field, and no `/proc/mounts` lookup was added (best-effort only, kept
simple; flagged as a possible future enhancement, not a fidelity gap since §3 excludes
this field entirely).

**These values are Linux-correct, not mac-identical** — per §3, `detectFilesystem`'s
descriptive fields are explicitly outside the byte-identical-output contract.

---

## 6. Async engine — implementation deviation, not an output gap

The mac binary links `tokio 1.36.0` (multi-thread runtime) for its async exports. This
port uses `napi::bindgen_prelude::AsyncTask` (backed by the libuv/N-API threadpool)
instead — see `impl Task for DirSizeTask`/`TreeTask`/`GlobTask`/`HardlinkTask`/`FsTask`
in each module. Every async function's `compute()` calls the exact same synchronous
logic as its `*Sync` counterpart, so results are **identical regardless of which async
engine produced them** — this is a simpler implementation choice, not a fidelity
compromise, and needs no further verification.

---

## 7. Residual gaps / deferred Mac cross-check

Mach-O binaries cannot execute on Linux, so a live mac-vs-Linux field diff is
**deferred** — the same honest caveat documented for zimage. TDD against independent
coreutils oracles (`du`, `find`, `stat`) locks the *observable* behavior; the following
points are inferences that a Mac run (if one becomes available) should verify:

1. **`HardlinkResult` exact shape** (`{ isHardlink, linkCount }`) is inferred from the
   mac binary's string table (`isHardlink`/`linkCount` field-name strings were present,
   but their exact types/ordering/any-extra-fields are not independently confirmed).
   Verify on Mac if available.
2. **`DirectoryTreeResult` exact node field set** is inferred (`name`, `path`,
   `relativePath`, `depth`, `size`, `fileCount`, `children` — the first four field names
   plus `children` were confirmed via strings; `path` and `fileCount` are inferred by
   symmetry with `DirectorySizeResult` and are not independently string-confirmed).
   Verify on Mac if available.
3. **`fileCount` hardlink-dedup behavior** (we dedup by inode, counting each hardlinked
   file once) is a TDD-locked inference, not observed from the mac binary. Verify on Mac
   if available.
4. **`DirectoryTreeOptions.includeRoot` and `workers` are accepted but not consumed** by
   the tree walk (`build()` in `get_directory_size_tree.rs` never reads
   `opts.include_root`, and always emits the root node). `workers` is genuinely
   output-irrelevant here (§4 item 6: the walk is single-threaded and the sum is
   commutative, so no worker count can change a byte of output — this needs no Mac
   verification). `includeRoot=false`'s intended semantics (presumably: omit the root
   node from the result, or unwrap directly to `children`) are **unknown** without the
   mac binary — the option is accepted (so callers passing it don't error) but currently
   has no effect; flagged as a parity residual, not silently dropped.
5. **Async engine deviation** (§6): mac binary uses tokio 1.36.0, this port uses napi-rs
   `AsyncTask`. Output-identical by construction (same sync `compute()` either way) —
   documented as a known implementation deviation, not a residual *gap*.
6. **glob `*` recursion**: `getDirectorySizeByGlob*` compiles the pattern with
   `globset::Glob::new(pat).compile_matcher()`, whose default
   (`literal_separator = false`) makes a single `*` match across `/` — i.e. `*.bin`
   matches files nested arbitrarily deep under the walked base directory, not just
   direct children (locked by `__tests__/glob.test.js`, commit `668d62e`: a distinct
   non-hardlinked nested `.bin` file is used specifically to prove this isn't an
   accidental hardlink-dedup artifact). This is `globset`'s default and the same crate
   the mac binary links, making it the least-speculative choice, but the mac binary's
   exact `Glob` construction call (whether it explicitly sets `literal_separator(true)`
   to restrict `*` to one path segment) is not recoverable from strings alone. Verify on
   Mac if available.
7. **`detectHardlinks` on a broken symlink path**: `detect()` checks `p.exists()` first
   (`std::path::Path::exists`, which **follows** symlinks via `stat`, not `lstat`) —
   for a broken symlink (target missing), `exists()` returns `false`, so the function
   returns the `"Root path does not exist: {path}"` error, **not** a
   symlink-specific error and **not** treating the symlink itself as a hardlink-bearing
   file. This is carried over verbatim from the design spec's semantics sketch and is
   untested against the mac binary's actual behavior for this edge case. Verify on Mac
   if available.

---

## Summary of confidence

- **Certain (from mac binary strings):** crate list + exact pinned versions (napi/
  napi-derive 2.x, `walkdir 2.5.0`, `same-file 1.0.6`, `lazy_static 1.5.0`, `globset`,
  `num_cpus`, `tokio 1.36.0`), the 11-function export surface, source-module layout,
  error-message literals (`Worker count must be greater than 0`, `max_depth must be >= 0`,
  `Path '…' is not a directory`, `Root path does not exist: …`, `Invalid glob pattern
  '…'`), the `DirectoryTreeResult` field names `name`/`relativePath`/`depth`/`children`.
- **TDD-locked (certain behavior, not independently mac-confirmed):** `totalSize` basis
  and hardlink dedup rule, `fileCount` dedup rule, symlink exclusion, glob-across-`/`
  recursion, tree cumulative sizing.
- **Linux-authored, explicitly not mac-comparable:** the entire `detectFilesystem`
  magic-number table and capability table (§5), `durationMs` (§3).
- **Open residual gaps** (§7): `HardlinkResult`/`DirectoryTreeResult` exact shapes,
  `fileCount` dedup rule, `includeRoot` semantics, glob `literal_separator` setting,
  broken-symlink error path — all deferred pending a real mac-binary run, which is not
  possible on Linux (Mach-O cannot execute here).
