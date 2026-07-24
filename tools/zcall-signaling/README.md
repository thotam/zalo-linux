# zcall-signaling — SP2 step 1 (Linux live signaling + keying)

Standalone Node proof that Linux can obtain a real call config + SRTP master key from the
operator's own account. **Own account / own machine / own phone only.** Never commit real
`sessId`/key/cookie values.

**Status: DONE / validated live** — `prototype.js` obtains a real 154-char `sessId`, servers on
`:4200`, `changeZRTP.enable=0`, and derives the 30-byte SRTP master key (`sessId[0:30]`).

## How it works
On Linux the JS `requestCall` never fires by itself (it's triggered by a native-engine signal
that the stubbed engine never sends), and rebuilding the request standalone would have to
reproduce the per-request common-params signing. So instead we **invoke the app's own
`requestCall` via CDP**: reach the webpack module registry (webpack-4 `webpackJsonp` require
grab), find the module exporting `requestCall`, and call
`requestCall(calleeId, callId, "[]", 1)` — reusing the app's auth, zpw signing, and zpw decode.
The return value is the already-decoded call config. `srtpMasterKey = sessId[0:30]`.

## 1. Launch Zalo Linux with remote debugging
    ZALO_REMOTE_DEBUG=1 /opt/Zalo/com.zalo.linux &
`--remote-debugging-port` is rejected by the app's CLI-args fuse, so remote debugging is
enabled from inside the main process (gated by `ZALO_REMOTE_DEBUG`, added by
`scripts/patches/data/call-diag.js`). Verify: `curl http://127.0.0.1:9222/json` lists targets.

## 2. Provide a callee (your own phone's Zalo uid)
Either pass it explicitly, or click call once in Zalo so the diag log records a `makeCall`
intent (the prototype reads the latest one from `~/zalo-call-diag.log`).

## 3. Run (Node 22+ for global WebSocket/fetch)
    node tools/zcall-signaling/prototype.js [calleeId]
This fires ONE real requestcall (your own phone rings) and prints a redacted summary:
    { "sessIdLen": 154, "keyLen": 30, "servers": ["<ip>:4200", …], "changeZRTP": {"enable":0}, ... }

`sessIdLen 154` + `keyLen 30` + `servers :4200` + `changeZRTP.enable 0` = success. Feeds SP2
step 2 (media: libsrtp + RTP/UDP `:4200` + InitZRTP).

## Modules
- `zpw.js` — AES-128-CBC/IV0 zpw codec (encode/decode). Standalone-decode path; unit-tested.
- `requestcall.js` — `parseConfig`, `srtpMasterKey(sessId)=sessId[0:30]`, `buildRequestUrl`. Unit-tested.
- `cdp-invoke.js` — the live path: `buildInvokeExpr` + `invokeRequestCall` (webpack invoke). Unit-tested (pure part).
- `cdp-extract.js` — CDP secretKey/cookie extraction (breakpoint on getSecretKey). Kept for a
  future no-CDP standalone build; not used by the current invoke path. Unit-tested (pure part).
- `prototype.js` — orchestrator (`latestCalleeId`, `summarize`, `main`).

## Tests
    for t in tools/zcall-signaling/__tests__/*.test.js; do node "$t"; done
