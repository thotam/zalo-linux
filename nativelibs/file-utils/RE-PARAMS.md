# file-utils — RE evidence (parameters & offsets)

Source of truth for the byte-identical reimplementation. All values below were
recovered from `app/native/nativelibs/file-utils/darwin/file-utils.node` (Mach-O
x86_64, `node-addon-api`) via a custom Mach-O parser + Capstone disassembly — not
guessed.

## Binary identity

- Original source: `../disk_usage/diskusage_posix.cpp`
- Toolchain: `/Users/dnyc/Desktop/native/node_modules/node-addon-api/napi.h` (node-addon-api)
- Exported JS function: `getDiskUsage` (bound to `RunFetchDiskUsage`)
- Symbols: `initAll`, `GetDiskUsage::Init`, `__Z17RunFetchDiskUsageRKN4Napi12CallbackInfoE`,
  `__Z14FetchDiskUsagePKc`, `Utils::convertNapiStringToWCharA`, `Errors::Error(std::string)`

## `FetchDiskUsage(const char* path)` — the arithmetic

`statvfs(path, &buf)` into a stack buffer, `test eax,eax; jne <err>` on failure.
On success (macOS `struct statvfs`, LP64):

| stack (rbp-relative) | struct offset | field | width | role |
|---|---|---|---|---|
| `[rbp-0x48]` | 0x08 | `f_frsize` | qword (u64) | multiplier `rcx` |
| `[rbp-0x40]` | 0x10 | `f_blocks` | dword (u32) | × frsize → slot2 |
| `[rbp-0x3c]` | 0x14 | `f_bfree`  | dword (u32) | × frsize → slot1 |
| `[rbp-0x38]` | 0x18 | `f_bavail` | dword (u32) | × frsize → slot0 |

```
imul rax, rcx           ; each block count * f_frsize
mov [rbx+0x00], rax     ; slot0 = f_bavail * f_frsize
mov [rbx+0x08], rax     ; slot1 = f_bfree  * f_frsize
mov [rbx+0x10], rax     ; slot2 = f_blocks * f_frsize
```

## `RunFetchDiskUsage` — validation, object build, catch dispatch

- `info.Length() == 0` → throw code `DISKUSAGE_WRONG_NUMBER_OF_ARGS`
- arg[0] null / not string → throw `DISKUSAGE_INVALID_ARG_TYPE` +
  msg `:  The "path" argument must be one of type string`
- success path sets properties in order via `Object::Set`:
  - `"available"` ← slot0
  - `"free"`      ← slot1
  - `"total"`     ← slot2
  - each wrapped as `napi_create_double`
- C++ catch dispatch (`__cxa` type compare):
  - type 3 → `DISKUSAGE_RUNTIME_ERROR: ` + `what()`  (statvfs fail → `what()="Get diskusage failed"`)
  - type 2 → `DISKUSAGE_EXCEPTION_ERROR: ` + `what()`
  - `...`  → `DISKUSAGE_UNKNOW_EXCEPTION`

## Dead / out of scope

- `DISKUSAGE_INVALID_CALLBACK` — string present, no reachable code path (no `AsyncWorker`,
  no callback arg). Not implemented.
- Windows path uses `convertNapiStringToWCharA` (UTF-16→wchar); POSIX/Linux uses
  `Utf8Value` → `statvfs`.

## Verification

`__tests__/diskusage.test.js` compiles a C `statvfs` oracle (same gcc) and asserts
`total == f_blocks*f_frsize` (strict) plus `free`/`available` within a live-FS drift
slack, for cwd, `/`, tmpdir, homedir. Error strings asserted exact.
