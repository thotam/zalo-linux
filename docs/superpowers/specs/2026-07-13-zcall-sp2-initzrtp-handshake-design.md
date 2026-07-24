# SP2 step 2.1 — InitZRTP handshake on Linux (design)

**Date:** 2026-07-13
**Parent decisions:**
- [GO verdict — key = requestcall sessId[0:30]](../decisions/2026-07-13-zcall-keying-GO-verdict.md)
- [InitZRTP wire format + SRTP profile (§A/§B)](../decisions/2026-07-13-zcall-initzrtp-and-srtp-profile.md)

**Status:** approved (brainstorming) → ready for writing-plans.

## Goal

Build byte-exact InitZRTP packets per §A, send them to a real VNG relay on `:4200`
using a **live** `sessId` obtained on Linux, and parse the `0x02` reply to extract the
media relay address — proving the handshake works end-to-end against Zalo infra
(operator's own call). No media, no SRTP crypto yet (that is step 2.2).

This is the Linux analog of how SP2 step-1 signaling was proven live: the format is
already fully specified (§A), so the deliverable is an engineering build + a live
validation harness, not more RE.

## Global Constraints

- **Boundary (binding):** operator's own account / own machine / own phone only; own
  traffic only. Per-call `sessId`, relay addresses, and any pcap are **ephemeral secrets**
  — never committed. Committed output is redacted; live artifacts are git-ignored.
- **No `Co-Authored-By` / AI-attribution** in any commit or doc (repo rule).
- **Runtime:** Node.js only (`dgram`, `Buffer`, `crypto.randomBytes`). No native addon, no
  libsrtp — those belong to step 2.2 (media). Consistent with the existing `tools/` layout.
- **Endianness:** little-endian for `fromId`/`toId`/`callId` (§A revises SP1 Appendix C's
  tentative big-endian read). `sessId` is ASCII; `sessId` length field is LE u16 = `9a 00` (154).
- Do **not** reuse `tools/zcall-re/parse-zrtppacket.js` — it is the old SP1 41-byte BE parser
  and does not match the §A 185-byte LE format. Build fresh per §A.

## Wire format (authoritative source: §A of the InitZRTP decision doc)

### PROBE — type `0x01`, subtype `0x03`, 25 bytes (§A.3)
```
off size field                       endian
0   1    type = 0x01                 const
1   1    flag = 0x7e                 const
2   8    reserved (zero)             const
10  4    fromId (caller uid)         LE
14  4    probeNonce (per candidate)  raw (distinct per relay)
18  1    subtype = 0x03              const
19  2    0x00 0x00                   const
21  4    callId                      LE
```

### REQUEST (InitZRTP-with-server) — type `0x01`, subtype `0x0b`, 185 bytes (§A.1)
```
off  size field                      endian
0    1    type = 0x01                const
1    1    flag = 0x7e                const
2    8    reserved (zero)            const
10   4    fromId (caller uid)        LE
14   4    reserved (zero)            const
18   1    subtype = 0x0b             const
19   2    0x00 0x02 (has-sessId)     const
21   4    callId                     LE
25   4    toId (callee uid)          LE
29   2    sessId length = 154        LE u16 (0x009a)
31   154  sessId (ASCII base64url)   -
```
Total = 31-byte header + 154-byte sessId = 185. Sent to **each** candidate relay on `:4200`
(identical payload to all candidates in one call).

### RESPONSE — type `0x02`, ~52–55 bytes (§A.2)
```
off size field                       endian
0   1    type = 0x02                 const
1   1    flag = 0x7e                 const
2   8    reserved (zero)             const
10  4    fromId (echo)               LE
14  4    reserved (zero)             const
18  3    0x0b 0x00 0x02              const
21  4    reserved (zero)             const
25  4    callId (echo)               LE
29  4    probeNonce (echo)           raw (= the matching probe's nonce)
33  2    addrLen                     LE u16
35  N    ASCII "IP|port"             the allocated relay media address
```

## Architecture — 4 new files in `tools/zcall-media/`

### 1. `initzrtp.js` — pure builder/parser (no I/O)
- `buildProbe({ fromId, callId, probeNonce })` → 25-byte `Buffer` per PROBE layout.
  `probeNonce` is a 4-byte `Buffer`. Asserts output length === 25.
- `buildRequest({ fromId, toId, callId, sessId })` → 185-byte `Buffer` per REQUEST layout.
  Fail-loud if `sessId.length !== 154`. Asserts output length === 185.
- `parseResponse(buf)` → `{ type, flag, fromId, callId, probeNonce, relayAddr: { ip, port } }`.
  Reads `addrLen` (LE u16 @33), slices ASCII `@35`, splits on `"|"` → `{ ip, port }`.
  Throws on `type !== 0x02` or truncated buffer.
- Internal helper `writeU32LE(buf, off, v)` and const-byte writers. No network, no crypto beyond
  none (nonce is passed in).

### 2. `handshake.js` — UDP transport (dgram)
- `handshake({ fromId, toId, callId, sessId, servers, timeoutMs = 3000 })` → `Promise<Array>`.
  For each `server` in `servers` (each has an rtp address + `:4200`):
  1. generate `probeNonce = crypto.randomBytes(4)`,
  2. send `buildProbe(...)` then `buildRequest(...)` to `server:4200`,
  3. collect any `0x02` reply, match by `callId`/`probeNonce`.
  Resolves after `timeoutMs` with `[{ server, relayAddr, probeNonce: hex, rttMs }]` for the
  relays that replied. Does **not** throw when some relays stay silent (ICE-like sweep — partial
  replies are normal); a relay with no reply is simply absent from the result. A single shared
  `dgram` socket; closed on resolve.
- `servers` shape comes from the requestcall config (`servers[].rtpaddr` / `rtpIP`); the harness
  normalizes each to `{ host, port: 4200 }`.

### 3. `live-handshake.js` — operator CLI (own call / own phone)
- Reuses `tools/zcall-signaling` (`invokeRequestCall`) to obtain a live config on Linux:
  `{ fromId, toId, callId, sessId, servers }`.
- Feeds it to `handshake()`.
- Prints a **redacted** summary to stdout: `repliedRelays/totalRelays`, the chosen relay addr
  **masked** (e.g. `a.b.c.d|<PORT>` → `***.***.***.***|****` or last-octet-only), and `rttMs`.
  Never prints `sessId` or the raw relay IP. Exits non-zero if zero relays replied.
- `usage: node tools/zcall-media/live-handshake.js [<calleeId>]` (calleeId optional; falls back
  to the signaling tool's existing calleeId resolution).

### 4. `__tests__/initzrtp.test.js` — offline golden-vector tests (in `npm test`)
- `buildProbe`: assert length 25 and byte-exact header (`01 7e`, zeros, fromId LE, nonce, `03`,
  `00 00`, callId LE) for a known input.
- `buildRequest`: assert length 185, `01 7e`, fromId LE @10, `0b` @18, `00 02` @19, callId LE @21,
  toId LE @25, `9a 00` @29, and the ASCII `sessId` @31; assert it throws on a non-154 `sessId`.
- `parseResponse`: build a synthetic §A.2 buffer (`02 7e` … `addrLen` + `"1.2.3.4|5678"`), assert
  it round-trips to `{ relayAddr: { ip: '1.2.3.4', port: '5678' }, callId, probeNonce }`; assert
  it throws on `type !== 0x02`.
- No network. Uses the Node `assert` + `--check` convention already used by
  `tools/zcall-media/__tests__/srtp-decrypt.test.js`.

## Data flow
```
signaling (CDP, Linux)  →  { fromId, toId, callId, sessId, servers[] }
   → buildProbe / buildRequest (LE)  → dgram send → relay:4200
   → recv 0x02  → parseResponse  → relayAddr { ip, port }     ← input to step 2.2 (media)
```

## Handshake ordering (decided)
Per §A the RESPONSE echoes the PROBE's `probeNonce`, so the relay ties its reply to a prior
probe. The harness therefore sends **probe first, then request** to each candidate (the order
observed in the Windows capture) and treats any `0x02` reply carrying the matching `callId` as
success. If a relay replies to the request without a matching nonce, the reply is still accepted
(nonce match is best-effort, not required for success).

## Error handling
- `buildRequest` throws on `sessId.length !== 154` (fail-loud — a wrong-length token would produce
  a malformed packet the relay silently drops).
- `parseResponse` throws on `type !== 0x02` or a buffer too short for `addrLen`.
- `handshake` never rejects on partial replies; it resolves with whatever replied within
  `timeoutMs`. `live-handshake.js` exits non-zero only if **zero** relays replied (a real failure).
- Socket errors bubble up as a rejected `handshake` promise.

## Testing strategy
- **Offline (CI):** `__tests__/initzrtp.test.js` golden vectors — deterministic, no network,
  runs in `npm test`.
- **Live (operator, manual):** `live-handshake.js` — run once against the operator's own call;
  success = ≥1 relay returns a `0x02` with a media address. Not in CI (needs a real account/call).
  Record the redacted result (relaysReplied, rtt) in the decision doc; never commit the raw addr.

## What this explicitly does NOT cover (later steps)
- SRTP protect/unprotect, RTP/opus, the 5-byte zrtc media prefix → step 2.2 (media send/receive).
- Mid-call re-key tracking (§B.3) → step 2.2+.
- Wiring into the app's `$zcall` / native stub → step 4.
- Audio capture/playback (mic/opus/speaker) → step 3.

## Success criteria
1. `npm test` passes with the new golden-vector tests (byte-exact §A build + parse).
2. `live-handshake.js` run against the operator's own call returns ≥1 relay media address from a
   real `0x02` reply, printed redacted.
3. `handshake()` returns a structured `relayAddr` consumable by step 2.2.
