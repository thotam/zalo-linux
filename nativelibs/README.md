# nativelibs — Linux native modules for Zalo

Zalo's desktop app ships a set of native addons under `native/nativelibs/` (in the app
bundle). On macOS these are prebuilt `.node`/`.dylib` files; there is **no Linux build**
in the official package. This directory holds our **from-source Linux replacements**,
each reverse-engineered from the shipped macOS binary so the Linux build behaves — and
where it matters, produces byte-identical output — like the original.

Everything here is built fresh during `npm run setup` (see `scripts/main.js`); nothing
prebuilt is committed. The extracted macOS binaries live under `app/native/nativelibs/`
(gitignored) and are used only as the reverse-engineering reference.

## Modules

| Module | What it does | Tech (Linux) | Third-party libs | Byte-identical target | Patch |
|---|---|---|---|---|---|
| [`zjxl`](zjxl/) | JPEG-XL codec (decode→JPEG, encode, resize, batch) — **chat images** | N-API, libjxl/OpenCV/turbojpeg | libjxl 0.9.3, libjpeg-turbo 3.1.1, OpenCV 4.12, hwy 1.0.7, brotli 1.0.9 (all pinned, from source) | **yes** (image bytes) | `patch-zjxl.js` |
| [`db-cross-v4`](db-cross-v4/) | Cross-process encrypted DB blob (AES-256-CBC + XZ) | N-API (node-addon-api) | system `libcrypto`, `liblzma` | n/a (interop by format) | `patch-db-cross-v4.js` |
| [`zfile`](zfile/) | Disk/volume info (free space, mount points) | N-API (node-addon-api) | glibc (`statvfs`, `getmntent_r`) | n/a | `patch-zfile.js` |
| [`v8-profiles`](v8-profiles/) | V8 CPU profiler | raw V8 `CpuProfiler` (NAN) | none (V8/Electron) | shape byte-for-byte | `patch-v8-profiles.js` |
| `sqlite3` | SQLCipher-encrypted message DB | node-sqlite3 + system SQLCipher | system `libsqlcipher` | n/a | `patch-sqlite3.js` |

Modules still stubbed / not yet RE'd (guarded so the app runs): `zimage` (libvips
thumbnails), `mp4thumb` (video thumbnails), `zwalker` (cache GC), `file-utils` /
`file-utilities` (disk stats), `zcall` (voice/video). See `docs/RE-ROADMAP.md`.

## How the build works

`builder.js` is the shared node-gyp driver. It reads the Electron version from the root
`package.json` and builds a module's `binding.gyp` against the matching Electron headers:

```bash
# from repo root — build one module:
node nativelibs/builder.js nativelibs/<module>
# → produces nativelibs/<module>/build/Release/<name>.node
```

Each module's `patch-*.js` (in `scripts/patches/`) calls `builder.js`, copies the
resulting `.node` (and, for `zjxl`, the bundled `.so` set) into the extracted
`app/native/nativelibs/<module>/`, and splices a `linux` branch into that module's
runtime loader so the app loads our build on Linux. Patches are **fail-loud** (they
throw if the upstream file format drifts) and **idempotent**.

- **N-API modules** (`zjxl`, `db-cross-v4`, `zfile`) are ABI-stable: one build runs on
  any Electron 22.x point release.
- **Raw-V8 modules** (`v8-profiles`) are tied to the exact Electron/V8 ABI and must be
  rebuilt when Electron changes.

## Library-version tracking — the drift detector

Byte-identical / ABI-correct output depends on building against the **same library
versions** the macOS bundle ships. If a new Zalo build bumps a library (e.g. libjxl or
libjpeg-turbo), our pins must follow or output silently diverges.

`scripts/check-native-versions.js` reads the real versions out of the extracted macOS
Mach-O binaries (bundled `.dylib` versions + the libraries each `.node` links) and diffs
them against the committed baseline `expected-versions.json`.

```bash
# report drift vs the baseline (exit 1 on drift — use in CI):
node nativelibs/scripts/check-native-versions.js

# refresh the baseline after you've reviewed & accepted a new Zalo version:
node nativelibs/scripts/check-native-versions.js --update
```

It runs automatically (non-fatally) during `npm run setup` and prints a `DRIFT
DETECTED` banner if the extracted app differs from the baseline. It also cross-checks
`zjxl`'s build pins (`zjxl/scripts/deps-hash.js`) against the mac bundle.

> Note: `libturbojpeg`'s Mach-O version field is the *TurboJPEG API* version (e.g.
> `0.4.0`), **not** the libjpeg-turbo release. The detector reads the embedded
> `"libjpeg-turbo version X.Y.Z"` string instead — don't "fix" that back to LC_ID.

## When Zalo ships a new build — the update workflow

1. Put the new DMG in place and run `npm run setup`. Watch the **"Checking native
   library versions"** step.
2. **No drift** → nothing to do; the existing pins still match. Rebuild is automatic
   (SETUP always rebuilds the addons from source; heavy deps are cached — see below).
3. **Drift reported** → for each changed library:
   - Update the pin. For `zjxl`: edit `PINS` in `zjxl/scripts/deps-hash.js` to the new
     version (the MAC column of the drift report). For system-linked modules
     (`db-cross-v4`, `zfile`, `sqlite3`) there's usually nothing to pin — they link
     whatever the distro provides.
   - If an **encoder/decoder** library changed (`libjxl`, `libjpeg-turbo`), re-verify
     `zjxl/RE-PARAMS.md` — the RE'd constants (enum ordinals, params) can shift between
     versions. Re-disassemble the new macOS `jxl.node` if needed.
   - Re-run `npm run setup` (a changed `zjxl` pin changes the deps-prefix hash → the
     deps rebuild from source automatically; ~20–40 min once).
   - Once verified, refresh the baseline: `node nativelibs/scripts/check-native-versions.js --update`, and commit `expected-versions.json` (+ any pin/RE-PARAMS changes).

## When to rebuild

| Situation | Rebuild what | How |
|---|---|---|
| Every `npm run setup` | All addons (`.node`) — from source | automatic |
| Electron version bump (root `package.json`) | All addons, esp. raw-V8 `v8-profiles` | automatic on next SETUP |
| Zalo bumped a pinned lib (drift) | The affected module + its deps | update pin → `npm run setup` |
| Edited a module's C/C++ source | That module | `node nativelibs/builder.js nativelibs/<module>` |
| Changed a `zjxl` pin / build flag | zjxl deps prefix (content-addressed) | `bash nativelibs/zjxl/scripts/build-deps.sh` then rebuild addon |

The `zjxl` heavy dependencies (libjxl, OpenCV, …) are built once into a
content-addressed cache `zjxl/.deps-prefix/<hash>/` and reused; only a version/flag
change (which changes `<hash>`) triggers a full from-source rebuild. The addon itself is
always rebuilt (fast). See [`zjxl/README.md`](zjxl/) for details.

## Build-time system requirements

- `build-essential`, `node-gyp` (via `npx`), Electron headers (fetched automatically).
- For `zjxl` only: `cmake nasm ninja-build patchelf git curl` (to build the pinned
  libjxl/OpenCV/… from source). CI installs these in `.github/workflows/build.yml`.
- For `db-cross-v4`: `libssl-dev`, `liblzma-dev`. For `sqlite3`: `libsqlcipher-dev`.
