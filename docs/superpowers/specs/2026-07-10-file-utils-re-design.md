# RE file-utils — Linux native addon (C++ node-addon-api)

**Date:** 2026-07-10
**Branch:** `re/file-utils`
**Goal:** Port the macOS/Windows-only `file-utils` native module to Linux (**x64
only** for now) by faithfully rebuilding its C++ `node-addon-api` addon, exposing the
**full API surface** (`getDiskUsage`), with **byte-identical output** verified against
an independent `statvfs` oracle.

> **Scope note:** `file-utils` is a **distinct, older** addon from the already-ported
> `file-utilities` (Rust napi-rs, merged `main` 860448e). `file-utils` provides exactly
> **one** synchronous function, `getDiskUsage(path)`. Only the `linux/x64` binary is
> built/deployed for now; the source stays arch-agnostic (POSIX `statvfs`), so arm64 is a
> later `node-gyp --arch=arm64` away.

---

## 1. Background

`app/native/nativelibs/file-utils/index.js` is a hand-written platform switch:

```js
function getLib(){
  if(process.platform === 'win32'){ /* x64 / ia32 .node */ }
  else if (process.platform === 'darwin'){ /* darwin / darwin-arm .node */ }
  else { return {error: 'not support'}; }   // <-- Linux hits this
}
module.exports = getLib();
```

On Linux `module.exports === {error: 'not support'}` — it has **no** `getDiskUsage`, so
the app's Data-Management/Storage code (`$znode.nativelibs.fileUtils().getDiskUsage(p)`)
catches the `TypeError` and degrades. Verified call-site (renderer + several workers):

```js
let o; try { o = $znode.nativelibs.fileUtils() } catch(e){}
const r = t => { let n,a; try { a = o.getDiskUsage(t) } catch(e){ n=e } return {error:n, result:a} };
// ...later: if (n) log err.message;  n && (n.free = n.available);  return n;
```

So the app calls it **synchronously with one path string**, reads `{total, free,
available}`, then overwrites `free := available`. Aggregator entry
(`app/native/nativelibs/index.js`): `fileUtils: () => require('./file-utils/index.js')`.

This module is **distinct** from `file-utilities` (Rust napi-rs, 11 functions,
directory sizing) — do not confuse them.

---

## 2. What the binary reveals (RE evidence)

`darwin/file-utils.node` is a **Mach-O x86_64 N-API addon** built with
`node-addon-api` (`Napi::`). Toolchain string:
`/Users/dnyc/Desktop/native/node_modules/node-addon-api/napi.h`, source
`../disk_usage/diskusage_posix.cpp`. Reconstructed via a custom Mach-O parser +
Capstone disassembly of `__Z14FetchDiskUsagePKc` and `__Z17RunFetchDiskUsageRKN4Napi12CallbackInfoE`
(not guesswork).

### 2.1 Exported symbols / structure

| Symbol | Meaning |
|---|---|
| `initAll(Napi::Env, Napi::Object)` | module init (registers `getDiskUsage`) |
| `GetDiskUsage::Init(Napi::Env, Napi::Object)` | class exposing the method |
| `RunFetchDiskUsage(const Napi::CallbackInfo&)` | JS-facing method bound as `getDiskUsage` |
| `FetchDiskUsage(const char* path)` | worker: `statvfs` + arithmetic, returns 3× int64 |
| `Utils::convertNapiStringToWCharA` / `Errors::Error(std::string)` | helpers (WChar path is Windows-only; POSIX uses `Utf8Value`) |

### 2.2 The core arithmetic — **byte-identical formula (confirmed by disassembly)**

`FetchDiskUsage` calls `statvfs(path, &buf)`; on success it computes three `uint64`
products. The macOS `struct statvfs` has `f_frsize` as `unsigned long` (read as a
**64-bit qword**, the multiplier) and `f_blocks/f_bfree/f_bavail` as `fsblkcnt_t =
unsigned int` (read as **32-bit dwords**). Disassembly (`imul rax, rcx` where
`rcx = f_frsize`):

