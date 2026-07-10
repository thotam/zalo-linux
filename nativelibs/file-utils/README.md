# file-utils (Linux) — `getDiskUsage`

Linux reimplementation of Zalo's `file-utils` native addon. **Distinct** from
`file-utilities` (Rust napi-rs, directory sizing) — this one is the older **C++
node-addon-api** addon that exposes exactly one synchronous function:

```ts
getDiskUsage(path: string): { available: number, free: number, total: number }
```

The macOS/Windows binary ships in the app; its Linux branch returns
`{error:'not support'}`, so the Data-Management/Storage screen's disk-space lookup
silently degrades. This rebuild restores it, **byte-identical** to the mac output.

## Byte-identical formula

Reverse-engineered from `darwin/file-utils.node` (Capstone disassembly of
`FetchDiskUsage`, original source `../disk_usage/diskusage_posix.cpp`). A single
`statvfs(path)` call, then:

| JS property | value | note |
|---|---|---|
| `available` | `(uint64_t)f_bavail * f_frsize` | property created 1st |
| `free`      | `(uint64_t)f_bfree  * f_frsize` | 2nd |
| `total`     | `(uint64_t)f_blocks * f_frsize` | 3rd |

Multiplier is **`f_frsize`** (settled from the `imul rax, rcx` register trace, not
`f_bsize`). Values are JS doubles.

## Error contract (exact `.message` strings)

| Condition | message |
|---|---|
| 0 args | `DISKUSAGE_WRONG_NUMBER_OF_ARGS` |
| arg not a string | `DISKUSAGE_INVALID_ARG_TYPE:  The "path" argument must be one of type string` (double space after `:`) |
| `statvfs() != 0` | `DISKUSAGE_RUNTIME_ERROR: Get diskusage failed` |
| `std::exception` | `DISKUSAGE_EXCEPTION_ERROR: <what()>` |
| unknown C++ throw | `DISKUSAGE_UNKNOW_EXCEPTION` |

## Build & test

```bash
node ../builder.js .                                   # node-gyp build (Electron headers)
node __tests__/diskusage.test.js                       # byte-identical vs statvfs oracle
```

The build enables **C++ exceptions** (`binding.gyp`: no `NAPI_DISABLE_CPP_EXCEPTIONS`,
`-fexceptions`) so the try/catch error dispatch matches the mac binary. The addon links
only base system libs (`libc`, `libstdc++`, `libgcc_s`, `libm`, `ld-linux`).

Deployed by `scripts/patches/patch-file-utils.js`:
`app/native/nativelibs/file-utils/linux/file-utils-native.node` + a spliced
`process.platform === 'linux'` branch in `file-utils/index.js`.

## Residuals

- `DISKUSAGE_INVALID_CALLBACK` is a **dead** string in the mac binary (no async/callback
  path) → sync-only, not implemented.
- macOS `fsblkcnt_t` is 32-bit; Linux is 64-bit — our output is byte-identical within
  macOS's representable range and strictly more correct beyond it.
- `linux/x64` only (source is arch-agnostic POSIX; arm64 is a later `--arch=arm64` build).
- Windows/macOS branches untouched.

See [`../../docs/superpowers/specs/2026-07-10-file-utils-re-design.md`](../../docs/superpowers/specs/2026-07-10-file-utils-re-design.md).
