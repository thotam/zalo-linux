# zcall SP2.0 — ZRTP keying gate scout (design)

**Date:** 2026-07-12
**Status:** design approved; pre-implementation
**Parent:** [zcall SP1 — ZRTC protocol RE + feasibility spike](2026-07-11-zcall-sp1-zrtc-protocol-re.md)
**Supersedes decision:** SP1 §E.5 (CONDITIONAL) — this scout resolves the gate SP1 named.

## Context

SP1 reversed the ZRTC transport framing (Appendix C), mapped the 29-method native API
(Appendix B), and identified the WebRTC fork (Appendix A). It ended **CONDITIONAL**: the
single make-or-break unknown is **the ZRTP key-exchange / SRTP keying** (§E.3 blocker 2).
SP1's own recommendation (§E.5): **do not commit SP2–SP6** (~7–16+ eng-months) until that
gate is scouted, because if the keying is server-attested / anti-tamper / not
client-reimplementable, the entire effort is a **NO-GO** and the person-year is saved.

A separate empirical session (branch `diag/linux-call`, see memory
`linux-call-enable-chain`) established new leverage that changes how cheaply the gate can be
scouted:

- The Linux app already **runs and drives the exact call path** with the user's own
  logged-in account. The full renderer→IPC chain was traced and **fires end-to-end**:
  `header click → _videoCall → j.d.isSupport() → j.d.makeCall → $zcall.sendDataToNative +
  $zcall.initCall` (IPC apiKeys `SEND_TO_NATIVE` / `CALL_INIT`). Only the **native media
  engine** (`zcall.node`, macOS x86_64/ABI-57) is absent on Linux.
- We can **inject a JS stub** for the native engine and **instrument the JS/IPC layer**
  freely. This means the config/keying data the app hands toward native — and the app's own
  HTTP to `voicecall-wpa` / `/zls?action=call_config` — can be captured **in plaintext at
  the JS layer, on Linux, with the user's own account, with no TLS interception and no Mac**.

SP1 recorded that the media is **SRTP-AES-GCM with server-mediated keys (no DH/ECDH
observed)**. If that is literally true — keys delivered by the server over the
signaling/config channel — then the keying is capturable on Linux from the app's own
traffic, and the gate can be resolved cheaply. This scout tests exactly that.

## Objective & scope boundary

**Objective:** produce an **evidence-backed GO/NO-GO** on whether Zalo's SRTP/ZRTC keying is
**client-reimplementable on Linux**, by classifying where the keying material comes from.

**This scout builds nothing shippable.** No WebRTC, no media I/O, no ZRTC transport, no call
state machine, no media decrypt/render. It is capture + analysis + a decision.

**Keying classification (the deliverable answer):**

| Class | Meaning | Verdict implication |
|---|---|---|
| (a) | Server delivers SRTP key material as plaintext over signaling/config | **GO** |
| (b) | Client derives keys from a server-provided nonce via a standard/known KDF | **GO-ish** (KDF must be reversible) |
| (c) | Keys are server-attested / anti-tamper / HW-bound / require the native engine's sealed state | **NO-GO** (saves the person-year) |
| (d) | Inconclusive from own-traffic capture | scout further (escalation / CI-mac) |

## Approach (chosen: A → B, Linux own-traffic first, escalate only if needed)

Under the hard constraint that the only macOS available is a **GitHub Actions runner** (no
physical Mac; a real *answered* call cannot be automated in CI), the decisive capture must
be the app's **own traffic on Linux**, with escalation only if that proves insufficient.

- **A — Linux own-traffic JS-layer capture (primary).** Observe the plaintext the app
  already produces with the user's account. Near-free, no TLS MITM, matches the interop
  boundary.
- **B — Stub-driven signaling elicitation (escalation).** If A shows the stubbed native
  swallows signaling (so the server never responds with keying), extend the Linux zcall stub
  to perform the reversed `voicecall/requestcall` (+ minimal handshake) itself, so the server
  **responds** with real session/keying, captured at the JS layer. Signaling only; no media.
- **C — CI-mac RTP capture (fallback/corroboration only).** Driving the real mac `.node` on
  the runner with `tcpdump` can corroborate media-layer framing, but cannot complete a real
  *answered* handshake in CI, so it is not the primary path.

## Architecture & components

### C1 — Wide-value loopback capture (transport hardening; independent of keying)

Re-run the existing SP1 harness (`tools/zcall-re/harness.js`, `MODE=call`) on the macOS
runner with **`fromId`/`toId`/`callId` all > 255 and each byte distinct**. This reuses
existing tooling, needs no account and no Zalo infrastructure (0 ToS risk), and
**definitively settles the REQUEST endianness / field-widths / offsets** that SP1 Appendix C
flags as TENTATIVE (the small-magnitude sample cannot distinguish big-endian-at-7 from
little-endian-at-10). Output: a locked wire-format note appended to / cross-referenced from
SP1 Appendix C. This is orthogonal to the keying question but hardens the one transport piece
SP3 would build on first, at near-zero cost.