```
result[0] (slot0) = (uint64_t)f_bavail * f_frsize     ; offset 0x18 * 0x08
result[1] (slot1) = (uint64_t)f_bfree  * f_frsize     ; offset 0x14 * 0x08
result[2] (slot2) = (uint64_t)f_blocks * f_frsize     ; offset 0x10 * 0x08
```

The success path (`RunFetchDiskUsage`) then builds the JS object, **property creation
order = `available`, `free`, `total`**, mapping:

| JS property | value | statvfs |
|---|---|---|
| `available` | slot0 | `f_bavail * f_frsize` |
| `free`      | slot1 | `f_bfree  * f_frsize` |
| `total`     | slot2 | `f_blocks * f_frsize` |

Values become JS **doubles** (`napi_create_double`). **Multiplier is `f_frsize`, NOT
`f_bsize`** — settled from the register trace, no ambiguity.

> **Linux fidelity note.** On Linux (`_FILE_OFFSET_BITS=64`) `f_blocks/f_bfree/f_bavail`
> are `unsigned long` (64-bit) and `f_frsize` `unsigned long` — the C++ source
> `(uint64_t)buf.f_bavail * buf.f_frsize` recompiles verbatim and yields the **same**
> product for any disk within macOS's 32-bit block-count range, and is strictly *more*
> correct beyond it. Output is byte-identical for the values each OS can represent.

### 2.3 Error contract (from the catch-dispatch + throw sites)

`RunFetchDiskUsage` validates args, then wraps the work in a C++ `try/catch` that
dispatches on exception type. Extracted strings/messages:

| Condition | Thrown `Error.message` |
|---|---|
| 0 args (`info.Length()==0`) | `DISKUSAGE_WRONG_NUMBER_OF_ARGS` |
| arg not a string | `DISKUSAGE_INVALID_ARG_TYPE:  The "path" argument must be one of type string` |
| `statvfs()` returns non-zero | `DISKUSAGE_RUNTIME_ERROR: Get diskusage failed` |
| `std::exception` thrown | `DISKUSAGE_EXCEPTION_ERROR: <what()>` |
| unknown C++ throw (`...`) | `DISKUSAGE_UNKNOW_EXCEPTION` |

Note the **double space** after the colon in the invalid-arg message (`:  The`). Only
`err.message` is consumed by the app, so message text is the fidelity surface (not the
Error subclass).

`DISKUSAGE_INVALID_CALLBACK` exists as a string constant but appears in **no reachable
code path** in this build (no `AsyncWorker`, no callback arg handling). → **Residual**:
treat `getDiskUsage` as **sync-only, single string arg**; document the dead constant, do
not implement an async/callback overload unless a future build proves one exists.

---

## 3. API contract (full surface)

```ts
// module.exports of the linux .node (via file-utils/index.js linux branch)
getDiskUsage(path: string): { total: number, free: number, available: number }
```

- **Synchronous.** Exactly one argument, must be a string (a filesystem path).
- Returns a plain object with three numeric (double) fields; property insertion order
  `available, free, total` (matches mac; only matters if anything does `Object.keys`).
- Throws `Napi::Error` with the exact `.message` strings in §2.3 on the mapped
  conditions.
- `statvfs` resolves the path's **containing filesystem** (not the path's own size).

**Out of scope / residual:** callback/async form (dead constant), Windows/macOS
branches (untouched), arm64 binary (source ready, not built).

---

## 4. Fidelity target

**Byte-identical OUTPUT + full API.** In scope for byte-identity:
- `{available, free, total}` numeric values == `(uint64)f_bavail|f_bfree|f_blocks *
  f_frsize` cast to double, for the same `statvfs` result.
- Error `.message` strings == §2.3 table exactly (incl. the double space).
- Property names + creation order.

Explicitly **excluded** from byte-identity (physically impossible / host-authored):
- The `.node` binary itself (Mach-O universal → ELF x64).
- Absolute magnitudes differ because they reflect the *host's* real filesystem — we
  verify the **formula**, not a frozen number, against a same-host `statvfs` oracle.

---

## 5. Build approach — C++ `node-addon-api` rebuild

