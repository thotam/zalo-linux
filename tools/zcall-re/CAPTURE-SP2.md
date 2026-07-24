# SP2.0 keying capture runbook

Resolves the SP1 §E.5 gate: **where does Zalo's SRTP/ZRTC keying come from** →
GO / NO-GO on the SP2–SP6 engine build.

**Boundary (binding):** your own account only; passive observation of the app's own
traffic only; no third party; no TLS interception. Captured keys stay local; only a
**redacted** sample goes in the repo.

## 1. Build the diagnostics deb

The call-trace payload dumps (Task 2) and the CDP Network tap (Task 3) are added by
patches wired into `scripts/main.js`. A full re-extract picks them up cleanly:

    SETUP=true BUILD=true node scripts/main.js

(`SETUP=true` re-extracts + re-applies all patches, so the updated `patch-call-trace.js`
and `call-diag.js` land in a fresh app tree — avoids the patch idempotency guard skipping
the upgrade on an already-patched tree.)

## 2. Install + reset the log

    sudo dpkg -i dist/Zalo-*.deb
    rm -f ~/zalo-call-diag.log

## 3. Place a real call to yourself

Launch, log in with **your** account, open a 1-1 chat with **your own** second device /
number. Place a real **audio** call to yourself; let it ring/connect ~20s; hang up.

    zalo

## 4. Classify (offline, pure)

    node tools/zcall-re/classify-keying.js ~/zalo-call-diag.log

Prints `{ klass, signals, rationale }`:
- `a` — server-delivered key material in the signaling/config payload → **GO**
- `b` — server nonce present, client derives via KDF → **GO-ish** (KDF must be reversible)
- `d` — only session/token (or nothing) → keying likely in the media handshake →
  **escalate to spec §C2b** (stub-driven signaling elicitation) or declare inconclusive
- `c` — never auto-assigned; record by hand if evidence shows attestation / anti-tamper → **NO-GO**

Also skim the CDP tap output for the raw server response:

    grep -E 'HTTP-REQ|HTTP-RESP' ~/zalo-call-diag.log

## 5. Prepare a redacted sample for the repo (never commit raw secrets)

    node -e 'const u=require("./tools/zcall-re/capture-utils");const fs=require("fs");const p=u.parsePayloadLines(fs.readFileSync(process.env.HOME+"/zalo-call-diag.log","utf8"));console.log(JSON.stringify(p.map(x=>({tag:x.tag,obj:u.redactSecrets(x.obj)})),null,2))' > tools/zcall-re/sample-keying-redacted.json

## 6. Write the verdict

Record the classifier output + the redacted evidence in
`docs/superpowers/decisions/2026-07-12-zcall-zrtp-keying-verdict.md`, and update SP1 §E.5
to **GO / NO-GO / CONDITIONAL-refined** for SP2–SP6. A clean NO-GO (person-year saved) is
as valuable as a GO.
