# zwalker — Linux RE design

Date: 2026-07-11
Status: DONE (native Rust reconstruction, linux/x64)
Crate: `nativelibs/zwalker/` · Patch: `scripts/patches/patch-zwalker.js`

## Goal

Restore Zalo's media-cache garbage collector on Linux. The mac/Windows `zwalker`
NAPI-RS addon ships no Linux binary; the app ran with an empty stub (installed by
`patch-linux-guards`) so cache was never reclaimed. Reconstruct the full 5-function
addon natively (like `file-utilities`), matching the reverse-engineered contract.

## What zwalker is

A storage GC over the Zalo download directory. It keeps a **process-global file tree in
RAM** (behind a `parking_lot::Mutex`, alive for the `shared-worker` lifetime — the mac
panic strings name it: "Mutex is poisoned … from tree", "Error locking tree"). Flow:

1. `scanDirectory(root, trackingGlobs)` — walk `root`, build the tree (all files
   unmarked), return totals + per-tracking-glob `{file_number,size}` aggregate.
2. `updateReferenceMessageId(root, [{filePath,id}])` — mark each file with the message
   id that references it (keeps it alive). Returns `updateCount`.
3. `statUnmarkedFiles(root, ignore, tracking, [3d,7d,14d])` — report the still-unmarked
   ("homeless") files, per tracking glob and bucketed by access-time age.
4. `deleteHomelessFiles(root, ignore, tracking, delete=true)` — **unlink** homeless files
   (skipping ignore globs); return deleted/failed totals.
5. `deleteEmptyFolders(root)` — remove empty dirs deepest-first.

Homeless ⇒ `reference_message_id == ""` and not matched by an ignore glob.

## Reconstruction approach

- All deps are public crates.io crates (versions leaked by the mac binary) — pin them
  and rebuild only the `zwalker` glue crate, exactly as done for `file-utilities`.
- Structs recovered from serde field-name strings: `FileInfo`(5), `NodeData`(8),
  `FolderBasicInfo`(2). Return objects use napi camelCase (note `tracking_a_time →
  trackingATime`). Full detail in `nativelibs/zwalker/RE-PARAMS.md`.
- Compute the JS-facing aggregates from a flat `Vec<FileInfo>` + path index (O(1)
  marking); keep the literal `NodeData` tree shape as documentation.
- Walk with `ignore::WalkBuilder`, standard filters OFF (media cache ≠ repo).

## Fidelity target

Behaviour reconstruction (no byte-identical oracle exists for a stateful file-deleting
GC). Anchored on the RE'd contract + a full-lifecycle fixture test
(`__tests__/zwalker.test.js`): scan → mark → stat (buckets + ignore) → **real delete**
(homeless removed, marked survive, ignore protects) → empty-folder removal.

## Deploy + integration

- `patch-zwalker.js`: `cargo build --release` → deploy `libzwalker.so` as
  `zwalker.linux-x64-gnu.node` (the slot the addon's own napi loader already probes — no
  `index.js` splice). Gate: ELF + `ldd` system-only + loads and exports all 5 fns.
- **Split from `patch-linux-guards`**: the real addon owns its own load, so linux-guards
  is reduced to codesign-only. `patch-mp4thumb` was likewise re-anchored on the pristine
  bundle so both ported addons are self-contained (linux-guards no longer a prerequisite).

## Safety decision

The `cleanup.enable` feature flag (default OFF, VNG gradual rollout) is **left OFF** — the
addon is loaded and ready, but the app does not run the GC (no cache is deleted) until
Zalo enables it server-side. Deletion is real (per the mac default and user directive),
but only ever runs against its own throwaway fixture in tests. This mirrors the
`mp4thumb` / `gen_video_thumb` split, but here the flag is deliberately **not** forced
because the operation deletes the user's files.
