# Implementation plan — RE file-utils (Linux C++ node-addon-api)

**Spec:** [`docs/superpowers/specs/2026-07-10-file-utils-re-design.md`](../specs/2026-07-10-file-utils-re-design.md)
**Branch:** `re/file-utils`
**Approach:** TDD. Small addon (single sync function `getDiskUsage`), so few tasks —
but each is test-first, byte-identical-verified against a `statvfs` oracle.

Model files (already in repo): `nativelibs/zfile/{binding.gyp,package.json,src/zfile.cc}`,
`nativelibs/builder.js`, `scripts/patches/patch-zfile.js`.

---

## Task 0 — Scaffold `nativelibs/file-utils/` (no logic yet)

**Files:** `binding.gyp`, `package.json`.
- `package.json`: name `file-utils-linux`, private, `"build": "node-gyp configure build"`,
  dep `node-addon-api@^5.0.0`.
- `binding.gyp`: target `file-utils-native`, `sources: ["src/diskusage_posix.cc"]`,
  include_dirs/dependencies from `node-addon-api`, `cflags_cc: ["-std=c++17","-O2"]`.
  **C++ exceptions ON** — do NOT define `NAPI_DISABLE_CPP_EXCEPTIONS`, do NOT add
  `-fno-exceptions` (the mac addon uses try/catch → `DISKUSAGE_EXCEPTION_ERROR`).
**Done when:** `node nativelibs/builder.js nativelibs/file-utils` builds an empty-but-valid
addon (a stub `InitAll` returning `exports`). Verify a `.node` appears in `build/Release`.

## Task 1 — `load-addon.js` test helper + failing shape test

**Files:** `__tests__/load-addon.js`, `__tests__/diskusage.test.js` (RED).
- `load-addon.js`: resolves and requires `build/Release/file-utils-native.node`.
- First test (RED): `typeof addon.getDiskUsage === 'function'`; calling it on
  `process.cwd()` returns an object with keys `['available','free','total']`, all finite
  numbers. Fails against the Task-0 stub (no `getDiskUsage`).
**Done when:** test file runs and fails for the right reason (missing function).

## Task 2 — Implement `getDiskUsage` happy path (GREEN)

**File:** `src/diskusage_posix.cc`.
- `RunFetchDiskUsage`: read `info[0]` as string (`Utf8Value`), `statvfs`, build object
  with property order **available, free, total**, values
  `(double)((uint64_t)field * buf.f_frsize)` per spec §2.2.
- `NODE_API_MODULE(file_utils, InitAll)` exporting `getDiskUsage`.
**Done when:** Task-1 shape test passes; `getDiskUsage(process.cwd())` returns sane values
(cross-check magnitude against `df -B1 .` by eye in the test log).

## Task 3 — Byte-identical `statvfs` oracle test

**File:** `__tests__/diskusage.test.js` (extend).
- Oracle: compile a tiny C program at test time (same gcc) that prints
  `f_frsize f_blocks f_bfree f_bavail` for an argv path — OR read `/bin/df`/`stat -f`.
  Preferred: the C oracle (exact syscall parity, host-independent).
- For paths `[process.cwd(), '/', os.tmpdir(), os.homedir()]`: assert
  `addon.total === blocks*frsize`, `addon.free === bfree*frsize`,
  `addon.available === bavail*frsize`. Snapshot oracle+addon close together so a busy FS
  doesn't drift `free/available` between reads (or assert `total` strictly and
  free/available within one `f_frsize`).
**Done when:** all paths match the oracle exactly for `total` (and free/available modulo
concurrent writes).

## Task 4 — Error contract (RED→GREEN)

**Files:** test + `src/diskusage_posix.cc`.
- Tests (`assert.throws` on `err.message`):
  - no args → `DISKUSAGE_WRONG_NUMBER_OF_ARGS`
  - `getDiskUsage(123)` → `DISKUSAGE_INVALID_ARG_TYPE:  The "path" argument must be one of type string` (exact, **double space**)
  - `getDiskUsage('/nonexistent/xyzzy')` → `DISKUSAGE_RUNTIME_ERROR: Get diskusage failed`
- Implement the three throw sites; wrap the statvfs+build in
  `try{...}catch(std::exception&e){throw Napi::Error::New(env,std::string("DISKUSAGE_EXCEPTION_ERROR: ")+e.what());}catch(...){throw Napi::Error::New(env,"DISKUSAGE_UNKNOW_EXCEPTION");}`
  for mac parity (spec §2.3, §7).