### C2 — Linux own-traffic keying capture (the make-or-break)

Extend the existing main-process call diagnostics (`scripts/patches/data/call-diag.js` +
`patch-call-diagnostics.js`) and/or add a JS-layer HTTP tap to dump, in plaintext, during a
real 1-1 call attempt the user places **to their own phone** on Linux:

1. **The `$zcall.initCall` / `sendDataToNative` payloads** — the `setConfig`-equivalent data
   the app hands toward the native engine (per SP1 Appendix D: `settings`, `servers`,
   `fec.tableLookup`, `changeZRTP`, and crucially any `zrtc_config`). These already **fire**
   on Linux (proven by the `sendToNative` / `callMainInit` trace).
2. **The app's HTTP request+response bodies** to `voicecall-wpa.zalo.me` and
   `/zls?action=call_config` (`getConfigState`) — instrumented at the JS HTTP client
   (XMLHttpRequest/fetch) layer, **not** by intercepting TLS.

**Analysis:** does server-provided data contain SRTP key material, key-derivation inputs, or
a `zrtc_config` carrying crypto parameters? Map the result to class (a)/(b)/(c)/(d).

**Branch on outcome:** if the payloads carry real server keying → analyze → GO/NO-GO. If they
carry only a session/token and the stubbed native never triggers real signaling → escalate to
C2b.

### C2b — Stub-driven signaling elicitation (escalation, only if C2 is starved)

Extend the Linux zcall stub (`patch-zcall-linux-stub.js`) so that, instead of a pure no-op,
it performs the reversed `voicecall/requestcall` (and the minimal follow-on the server needs
to return session/keying), using the app's own account and the API shapes from SP1 Appendix D
+ the C2 captures. The goal is solely to make the **server respond** with the keying-bearing
message so it can be captured at the JS layer. **Signaling only — no media, no key use.**
This is a deliberately minimal, throwaway probe, not the start of SP3's transport.

### C3 — Analysis + GO/NO-GO decision doc

Classify the keying into (a)–(d) with the captured evidence, and update SP1 §E.5 from
CONDITIONAL to **GO / NO-GO / CONDITIONAL-refined** for SP2–SP6. If GO/GO-ish, note what the
engine (SP2/SP3) will need to feed the keying into SRTP. If NO-GO, document the specific
observation that forecloses client reimplementation (this is the person-year-saving output).

## Data flow

```
user clicks call (own account, Linux)
  → app fetches call config (voicecall-wpa / zls)      [C2 tap: HTTP req/resp]
  → app assembles setConfig / initCall payload         [C2 tap: IPC payload]
  → $zcall.initCall / sendDataToNative  ── IPC ──▶ native stub (no-op, or C2b elicitor)
```

All capture points are at the **JS/IPC boundary** — plaintext, no TLS interception.

## ToS / safety boundary (binding)

- **Only the user's own account.** Only **passive observation** of the app's own traffic —
  data the app already sends/receives under the user's own login.
- **No third party**; no attack or probe of Zalo infrastructure beyond what the app itself
  does with the user's account; no decryption of any other user's traffic.
- C2b sends **only what the app itself would send** (`requestcall`), with the user's account —
  it does not forge, replay against other users, or exercise any endpoint the app wouldn't.
- Captured keying material **stays local**, is used only for RE analysis, and is **never
  redistributed**. Any sample committed to the repo must be **redacted** (real ids / keys /
  tokens replaced with placeholders).

## Testing

- **C1:** reuse the existing SP1 harness tests (`tools/zcall-re/__tests__`).
- **C2 / C2b:** unit-test the pure payload parse/dump/redact functions (the pattern already
  used by `scripts/patches/__tests__/call-diag.test.js`). The capture itself is validated by
  a single real run producing structured, redactable logs.

## Deliverables

1. Wide-value loopback capture + a **locked REQUEST wire-format** note (resolves Appendix C
   TENTATIVE items).
2. A **keying-capture instrumentation** patch (C2, and C2b if reached) + one **redacted**
   captured sample.
3. A **GO/NO-GO decision doc** with the keying classification (a)–(d), the supporting
   evidence, and the updated SP1 §E.5 verdict for SP2–SP6.

## Success criteria

We can state, **with evidence**, which keying class (a)–(d) Zalo uses, and therefore whether
SP2–SP6 is **GO / NO-GO**. Success is a *defensible decision*, not a working call. A clean
**NO-GO** (person-year saved) is as valuable an outcome as a GO.

## Out of scope (YAGNI)

Building WebRTC; any Linux media I/O; the ZRTC transport re-implementation; the call state
machine; decrypting or rendering live media; anything touching another user's account or
traffic. Those are SP2–SP6 proper, gated on this scout's GO.
