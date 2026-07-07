# db-cross-v4 (native, Linux)

Native addon for Zalo's `native/nativelibs/db-cross-v4`, reimplemented from source for
Linux x64. N-API (`node-addon-api`), so it is ABI-stable across Electron 22.x point
releases.

## What it is / what it's for

Zalo uses `db-cross-v4` to move database blobs **between processes** (main ⇄ workers)
in a compact, obfuscated form. The blob is **AES-256-CBC encrypted** and **XZ/LZMA
compressed**. This addon does the encode/decode of that container so the renderer and
utility processes can exchange DB state.

- Encrypt path: plaintext → AES-256-CBC (`openssl/aes.h`) → XZ compress (`lzma.h`).
- Decrypt path: the reverse.

Correctness here is **interop-by-format**, not byte-identical to a reference image:
as long as our container matches the AES mode/key derivation + XZ framing the other
side expects, the blob round-trips. Reverse-engineered from the macOS binary; the
format (cipher, mode, LZMA options) is fixed by the on-the-wire contract.

## Dependencies

Links **system** libraries (no pinning — these are stable ABIs the distro provides):

- `libcrypto` (OpenSSL) — AES-256-CBC.
- `liblzma` — XZ compression.

Build-time packages: `libssl-dev`, `liblzma-dev` (declared in CI and installed by the
user for local builds).

## Exported native module

`build/Release/db-cross-v4-native.node`. The patch copies it to
`app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node`
(the exact filename Zalo's `dist/binding.js` requires) and splices a `linux` branch
into `binding.js` so the app loads it.

## Build

```bash
# from repo root:
node nativelibs/builder.js nativelibs/db-cross-v4
# → nativelibs/db-cross-v4/build/Release/db-cross-v4-native.node
```

`binding.gyp` links `-lcrypto -llzma`, C++17, N-API exceptions disabled
(`NAPI_DISABLE_CPP_EXCEPTIONS`).

## Use (in the app)

Loaded through Zalo's own `dist/binding.js` wrapper (which we patch with a `linux`
branch). Application code calls the same JS API as on macOS; no separate Linux wrapper.

## Updating when the macOS build changes

`db-cross-v4` links **system** libcrypto/liblzma, so there is normally **nothing to
pin**. Run the drift check on any new Zalo build:

```bash
node nativelibs/scripts/check-native-versions.js
```

`db-cross-v4` links only OS libraries, so it won't appear in the drift report (those
are filtered out). The thing to watch instead is the **container format**: if a new
Zalo version changes the AES key/mode or LZMA options, cross-process blobs will fail to
decode — re-RE the macOS `db-cross-v4-native.node` and update `src/`. This is a
behavioral change, not a version bump, so it won't show up in the version tracker.

## When / how to rebuild

- **Every `npm run setup`** — rebuilt from source automatically.
- **Electron bump** — rebuilt automatically (N-API keeps it ABI-stable, but SETUP
  rebuilds anyway).
- **Edited `src/*.cc`** — `node nativelibs/builder.js nativelibs/db-cross-v4`.
- **System OpenSSL/liblzma ABI change** (rare, major distro upgrade) — rebuild from
  source; no code change unless the container format itself changed.