**Done when:** all error tests pass with exact message strings.

## Task 5 — `patch-file-utils.js` (build + deploy + splice + gate)

**File:** `scripts/patches/patch-file-utils.js` (model: `patch-zfile.js`).
- Build via `nativelibs/builder.js`; copy `build/Release/*.node` →
  `app/native/nativelibs/file-utils/linux/file-utils-native.node`.
- Splice a `linux` branch into `app/native/nativelibs/file-utils/index.js`:
  match `else { return {error: 'not support'}; }` and insert
  `else if (process.platform === 'linux') { return require('./linux/file-utils-native.node'); }`
  before it. Idempotent (skip if `process.platform === 'linux'` already present).
- **Post-conditions (fail loud):** ELF magic on the `.node`; `ldd` shows only base
  system libs (libc, libstdc++, libgcc_s, ld-linux) — reject anything else; linux branch
  present after splice.
**Done when:** running the patch on a clean extract wires Linux; re-running is a no-op;
`require(app .../file-utils/index.js).getDiskUsage(process.cwd())` returns the object.

## Task 6 — Register in pipeline + CI

- `scripts/main.js`: add `await require('./patches/patch-file-utils.js').main();` right
  after `patch-file-utilities`.
- No `build.yml` change needed (C++/node-gyp toolchain already present for zfile/sqlite3).
  Confirm by grepping the workflow for the existing native-build steps.
**Done when:** full `SETUP=true` dry-run applies the patch in order without error.

## Task 7 — Docs + README + RE-PARAMS

**Files:** `nativelibs/file-utils/README.md`, `nativelibs/file-utils/RE-PARAMS.md`,
`nativelibs/README.md`, `docs/RE-ROADMAP.md`.
- README: what it is, the byte-identical formula, build/test commands, residuals.
- RE-PARAMS: symbol/offset evidence table (statvfs offsets, f_frsize multiplier, property
  order, error strings) — condensed from spec §2.
- Roadmap: mark `file-utils` ✅ DONE (was "next RE candidate").
**Done when:** docs accurate, cross-linked to spec.

## Task 8 — Whole-branch review + build the `.deb`

- Run the full `npm run setup` (or `SETUP=true node scripts/main.js`) end-to-end;
  confirm `file-utils-native.node` lands in the packaged app and `ldd` is clean.
- Optionally build `dist/*.deb` and confirm the addon is inside.
- Final review pass (spec conformance + code quality).
**Done when:** clean build, addon present, all tests green.

## Task 9 (optional) — GUI runtime verification on `verify-native-libs-e39`

- Sync the verify branch with `main` (after merge), run `npm start`, open Data
  Management/Storage, and confirm the logging harness shows
  `file-utils LOAD → {getDiskUsage:fn}` + `CALL getDiskUsage → RET {available,free,total}`
  (previously `{error:"not support"}`).
- Flip the `file-utils` row in `docs/RE-VERIFY-E39.md` to ✅ and update memory
  (`re-libs-e39-runtime-verified`).
**Done when:** GUI log proves the app calls the real Linux addon.

---

## Verification checklist (byte-identical output)

- [ ] `total === f_blocks * f_frsize` for cwd, `/`, tmpdir, homedir (vs C oracle)
- [ ] `free === f_bfree * f_frsize`, `available === f_bavail * f_frsize`
- [ ] property order `available, free, total`; all finite numbers
- [ ] error messages exact (incl. `INVALID_ARG_TYPE` double space)
- [ ] `ldd` on `.node` = base system libs only; ELF magic present
- [ ] patch idempotent; linux branch spliced; app-level call returns object
- [ ] (verify branch) GUI log flips `file-utils` to ✅

## Notes / risks

- **f_frsize vs f_bsize:** settled = `f_frsize` (disassembly register trace). Do not
  second-guess.
- **Exceptions must be ON** in `binding.gyp` (unlike zfile) or `EXCEPTION_ERROR` parity
  is lost. Double-check the built addon actually throws (Task 4 covers this).
- **free/available drift:** a live FS can change between the addon call and the oracle
  call — assert `total` strictly; for free/available, read oracle+addon back-to-back or
  tolerate ≤ one `f_frsize` delta.
- **Do NOT** touch `file-utilities` (the other, already-merged addon).
