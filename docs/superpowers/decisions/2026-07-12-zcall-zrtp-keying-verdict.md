# zcall ZRTP keying — verdict (SP2.0 gate scout)

> ⚠️ **SUPERSEDED 2026-07-13 → GO.** This SP2.0 doc concluded NO-GO-leaning from Linux-side
> JS/IPC evidence only. SP2.1 (real Windows engine RE) **overturns it**: the SRTP key is
> `requestcall.sessId[0:30]`, fully client-reproducible. See
> [2026-07-13 GO verdict](2026-07-13-zcall-keying-GO-verdict.md). Keep this doc for the
> reasoning trail; use the GO verdict for decisions.

**Date:** 2026-07-12
**Scout:** [SP2.0 — ZRTP keying gate scout](../specs/2026-07-12-zcall-sp2-zrtp-keying-gate-scout-design.md)
**Parent gate:** [SP1 §E.5 CONDITIONAL](../specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md)
**Verdict:** **NO-GO for a cheap resolution — do NOT commit SP2–SP6.** SP1 §E.5 CONDITIONAL is refined to lean **NO-GO** (see below).

## What was tested

A real 1-1 audio call was placed from the Linux build to the operator's own second device,
with the diagnostics deb (call-trace payload dumps + main-process CDP Network tap + zcall
stub). All capture was at the JS/IPC/CDP boundary — own account, passive, no TLS MITM.
`node tools/zcall-re/classify-keying.js ~/zalo-call-diag.log` → `{"klass":"d","signals":[]}`.

## Evidence (redacted; real ids/names/avatars withheld — third-party PII)

The `$zcall.sendDataToNative` / `initCall` payloads are **high-level command intent**, not a
`setConfig` / keying blob. Schema of every captured payload (values elided):

```
callMainInit  {type:"update",  command:"init",       data:{local:{id,avatar,name}, osInfo, mainWindowId,
                                                            logPath, zrtcLogPath, dumpPath, clientVersion,
                                                            language, timeoutMakeCall2ZRtp, enablePreviewDevice*,
                                                            autoAudioInput/Output, default*Device, receiveCallWhile*}}
sendToNative  {type:"update",  command:"init"       ...same as above...}
sendToNative  {type:"update",  command:"updateLocal", data:{local:{...}, osInfo, ...}}
sendToNative  {type:"request", command:"makeCall",   data:{partner:[{id,avatar,name}], type:1|3}}   (×N retries)
```

**No `servers`, no `sessId`, no `callId`, no `key`/`salt`/`srtpKey`, no `nonce`, no
`zrtc_config`** appears anywhere in the JS→native channel. The only crypto-adjacent field is
`zrtcLogPath` (a log path), and `timeoutMakeCall2ZRtp` (a timeout) — configuration, not keys.

The CDP Network tap captured **only** `file://` (index.html) and `wpa.chat.zalo.me/api/login/
getServerInfo` (login), both `HTTP-RESP-ERR` (body unavailable). **No `voicecall/requestcall`,
no `action=call_config`** request was ever made through Chromium's network stack.

## What this proves (architecture)

The renderer/worker JS only sends **high-level intent** ("init the engine", "makeCall to
partner X") down to the native engine. Everything that matters for interop — the
`voicecall/requestcall` + `call_config` signaling, server selection, the ZRTP handshake, the
SRTP keying, and the media — is performed **entirely inside the native engine** (`zcall.node`
/ the main-process native sink `N`), over its **own** HTTP/UDP stack (not Chromium's, hence
invisible to the CDP tap). On Linux the native engine is a no-op stub, so **no signaling ever
leaves the machine** — there is nothing to capture at the JS layer, by construction.

## Consequence for the gate

- **Approach A (Linux own-traffic JS-layer capture) is empirically disproven.** The SRTP
  keying never transits the JS/IPC layer, so it cannot be captured on Linux from the app's
  own traffic. This was the cheap, no-Mac, no-ToS-risk path — it is **closed**.
- **Approach B / C2b (stub performs `requestcall` to elicit keying) collapses into SP3.**
  Because keying is established across the native engine's multi-step handshake
  (`call_config` → `requestcall` → server selection → ZRTP over UDP), a stub cannot "elicit
  the keys" with one request — it would have to reimplement the whole native handshake, which
  *is* SP3 (the 3–6+ month, very-high-risk piece). It is not a cheap probe.
- **The remaining paths are the expensive ones SP1 already flagged:** (1) run the real native
  engine on macOS and packet-capture *its* traffic — blocked here by no physical Mac and by
  CI being unable to complete a real answered call; or (2) static crypto RE of the x86_64
  Mach-O binary. Both are large, and neither de-risks cheaply.

## Verdict

**NO-GO for a cheap resolution.** The scout's purpose was to de-risk the ZRTP keying gate
before committing ~7–16+ engineer-months. It found that the only cheap de-risking path is
closed: the keying is fully native-side and unreachable from Linux own-traffic. Answering
"is the keying client-reimplementable?" now requires **committing the expensive, very-high-
risk work (SP3-level native-handshake reimplementation, or a Mac + real-answered-call packet
capture) just to observe the keying** — i.e., you would spend the make-or-break budget to
learn whether the make-or-break is even possible. That is committing on faith, which SP1 §E.5
explicitly warned against.

**Recommendation:** do **not** commit SP2–SP6. Keep the enabler/diagnostic work (the call
button now renders; the chain is fully mapped) as the documented end state. Revisit only if a
macOS device with real-account packet-capture becomes available, or if the goal changes from
"real interop calls" to something the native engine is not required for.

## Updates to SP1 §E.5

SP1 §E.5 (CONDITIONAL) named the gate as "a real-server/peer ZRTP handshake capture to
reverse the crypto." This scout adds the empirical finding that **the capture cannot be done
at the Linux JS/IPC layer at all** — the keying is entirely inside the native engine's own
network activity. The "single cheapest next experiment" (wide-value loopback) remains valid
and is wired (`tools/zcall-re/harness.js` + `.github/workflows/zcall-capture.yml`), but it
only hardens the REQUEST wire format; it does not touch keying. Net: the CONDITIONAL leans
**NO-GO** under the current (no-Mac) constraints.

## Reproduce

See `tools/zcall-re/CAPTURE-SP2.md`. Raw capture stays local (gitignored — contains
third-party PII); the schema above is the committable evidence.
