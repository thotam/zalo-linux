# file-utilities (native, Linux)

Native filesystem-statistics addon for Zalo's `native/nativelibs/file-utilities` —
directory-size accumulation (plain, glob-filtered, and tree-shaped), hardlink
detection, and filesystem-type detection. Reimplemented from scratch for Linux x64
as a Rust `napi-rs` crate, ABI-stable against N-API so it does not need rebuilding on
every Electron point release.

**Attribution:** this is a clean-room reimplementation, not a copy of upstream Zalo
source (none was available for Linux). The only artifacts consulted were the shipped
macOS `file-utilities.node` binaries (`app/native/nativelibs/file-utilities/darwin/`
and `darwin-arm/`, Mach-O with `napi-rs`/rustc strings intact), string-extracted to
recover the exact crate versions, module layout, export names, struct field names, and
error-message literals needed for output parity — see `RE-PARAMS.md` for the full
recovery trail and `docs/superpowers/specs/2026-07-10-file-utilities-re-design.md` for
the design. No Zalo source code was used or referenced.

This module is **distinct** from the sibling `file-utils` (older C++ addon, exposes
`getDiskUsage`), which remains unported — see `docs/RE-ROADMAP.md`.

## What it does

11 exports, matching the mac binding's full API surface (not just the subset the app
currently calls):

- `getDirectorySizeSync` / `getDirectorySizeAsync` — recursive size + file count of a
  directory tree.
- `getDirectorySizeTreeSync` / `getDirectorySizeTreeAsync` — same, but returns a full
  node tree (`name`, `path`, `relativePath`, `depth`, `size`, `fileCount`, `children`)
  down to `maxDepth`.
- `getDirectorySizeByGlobSync` / `getDirectorySizeByGlobAsync` — size + count of files
  matching a `globset` pattern (recursive `*`, i.e. `*.bin` matches nested files too).
- `detectHardlinksSync` / `detectHardlinksAsync` — `{ isHardlink, linkCount }` for a
  single file path, from `st_nlink`.
- `detectFilesystemSync` / `detectFilesystemAsync` — filesystem type + capability
  booleans for a path, from `statfs(2)` (Linux-authored mapping table, see
  `RE-PARAMS.md` §5).
- `cancelJob(jobId)` — cancels an in-flight async job (size/tree/glob variants poll a
  per-job `AtomicBool` and return partial results).

All hardlink dedup (for `totalSize`/`fileCount`) is by `(dev, ino)` from already-stat'd
metadata, not an open file handle — see `RE-PARAMS.md` §4 for why (fd-exhaustion on
large trees).

## Build

Requires only a Rust stable toolchain (via `rustup`) — no Electron/Node headers, since
`napi-rs` targets the stable N-API ABI:

```bash
cd nativelibs/file-utilities
cargo build --release
```

Produces `target/release/libfile_utilities.so`. `Cargo.lock` is gitignored (see
`nativelibs/file-utilities/.gitignore`) — versions are pinned in `Cargo.toml` instead
(`walkdir = "=2.5.0"`, `same-file = "=1.0.6"`, `lazy_static = "=1.5.0"`), matching the
versions recovered from the mac binary.

## Test

Each `__tests__/*.test.js` loads the freshly-built `.so` directly (via
`__tests__/load-addon.js`, which aliases the `.so` extension onto Node's `.node`
loader) and asserts against an independent coreutils oracle (`du`, `find`, `stat`) —
no Electron runtime needed to run these.

```bash
cd nativelibs/file-utilities
cargo build --release
for t in smoke cancel directory-size hardlinks filesystem glob tree; do
  node __tests__/$t.test.js
done
```

## Deployment

`scripts/patches/patch-file-utilities.js` (modeled on `patch-zjxl.js`, registered in
`scripts/main.js`):

1. Runs `cargo build --release` in `nativelibs/file-utilities`.
2. Copies `target/release/libfile_utilities.so` to
   `app/native/nativelibs/file-utilities/linux_x64/file-utilities.node`.
3. Splices a `case 'linux': return join(__dirname, 'linux_x64', 'file-utilities.node')`
   branch into the auto-generated `getPlatformPath()` in
   `app/native/nativelibs/file-utilities/index.js`, right before its
   `default: throw new Error('Unsupported OS: ...')` — idempotent, fails loud if the
   anchor pattern isn't found (bundle format changed).
4. Verifies the deployed file is a real ELF binary and that `ldd` shows only system
   libraries (`libc`, `libgcc_s`, `libm`, `libpthread`, `libdl`, `librt`,
   `ld-linux*`/`linux-vdso`) — no bundled or unexpected shared-library dependencies.

## N-API / Electron compatibility

Built with `napi = { version = "2", default-features = false, features = ["napi8"] }`
— the `napi8` feature caps the crate at N-API version 8 functions, which is safely
below what any Electron/Node runtime this app targets provides. Electron 39.8.10 (this
repo's current pinned version) ships Node 22-class N-API support at **N-API version
10**, so the `napi8`-gated addon loads without issue; the ABI-stable N-API contract
means the built `.node` does not need to be rebuilt on Electron point-release bumps —
only a Rust source change (or an intentional bump of the `napi8` feature ceiling)
requires a rebuild.
