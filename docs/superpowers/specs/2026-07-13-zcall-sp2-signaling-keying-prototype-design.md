# zcall SP2 — signaling + keying prototype (Linux, live) — design

**Date:** 2026-07-13
**Status:** design approved; pre-implementation
**Parent:** [GO verdict (SP2.1 Windows RE)](../decisions/2026-07-13-zcall-keying-GO-verdict.md)
· [SP1 ZRTC protocol RE](2026-07-11-zcall-sp1-zrtc-protocol-re.md)
**This is step 1 of the GO roadmap §6** (signaling + keying). Media engine (§6.3), InitZRTP
UDP, and SRTP media are later steps.

## Context

The GO verdict established the full keying recipe, confirmed by real Windows calls:

- `requestcall` is fetched at the **JS layer**; its response `data` is **zpw**-encrypted
  (AES-128-CBC, IV = 16 zero bytes, PKCS7, key = `Base64.decode(secretKey)`), where
  `secretKey` is the runtime zpw session key (`getSecretKey()` / module var `le`).
- Decrypted config yields `sessId` (154-char base64url), `servers` (relays, `:4200`),
  `zrtc_config` (codec tuning, **no keys**), `changeZRTP.enable = 0` (no DH).
- **SRTP master key = `sessId[0:30]`** (16-byte AES-128 key + 14-byte salt) → standard
  libsrtp / RFC 3711 KDF. No DH, no server-held secret, no attestation.

The Linux build runs the **same webpack bundles** (symbols confirmed present:
`getSecretKey`×5, `requestcall`×4, `encodeAES`×329, `createEncryptKey`×8, `zcid_ext`×6), so
Linux can fetch + decrypt the same config. What is missing is a Linux consumer of that config.
This step builds the first piece: a **standalone Node program on Linux that obtains a real
`sessId` + config and derives the SRTP master key**, proving Linux can get config+key
independent of any native UI.

## Objective & scope boundary

**Objective:** `node tools/zcall-signaling/prototype.js` on Linux performs a **live**
`requestcall` (operator's own account → operator's own phone), decrypts the zpw response,
parses the config, and derives `srtpMasterKey = sessId[0:30]` — printing a redacted summary.

**In scope:**
- zpw crypto (encode params, decode response).
- CDP auth extraction: `secretKey` (breakpoint on `getSecretKey`), session cookies
  (`Network.getCookies`), `imei`/`fromId` (`Runtime.evaluate`).
- Building + sending the live `GET /api/voicecall/requestcall`, decrypt, parse, derive key.
- Enabling remote debugging on the Linux Zalo build (Electron fuse / launch flag).

**Out of scope (YAGNI — later steps):** the media engine (libsrtp / RTP / UDP loop); the
InitZRTP UDP token exchange; decrypting SRTP media; deriving `secretKey` from `zcid`/`zcid_ext`
(this step uses the CDP-extracted `secretKey`); the full call lifecycle
(`request`/`answer`/`answerack`/`ringring`/`endcall`).

## ToS / safety boundary (binding)

Own account, own machine, own traffic only; call is operator → operator's **own phone**;
minimum number of requests; the program replicates exactly what the app itself does with the
operator's own login. Per-call `sessId`/keys/cookies are **ephemeral secrets** — never printed
raw, never committed; all committed samples/vectors are redacted (real values → placeholders).

## Architecture & components

New directory `tools/zcall-signaling/` (the reusable signaling building block, distinct from
the RE tools in `tools/zcall-re/`). One responsibility per file, each independently testable.

- **`zpw.js`** — `encode(obj, secretKey): string` / `decode(cipherB64, secretKey): object`.
  AES-128-CBC, IV = 16 zero bytes, PKCS7; key = `Base64.decode(secretKey)`. Pure; golden-vector
  unit test.
- **`requestcall.js`** — `buildParams({calleeId, callId, codec, typeRequest, imei}): object`;
  `parseConfig(plain): {sessId, servers, zrtc_config, changeZRTP, rtpIP, rtcpIP, ...}`;
  `srtpMasterKey(sessId): Buffer` = the first 30 bytes of `sessId` (16 key + 14 salt). Pure
  parse + keying; golden-vector unit test.
- **`cdp-extract.js`** — CDP client over Node's global `WebSocket` to `ws://127.0.0.1:9222`:
  `Debugger` breakpoint on `getSecretKey` → read `le` = **secretKey**; `Network.getCookies`
  for the voicecall host; `Runtime.evaluate` for `imei` / `fromId`. Returns
  `{ secretKey, cookies, imei, fromId }`. Live; validated by a real run.
- **`prototype.js`** — orchestrator: extract auth → `buildParams` + `zpw.encode` → live
  `GET requestcall` (with cookies) → `zpw.decode` → `parseConfig` → `srtpMasterKey` → print a
  **redacted** summary (sessId length, key length, servers, `changeZRTP.enable`).
- **Remote-debug enablement** — a documented step / small patch to launch Zalo Linux with
  `--remote-debugging-port=9222 --remote-allow-origins=*` (via the Electron fuse
  `EnableNodeCliInspectArguments` or a launch flag). Not a shipping change.

### Data flow

```
Zalo Linux (--remote-debugging-port=9222)
   │ CDP: breakpoint getSecretKey→secretKey; Network.getCookies; evaluate imei/fromId
   ▼
prototype.js ─ buildParams + zpw.encode ─▶ GET voicecall/requestcall (live, cookies)  [rings own phone]
   ◀─ zpw ciphertext ─ zpw.decode ─▶ parseConfig ─▶ sessId, servers ─▶ srtpMasterKey = sessId[0:30]
```

### Bootstrap the exact request shape

Before self-constructing a request, use CDP `Network` to capture **one** real `requestcall`
the app emits (operator clicks call once): read the exact URL, `zpw_ver` / `zpw_type`, and the
params field names (decrypt the params with the extracted `secretKey`). Align `buildParams`
to that shape, then self-send. This removes guesswork about param field names.

### Error handling

- CDP attach fails (fuse off / port closed) → clear message that remote debugging must be
  enabled, with the exact launch command.
- `requestcall` non-200 or zpw decode failure → dump status + redacted head, fail loud.
- Missing / non-154-char `sessId` → fail loud (the pipeline is wrong; do not derive a key).

## Testing

- **`zpw.js`, `requestcall.js`:** pure functions, `assert`-based golden-vector unit tests
  (vectors are redacted samples derived from the Windows capture; the `sessId[0:30]` keying
  vector reproduces the verdict's confirmed `key == sessId[0:30]`).
- **`cdp-extract.js`, `prototype.js`:** live; validated by one real run — the operator's phone
  rings and the program prints a valid config (sessId length 154, servers `:4200`,
  `changeZRTP.enable = 0`) and a 30-byte `srtpMasterKey`.

## Success criteria

Running `node tools/zcall-signaling/prototype.js` on Linux makes the operator's phone ring and
prints a valid decrypted config plus a 30-byte SRTP master key — proving a standalone Linux
program can obtain the real call config + keying from the operator's own account. That
unblocks step 2 (media engine): the config + `sessId[0:30]` are exactly what a libsrtp + RTP/UDP
loop needs.

## Out of scope (YAGNI)

Media (libsrtp/RTP/UDP/opus); InitZRTP UDP; SRTP media decrypt/verify; `secretKey` derivation
from `zcid`/`zcid_ext`; full call lifecycle; anything touching another account or another
user's traffic.