Chosen over a Rust rewrite because the original **is** POSIX C++ (`diskusage_posix.cpp`,
`statvfs`) and recompiles near-verbatim on Linux → maximum fidelity, same syscall, same
toolchain family. The repo already ships the exact machinery (`zfile` is the template).

**Reuse, don't reinvent:**
- `nativelibs/builder.js` — `npm install --ignore-scripts` then
  `npx node-gyp rebuild --target=<electron> --arch=x64 --dist-url=electronjs.org/headers`.
- `node-addon-api@5.1.0` + `node-gyp` already in root `node_modules`.
- `binding.gyp` modeled on `nativelibs/zfile/binding.gyp`.

**Key deviation from zfile's gyp:** `file-utils` **uses C++ exceptions** (try/catch
dispatch → `DISKUSAGE_EXCEPTION_ERROR`/`UNKNOW_EXCEPTION`). zfile defines
`NAPI_DISABLE_CPP_EXCEPTIONS` and strips `-fno-exceptions`; for byte-identical error
behavior we **enable** C++ exceptions:
- Do **not** define `NAPI_DISABLE_CPP_EXCEPTIONS`.
- Keep `"cflags_cc": ["-std=c++17", "-O2"]`, do **not** add the `-fno-exceptions` strips
  (or keep them — they only remove a *disable*; the point is exceptions must be **on**).
- N-API C++ exception mode lets us `throw Napi::Error::New(env, msg)` and `try/catch`.

> The output object values are identical regardless of exception mode; exceptions matter
> only so the *error messages* propagate faithfully. Equivalent non-throwing
> (`ThrowAsJavaScriptException` + early return) is acceptable if it yields identical
> `.message`, but the throwing form mirrors the mac source most directly.

---

## 6. File layout (new)

```
nativelibs/file-utils/
  binding.gyp              # node-addon-api, C++17, exceptions ON, target file-utils-native
  package.json             # name file-utils-linux, build: node-gyp configure build
  src/diskusage_posix.cc   # reconstructed source (getDiskUsage via statvfs)
  __tests__/
    load-addon.js          # require the built .node (build/Release/*.node)
    diskusage.test.js      # byte-identical vs statvfs oracle + error contract
  README.md                # RE notes, formula, residuals
  RE-PARAMS.md             # symbol/offset evidence table (this spec, condensed)
scripts/patches/patch-file-utils.js   # build → copy → splice linux branch → ldd gate
```

Deployed to: `app/native/nativelibs/file-utils/linux/file-utils-native.node`, wired by
splicing a `linux` branch into `app/native/nativelibs/file-utils/index.js`:

```js
} else if (process.platform === 'linux') {
  return require('./linux/file-utils-native.node');
} else {
  return {error: 'not support'};
}
```

(Direct `.node` require — no JS wrapper needed; the addon exports `getDiskUsage`
directly, matching `o.getDiskUsage(p)`.)

---

## 7. The C++ source (reconstructed target)

Shape to implement in `src/diskusage_posix.cc` (illustrative — TDD drives the details):

```cpp
#include <napi.h>
#include <sys/statvfs.h>
#include <string>
#include <cstdint>

static const char* kWrongNumArgs = "DISKUSAGE_WRONG_NUMBER_OF_ARGS";
static const char* kInvalidArg =
    "DISKUSAGE_INVALID_ARG_TYPE:  The \"path\" argument must be one of type string";

Napi::Value RunFetchDiskUsage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() == 0)                  throw Napi::Error::New(env, kWrongNumArgs);
  if (!info[0].IsString())                 throw Napi::Error::New(env, kInvalidArg);
  std::string path = info[0].As<Napi::String>().Utf8Value();

  struct statvfs buf;
  if (statvfs(path.c_str(), &buf) != 0)
    throw Napi::Error::New(env, "DISKUSAGE_RUNTIME_ERROR: Get diskusage failed");

  Napi::Object out = Napi::Object::New(env);
  out.Set("available", Napi::Number::New(env, (double)((uint64_t)buf.f_bavail * buf.f_frsize)));
  out.Set("free",      Napi::Number::New(env, (double)((uint64_t)buf.f_bfree  * buf.f_frsize)));
  out.Set("total",     Napi::Number::New(env, (double)((uint64_t)buf.f_blocks * buf.f_frsize)));
  return out;
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  exports.Set("getDiskUsage", Napi::Function::New(env, RunFetchDiskUsage));
  return exports;
}
NODE_API_MODULE(file_utils, InitAll)
```

