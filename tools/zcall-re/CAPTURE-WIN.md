# SP2.1 Windows real-handshake capture runbook

Boundary: your own Windows machine, your own account, calling your own phone. TLS decryption
applies only to your own machine's sessions. Captures stay local; commit only redacted samples.

## Prep
1. Install Zalo PC for Windows; log in with YOUR account.
2. Install Wireshark (includes Npcap).
3. (Optional, tier 3) Install mitmproxy; trust its root CA in the Windows cert store.

## Tier 1 — JS-layer instrument (try first, cheapest)
Zalo Windows uses the same webpack bundles as the mac build. If you can apply this repo's
diagnostics patches to the Windows install's `resources/app` (same layout), the
`[CALLDIAG-PAYLOAD]` dumps + CDP HTTP tap will fire. If Windows fetches call_config at the JS
layer, you get the config plaintext with no Wireshark. Then:

    node tools/zcall-re/classify-keying.js <the-diag-log>

If that shows only high-level intent (like Linux), the config is native-only — go to tier 2+.

## Tier 2 — TLS keylog
1. Set the env var, then launch Zalo from the same shell:
   `set SSLKEYLOGFILE=%USERPROFILE%\zalo-tls-keys.log`  (cmd)  — or PowerShell `$env:SSLKEYLOGFILE=...`
2. In Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log filename → that file.
3. Start capture, place a real 1-1 AUDIO call to your own phone (~20s), hang up, stop capture.
4. Filter `http2 or tls` on `voicecall`/`wpa.chat`/`call_config`; if decrypted, follow the
   HTTP streams; export the JSON request/response bodies to `signaling.json` (an array).

## Tier 3 — mitmproxy (if tier 2 didn't decrypt the native traffic)
1. Run mitmproxy; set Windows system proxy to it; ensure its CA is trusted.
2. Place the call. If Zalo does NOT pin certs, mitmproxy shows the `call_config`/`requestcall`
   flows — export the JSON bodies to `signaling.json`.
   If connections fail only with the proxy on, the engine pins certs → tier 3 is blocked; use tier 4.

## Tier 4 — UDP capture (always works)
1. In Wireshark, capture with filter `udp` during the call.
2. Save the ZRTP/RTP packets; export the payload bytes of the first non-media control packets
   (hex) and parse:

    node tools/zcall-re/parse-zrtppacket.js <hex-or-file>

   Compare framing against SP1 Appendix C. A standard DH/nonce exchange → keying may be
   client-reimplementable; an opaque/attested blob → NO-GO.

## Classify + redact
    node tools/zcall-re/classify-keying.js --json signaling.json      # class a/b/c/d
    node -e 'const u=require("./tools/zcall-re/capture-utils");const fs=require("fs");console.log(JSON.stringify(JSON.parse(fs.readFileSync("signaling.json","utf8")).map(u.redactSecrets),null,2))' > tools/zcall-re/sample-win-redacted.json

Send the classifier output + the redacted schema; the verdict doc gets the Windows evidence.