> The `EXCEPTION_ERROR`/`UNKNOW_EXCEPTION` catch-all paths mirror the mac binary; since
> `statvfs` + string ops here don't realistically throw `std::exception`, an outer
> `try/catch(std::exception&)/catch(...)` re-throwing as the mapped `Napi::Error` is
> included for exact parity (belt-and-suspenders, matches disassembly).

---

## 8. Verification plan

1. **statvfs oracle (byte-identical).** In `diskusage.test.js`, call the addon on a set
   of real paths (cwd, `/`, `os.tmpdir()`, `os.homedir()`). Independently compute the
   expected values with a tiny oracle: shell `stat -f -c '%b %a %f %S'` /
   `df -B1 --output=...`, **or** a 20-line C oracle compiled at test time, **or** node's
   own — cross-check `f_bavail*f_frsize == available`, etc. Assert equality (allow a
   note that available/free change if the FS is written between the two reads → snapshot
   within the same tick or assert the *formula* by re-deriving from one `statvfs`).
   - Simplest robust oracle: spawn a one-shot C program (compiled via the same gcc) that
     prints `f_frsize f_blocks f_bfree f_bavail` for the path; assert
     `addon.total === blocks*frsize` etc. Host-independent, matches syscall exactly.
2. **Error contract.** `assert.throws` for: no args → message `DISKUSAGE_WRONG_NUMBER_OF_ARGS`;
   number arg → the invalid-arg message (exact, incl. double space); nonexistent path →
   `DISKUSAGE_RUNTIME_ERROR: Get diskusage failed`.
3. **Shape.** `Object.keys(result)` === `['available','free','total']`; all three are
   `number` and finite.
4. **`ldd` gate (in patch).** Built `.node` links only base system libs (libc, libstdc++,
   libgcc_s) — no bundled/exotic deps. ELF magic check.
5. **App-level.** After `patch-file-utils` runs, `require('app/native/nativelibs/file-utils/index.js').getDiskUsage(process.cwd())`
   returns a sane object (matches manual `df`).
6. **GUI runtime (verify branch).** On `verify-native-libs-e39`, the logging harness
   should show `file-utils LOAD → {getDiskUsage:fn}` (no longer `{error:"not support"}`)
   and `CALL getDiskUsage(str) → RET {available,free,total}` on the Storage screen. This
   flips the `file-utils ⚠️` row in `docs/RE-VERIFY-E39.md` to ✅.

---

## 9. Residuals (documented, no code)

1. **`DISKUSAGE_INVALID_CALLBACK`** — dead string; no async/callback form implemented.
2. **arm64** — source is arch-agnostic; only `linux/x64` built now.
3. **Exact `Errors::Error` concatenation** for `EXCEPTION_ERROR`/`UNKNOW_EXCEPTION` — the
   `what()` suffix format is inferred (`"<CODE>: <what>"`); these paths are practically
   unreachable for `statvfs`, so exact-suffix parity is best-effort.
4. **macOS 32-bit `fsblkcnt_t` truncation** — our Linux build uses full 64-bit counts
   (more correct); only diverges from mac on volumes whose block count exceeds 2³², which
   mac itself would misreport.
5. **Windows/macOS branches** untouched.

---

## 10. Integration

- Register `patch-file-utils` in `scripts/main.js` right after `patch-file-utilities`
  (keep the two sibling addons adjacent).
- Add nothing to `.github/workflows/build.yml` — the C++ toolchain (gcc, node-gyp) is
  already present for `zfile`/`sqlite3`/`zjxl`; no Rust needed for this one.
- Update `nativelibs/README.md`, `docs/RE-ROADMAP.md` (file-utils → ✅ DONE),
  `docs/RE-VERIFY-E39.md` (row flip once GUI-verified), and memory
  (`re-libs-e39-runtime-verified`, roadmap).
