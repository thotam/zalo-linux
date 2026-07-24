# zcall SP1 — ZRTC Protocol RE + Feasibility Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse Zalo's proprietary ZRTC call protocol + the zcall native API/JSON contracts, identify the bundled WebRTC fork, and produce a documented go/no-go on real Linux voice/video-call interop — without building WebRTC or any Linux media code.

**Architecture:** Hybrid RE. Static pass with radare2/rabin2 on the (non-stripped, 35 209-symbol) `zcall_mac.node` Mach-O, run locally on Linux. Dynamic pass on a GitHub Actions `macos-latest` runner that extracts the real `.node`, drives a controlled `setConfig`+`makeCall` against loopback endpoints we own, and captures the emitted `ZRTPPacket`s (tcpdump) plus the JSON of `getEventMessage`/`getCallInfo`/`getJsonStats406`. Cross-validate: static gives the encode/decode logic, dynamic gives ground-truth bytes.

**Tech Stack:** radare2 (`r2`, `rabin2`, already at `/usr/bin`), Node.js v24 (harness), GitHub Actions macos-latest, tcpdump, the repo's existing `download-installer.js`/`extract-installer.js` to obtain the binary in CI.

## Global Constraints

- **SP1 is analysis-only.** No WebRTC build, no Linux media I/O, no Linux engine implementation, no changes to `app/`, `scripts/main.js`, or any shipping patch. Output is docs + analysis tooling + a go/no-go.
- **Never re-commit the binary.** `zcall_mac.node` lives under the gitignored `app/`. Do not copy it into a tracked path. Captured artifacts (pcap/JSON/symbol dumps) go under `scratch/zcall-analysis/` (gitignored) or are attached as CI artifacts; only distilled findings go into tracked docs.
- **Interop-RE safety.** Only capture packets emitted by a binary we drive, pointed at endpoints we control (loopback). Do not probe/attack Zalo infrastructure. Do not automate real-account login; if a code path needs a token, record it as a blocker instead.
- **No AI attribution** in any commit message, PR, or doc: no `Co-Authored-By`, no "Generated with"/🤖 lines. Commit as the repo user.
- **Deliverable location:** findings append to the spec `docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md`; tooling under `tools/zcall-re/`; the workflow at `.github/workflows/zcall-capture.yml`.
- **Binary under analysis:** `app/native/nativelibs/zcall/zcall_mac.node` — Mach-O x86_64 bundle, clang/objc, 35 209 symbols (NOT stripped). Loaded on darwin via `app/native/nativelibs/zcall/binding.js` → `require('./zcall_mac.node')` → `.MainApp()`.

---

## File Structure

- `tools/zcall-re/README.md` — how to run the SP1 analysis (static + CI).
- `tools/zcall-re/static/harvest.sh` — radare2/rabin2 commands producing symbol/version/method dumps.
- `tools/zcall-re/harness.js` — Node harness: loads `zcall_mac.node`, drives the controlled call, dumps JSON/logs.
- `tools/zcall-re/udp-responder.js` — minimal loopback UDP responder to advance the handshake.
- `tools/zcall-re/parse-zrtppacket.js` — PoC `ZRTPPacket` decoder.
- `tools/zcall-re/__tests__/parse-zrtppacket.test.js` — decodes a real captured packet.
- `.github/workflows/zcall-capture.yml` — macos-latest capture job.
- `scratch/zcall-analysis/` (gitignored) — pcaps, JSON dumps, symbol dumps.
- `docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md` — appended appendices A–E (findings) + the go/no-go.

---

### Task 1: RE workspace + WebRTC/codec identity (static)

**Files:**
- Create: `tools/zcall-re/README.md`
- Create: `tools/zcall-re/static/harvest.sh`
- Create: `.gitignore` entry for `scratch/zcall-analysis/`
- Modify (append Appendix A): `docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md`

**Interfaces:**
- Produces: `scratch/zcall-analysis/symbols.txt` (all symbols), `scratch/zcall-analysis/webrtc-version.txt`, and Appendix A "WebRTC identity + codec inventory" in the spec.

- [ ] **Step 1: Scaffold the workspace**

Create `tools/zcall-re/README.md` describing the two passes (static local, dynamic CI) and the constraint that the binary is never re-committed. Add `scratch/zcall-analysis/` to `.gitignore`:

```bash
mkdir -p tools/zcall-re/static tools/zcall-re/__tests__ scratch/zcall-analysis
grep -qxF 'scratch/zcall-analysis/' .gitignore || echo 'scratch/zcall-analysis/' >> .gitignore
```

- [ ] **Step 2: Write the harvest script**

Create `tools/zcall-re/static/harvest.sh`:

```bash
#!/usr/bin/env bash
# Static harvest of zcall_mac.node with radare2/rabin2. Outputs to scratch/zcall-analysis/.
set -euo pipefail
BIN="app/native/nativelibs/zcall/zcall_mac.node"
OUT="scratch/zcall-analysis"
mkdir -p "$OUT"
rabin2 -qs "$BIN" > "$OUT/symbols.txt"                      # all symbols
rabin2 -zzq "$BIN" > "$OUT/strings.txt"                     # all strings
# WebRTC version / branch / build stamp
grep -aoiE 'WebRTC/M[0-9]+|branch-heads/[0-9]+|Cr-Commit-Position|src/out/[A-Za-z0-9_-]+|webrtcM[0-9]+|version .* webrtc' "$OUT/strings.txt" | sort -u > "$OUT/webrtc-version.txt" || true
# codec inventory
grep -aoiE 'libopus|opus|silk|isac|ilbc|vp8|vp9|openh264|x264|h264' "$OUT/strings.txt" | tr 'A-Z' 'a-z' | sort | uniq -c | sort -rn > "$OUT/codecs.txt" || true
echo "wrote: $OUT/{symbols,strings,webrtc-version,codecs}.txt"
```

- [ ] **Step 3: Run it and verify output exists**

Run:
```bash
chmod +x tools/zcall-re/static/harvest.sh && ./tools/zcall-re/static/harvest.sh
wc -l scratch/zcall-analysis/symbols.txt scratch/zcall-analysis/codecs.txt
cat scratch/zcall-analysis/webrtc-version.txt
```
Expected: `symbols.txt` ~35 000 lines; `codecs.txt` lists opus/silk/isac/vp8/vp9/h264; `webrtc-version.txt` shows a concrete WebRTC milestone/branch/commit stamp (if any is embedded).

- [ ] **Step 4: Record findings in Appendix A**

Append to the spec a section `## Appendix A — WebRTC identity + codec inventory` stating: the exact WebRTC version/branch/commit found (or "no explicit stamp; inferred from symbols X, Y"), and the codec list with counts. This is a factual record — copy the real values from the output files.

- [ ] **Step 5: Commit**

```bash
git add tools/zcall-re/README.md tools/zcall-re/static/harvest.sh .gitignore docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: static harvest tooling + WebRTC/codec identity (Appendix A)"
```

---

### Task 2: Native API method table (static)

**Files:**
- Create: `tools/zcall-re/static/methods.sh`
- Modify (append Appendix B): the spec

**Interfaces:**
- Consumes: `scratch/zcall-analysis/symbols.txt` (Task 1).
- Produces: `scratch/zcall-analysis/methods.txt` mapping each JS method name (`setConfig`, `makeCall`, …) to its native symbol/address; Appendix B "Native API method table".

- [ ] **Step 1: Write the method-locator script**

Create `tools/zcall-re/static/methods.sh`:

```bash
#!/usr/bin/env bash
# Locate the native implementations of the MainApp() JS methods.
set -euo pipefail
BIN="app/native/nativelibs/zcall/zcall_mac.node"
OUT="scratch/zcall-analysis"
METHODS="test setConfig setMediaConfig setListServers setConfigServer setState setCallback makeCall incomingCall updateCallerInfo mute holdAudio stopCapture getCallInfo getJsonStats406 getExtendData getActiveAudioCodecs getListDevices changeAudioDevice setAudioVolume changeVideoDevice setAgc startDesktopCapture stopDesktopCapture changeMinMaxMobileBitrate getVideoFrame getVideoFrameLocal getEventMessage stop"
: > "$OUT/methods.txt"
for m in $METHODS; do
  # symbol lines whose name contains the method (ObjectWrap registers a C++ method)
  hits=$(grep -aiE "\b${m}\b" "$OUT/symbols.txt" | grep -viE 'setState[a-z]|getState' | head -3 | tr '\n' ';')
  printf '%-26s %s\n' "$m" "${hits:-<none>}" >> "$OUT/methods.txt"
done
# also dump the module-init / NAPI or ObjectWrap registration function
r2 -qc 'aa; afl~[3]init; afl~MainApp' "$BIN" 2>/dev/null | head -40 >> "$OUT/methods.txt" || true
cat "$OUT/methods.txt"
```

- [ ] **Step 2: Run and verify most methods resolve**

Run:
```bash
chmod +x tools/zcall-re/static/methods.sh && ./tools/zcall-re/static/methods.sh
grep -c '<none>' scratch/zcall-analysis/methods.txt
```
Expected: the majority of the 30 methods map to a concrete symbol; `<none>` count is low (record which are unresolved — they may be registered via a string table rather than a symbol).

- [ ] **Step 3: Record Appendix B**

Append `## Appendix B — Native API method table`: for each of the 30 methods, the JS signature (from `vcmac.js`), and the native symbol/address where found. Mark unresolved ones for the dynamic pass.

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-re/static/methods.sh docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: native API method table (Appendix B)"
```

---

### Task 3: ZRTPPacket wire-layout recovery (static)

**Files:**
- Create: `tools/zcall-re/static/zrtppacket.sh`
- Modify (append Appendix C): the spec

**Interfaces:**
- Consumes: `scratch/zcall-analysis/symbols.txt`.
- Produces: `scratch/zcall-analysis/zrtppacket.asm` (disassembly of the packet ctor/serialize/parse) and Appendix C "ZRTPPacket tentative wire format" (field offsets/sizes/types).

- [ ] **Step 1: Write the disassembly script**

Create `tools/zcall-re/static/zrtppacket.sh`:

```bash
#!/usr/bin/env bash
# Disassemble the ZRTPPacket class methods to recover the wire layout.
set -euo pipefail
BIN="app/native/nativelibs/zcall/zcall_mac.node"
OUT="scratch/zcall-analysis"
# find candidate functions: ZRTPPacket ctor/serialize/parse/read/write
grep -aiE 'ZRTPPacket' "$OUT/symbols.txt" | awk '{print $NF}' | sort -u > "$OUT/zrtppacket-syms.txt"
: > "$OUT/zrtppacket.asm"
while read -r sym; do
  [ -z "$sym" ] && continue
  echo "==== $sym ====" >> "$OUT/zrtppacket.asm"
  r2 -qc "aa; s sym.$sym; pdf" "$BIN" 2>/dev/null >> "$OUT/zrtppacket.asm" || true
done < "$OUT/zrtppacket-syms.txt"
wc -l "$OUT/zrtppacket.asm"
```

- [ ] **Step 2: Run and verify disassembly produced**

Run:
```bash
chmod +x tools/zcall-re/static/zrtppacket.sh && ./tools/zcall-re/static/zrtppacket.sh
head -60 scratch/zcall-analysis/zrtppacket.asm
```
Expected: non-empty disassembly for several `ZRTPPacket*` symbols showing struct field loads/stores (offsets like `[rdi + 0x..]`), byte/short reads (`movzx`), htons/ntohs-style byte swaps.

- [ ] **Step 3: Derive the tentative layout, record Appendix C**

Read the disassembly. Document `## Appendix C — ZRTPPacket tentative wire format`: header fields with byte offset, size, endianness, and the packet-type enum values you can identify. Mark anything uncertain "TENTATIVE — confirm against capture (Task 7)". (It is fine for this appendix to be tentative; Task 7 validates it.)

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-re/static/zrtppacket.sh docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: ZRTPPacket wire-layout from static disassembly (Appendix C, tentative)"
```

---

### Task 4: CI harness — load + sanity on macos-latest

**Files:**
- Create: `.github/workflows/zcall-capture.yml`
- Create: `tools/zcall-re/harness.js`

**Interfaces:**
- Produces: a green CI run uploading `zcall-sanity.json` proving the addon loads on macOS and `test(123)===123`, plus `getListDevices()`/`getActiveAudioCodecs()` output.

- [ ] **Step 1: Write the harness (load + sanity mode)**

Create `tools/zcall-re/harness.js`:

```js
'use strict';
// SP1 harness. MODE=sanity: load the addon and dump non-call info.
// Loaded on a macOS runner where the mac frameworks exist.
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT_DIR || 'scratch/zcall-analysis';
fs.mkdirSync(OUT, { recursive: true });
const BIN = process.env.ZCALL_NODE ||
  path.resolve('app/native/nativelibs/zcall/zcall_mac.node');

function safe(fn, label) { try { return fn(); } catch (e) { return { __error: label + ': ' + e.message }; } }

const addon = require(BIN);
const app = addon.MainApp();
const out = {
  loaded: true,
  test123: safe(() => app.test(123), 'test'),
  listDevices: safe(() => app.getListDevices(), 'getListDevices'),
  activeAudioCodecs: safe(() => app.getActiveAudioCodecs(), 'getActiveAudioCodecs'),
  callInfo: safe(() => app.getCallInfo(), 'getCallInfo'),
};
fs.writeFileSync(path.join(OUT, 'zcall-sanity.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
```

- [ ] **Step 2: Write the workflow (sanity job)**

Create `.github/workflows/zcall-capture.yml`. It checks out, obtains the `.node` via the existing extractor, and runs the harness. The addon was built for the app's Electron ABI, so run under Electron 39 if plain Node fails to `dlopen`:

```yaml
name: zcall-capture
on:
  workflow_dispatch:
    inputs:
      mode:
        description: 'sanity | call'
        default: 'sanity'
jobs:
  capture:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install deps
        run: npm ci
      - name: Obtain zcall_mac.node (extract from DMG)
        env: { SETUP: 'true' }
        run: node scripts/download-installer.js && node scripts/extract-installer.js
      - name: Sanity (plain node)
        id: node
        continue-on-error: true
        run: OUT_DIR=scratch/zcall-analysis node tools/zcall-re/harness.js
      - name: Sanity (electron fallback)
        if: steps.node.outcome == 'failure'
        run: |
          npx --yes electron@39.8.10 tools/zcall-re/harness.js || true
      - uses: actions/upload-artifact@v4
        with:
          name: zcall-sanity
          path: scratch/zcall-analysis/zcall-sanity.json
          if-no-files-found: warn
```

> Note for the executing agent: this job runs in CI only. Push the branch, trigger `workflow_dispatch` (mode=sanity), then download the `zcall-sanity` artifact. You cannot run macos-latest locally.

- [ ] **Step 3: Verify locally that the harness is valid JS**

Run:
```bash
node --check tools/zcall-re/harness.js && echo "harness parses OK"
```
Expected: `harness parses OK` (it will not fully run on Linux — the `.node` is Mach-O — that is expected; the CI run is the real test).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/zcall-capture.yml tools/zcall-re/harness.js
git commit -m "zcall SP1: macos-latest capture workflow + load/sanity harness"
```

- [ ] **Step 5: CI gate (executing agent)**

Push, run the workflow (mode=sanity), download `zcall-sanity.json`. Expected: `test123: 123`, and device/codec output (may be empty on headless CI — record it). Append the result to Appendix B. If the addon fails to load even under Electron, record the exact error as a **blocker** and stop for a go/no-go review before Task 5.

---

### Task 5: CI harness — driven makeCall + tcpdump capture

**Files:**
- Modify: `tools/zcall-re/harness.js` (add `MODE=call`)
- Modify: `.github/workflows/zcall-capture.yml` (add capture step)

**Interfaces:**
- Consumes: the sample config from `app/native/nativelibs/zcall/index.js` (`testConnect`), rewritten to point `rtpIP`/`rtcpIP`/`servers[]` at `127.0.0.1`.
- Produces: `scratch/zcall-analysis/zcall.pcap` (emitted ZRTPPackets on loopback), `scratch/zcall-analysis/events.jsonl` (`getEventMessage` poll), `call.log`.

- [ ] **Step 1: Extend the harness with call mode**

Add to `tools/zcall-re/harness.js` a `MODE=call` path:

```js
// appended: MODE=call drives a controlled outbound call against loopback.
if (process.env.MODE === 'call') {
  const CAP_PORT = 59000; // loopback port we point RTP/RTCP at
  const cfg = {
    fromId: 111, toId: 222, protocol: 3, status: 3, callId: 10,
    sessId: 'SP1CAPTURE',
    settings: { logDebug: 1, dynamicBitrate: 1, checkTimeOut: 1500 },
    changeZRTP: { enable: 1, threshold: 5 },
    rtpIP: '127.0.0.1:' + CAP_PORT,
    rtcpIP: '127.0.0.1:' + (CAP_PORT + 1),
    servers: [{ rtpaddr: '127.0.0.1:' + CAP_PORT, rtcpaddr: '127.0.0.1:' + (CAP_PORT + 1) }],
    fec: { enable: 2, tableLookup: [[-1,3,1],[15,0,0]] },
  };
  const events = [];
  app.setCallback(() => {});
  // setConfig signature per vcmac.js setConfigData -> instance.setConfig(...)
  app.setConfig(JSON.stringify(cfg.settings), cfg.fromId, cfg.toId, cfg.protocol,
    cfg.callId, cfg.sessId, JSON.stringify({}), true, true,
    path.join(OUT, 'call.log'), 'linux x64', 0);
  app.setListServers(JSON.stringify(cfg.servers));
  app.makeCall();
  const t0 = Date.now();
  const timer = setInterval(() => {
    const m = safe(() => app.getEventMessage(), 'getEventMessage');
    if (m && m !== -100) events.push({ t: Date.now() - t0, m });
    if (Date.now() - t0 > 15000) {
      clearInterval(timer);
      fs.writeFileSync(path.join(OUT, 'events.jsonl'),
        events.map(e => JSON.stringify(e)).join('\n'));
      safe(() => app.stop(), 'stop');
      process.exit(0);
    }
  }, 100);
}
```

- [ ] **Step 2: Add the capture step to the workflow**

Add before the harness-call step (run tcpdump on loopback in the background):

```yaml
      - name: Driven call + capture
        if: ${{ github.event.inputs.mode == 'call' }}
        run: |
          sudo tcpdump -i lo0 -w scratch/zcall-analysis/zcall.pcap 'udp and (port 59000 or port 59001)' &
          TCPDUMP_PID=$!
          sleep 1
          MODE=call OUT_DIR=scratch/zcall-analysis node tools/zcall-re/harness.js || \
            MODE=call OUT_DIR=scratch/zcall-analysis npx --yes electron@39.8.10 tools/zcall-re/harness.js || true
          sleep 1
          sudo kill $TCPDUMP_PID || true
      - uses: actions/upload-artifact@v4
        if: ${{ github.event.inputs.mode == 'call' }}
        with:
          name: zcall-call-capture
          path: |
            scratch/zcall-analysis/zcall.pcap
            scratch/zcall-analysis/events.jsonl
            scratch/zcall-analysis/call.log
          if-no-files-found: warn
```

- [ ] **Step 3: Verify harness still parses**

Run:
```bash
node --check tools/zcall-re/harness.js && echo "ok"
```
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-re/harness.js .github/workflows/zcall-capture.yml
git commit -m "zcall SP1: driven makeCall + loopback tcpdump capture (call mode)"
```

- [ ] **Step 5: CI gate (executing agent)**

Push, run workflow (mode=call), download `zcall-call-capture`. Expected: `zcall.pcap` contains UDP datagrams to 127.0.0.1:59000/59001 (the emitted ZRTPPackets); `events.jsonl` has ≥1 event. If the pcap is empty, the call did not emit before a device/codec init failure — inspect `call.log`, and if unrecoverable in CI, record as a blocker for the go/no-go. Save the first packet's hex for Task 7.

---

### Task 6: UDP responder to advance the handshake

**Files:**
- Create: `tools/zcall-re/udp-responder.js`
- Modify: `.github/workflows/zcall-capture.yml` (start responder before the call)

**Interfaces:**
- Produces: a longer handshake in `zcall.pcap` (more `ZRTPPacket` types observed) by echoing/acking the first inbound datagram.

- [ ] **Step 1: Write the responder**

Create `tools/zcall-re/udp-responder.js`:

```js
'use strict';
// Minimal loopback UDP responder: echoes the first bytes back so the ZRTC
// handshake advances past its initial send. Listens on 59000/59001.
const dgram = require('dgram');
for (const port of [59000, 59001]) {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, rinfo) => {
    // echo the datagram straight back to the sender
    s.send(msg, rinfo.port, rinfo.address);
  });
  s.bind(port, '127.0.0.1');
}
console.log('udp-responder listening on 59000/59001');
```

- [ ] **Step 2: Start the responder in the workflow**

In the "Driven call + capture" step, start the responder before running the harness:

```yaml
          node tools/zcall-re/udp-responder.js &
          RESP_PID=$!
          sleep 0.5
```
and `sudo kill $RESP_PID || true` after the harness. (Add these lines inside the existing call step.)

- [ ] **Step 3: Verify responder parses**

Run:
```bash
node --check tools/zcall-re/udp-responder.js && echo ok
```
Expected: `ok`. (Optionally: run `node tools/zcall-re/udp-responder.js` locally, send a UDP packet with `nc -u`, confirm echo — but the real exercise is CI.)

- [ ] **Step 4: Commit**

```bash
git add tools/zcall-re/udp-responder.js .github/workflows/zcall-capture.yml
git commit -m "zcall SP1: loopback UDP responder to advance the ZRTC handshake"
```

- [ ] **Step 5: CI gate (executing agent)**

Re-run workflow (mode=call). Expected: `zcall.pcap` now shows a back-and-forth (more than one outbound packet, possibly distinct types). Record how far the handshake progressed; save representative packets for Task 7.

---

### Task 7: PoC ZRTPPacket parser + test against a real packet

**Files:**
- Create: `tools/zcall-re/parse-zrtppacket.js`
- Create: `tools/zcall-re/__tests__/parse-zrtppacket.test.js`
- Modify (append Appendix C confirmation): the spec

**Interfaces:**
- Consumes: the tentative layout (Appendix C, Task 3) + a real captured packet hex (Task 5/6).
- Produces: `parseZrtpPacket(buf) -> { type, length, seq, ...fields }` validated against a real packet; confirms/corrects Appendix C.

- [ ] **Step 1: Write the parser from the tentative layout**

Create `tools/zcall-re/parse-zrtppacket.js` implementing the Appendix-C layout. Example shape (adjust offsets/fields to the ACTUAL layout recovered in Task 3):

```js
'use strict';
// Decodes a ZRTPPacket per the layout recovered in Appendix C of the SP1 spec.
// Field offsets/sizes MUST match the disassembly; this is the starting skeleton.
function parseZrtpPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error('short packet');
  return {
    type: buf.readUInt8(0),          // <- confirm offset/size from Appendix C
    flags: buf.readUInt8(1),
    length: buf.readUInt16BE(2),     // <- confirm endianness from disassembly
    // ...additional fields per Appendix C...
    rawLen: buf.length,
  };
}
module.exports = { parseZrtpPacket };
```

- [ ] **Step 2: Write the failing test with a REAL captured packet**

Create `tools/zcall-re/__tests__/parse-zrtppacket.test.js`. Paste the hex of the first packet from `zcall.pcap` (extract with `tshark -r zcall.pcap -T fields -e data` or `xxd`), and assert the decoded fields match what the static layout predicts:

```js
const assert = require('assert');
const { parseZrtpPacket } = require('../parse-zrtppacket.js');
// First ZRTPPacket captured on loopback (Task 5/6). Replace with the real hex.
const HEX = 'REPLACE_WITH_REAL_CAPTURED_PACKET_HEX';
const buf = Buffer.from(HEX, 'hex');
const p = parseZrtpPacket(buf);
assert.ok(p.rawLen === buf.length, 'length round-trips');
assert.ok(typeof p.type === 'number', 'type decoded');
// assert.strictEqual(p.type, <EXPECTED_TYPE_FROM_APPENDIX_C>, 'packet type matches');
// assert.strictEqual(p.length, <EXPECTED>, 'declared length matches payload');
console.log('OK parse-zrtppacket', JSON.stringify(p));
```

- [ ] **Step 3: Run the test to verify it fails first (placeholder hex)**

Run:
```bash
node tools/zcall-re/__tests__/parse-zrtppacket.test.js
```
Expected: FAIL (placeholder hex is invalid) — proving the test executes. Then replace `HEX` with the real captured packet.

- [ ] **Step 4: Reconcile parser vs capture until the test passes**

Iterate: if the decoded `type`/`length` disagree with the raw bytes, the Appendix-C layout was wrong — fix `parse-zrtppacket.js` (and Appendix C) to match the real bytes. Run:
```bash
node tools/zcall-re/__tests__/parse-zrtppacket.test.js
```
Expected: `OK parse-zrtppacket {...}` with fields consistent with the raw packet.

- [ ] **Step 5: Confirm Appendix C**

Update Appendix C: replace "TENTATIVE" with the confirmed layout, citing the real packet hex as evidence.

- [ ] **Step 6: Commit**

```bash
git add tools/zcall-re/parse-zrtppacket.js tools/zcall-re/__tests__/parse-zrtppacket.test.js docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: PoC ZRTPPacket parser validated against a real captured packet (Appendix C confirmed)"
```

---

### Task 8: Config / event / stats JSON schemas

**Files:**
- Modify (append Appendix D): the spec

**Interfaces:**
- Consumes: `events.jsonl`, `call.log`, and the sanity `getCallInfo`/`getJsonStats406`/`getActiveAudioCodecs` output (Tasks 4–6), plus the `setConfig`/`servers`/`fec` shapes from `index.js`/`vcmac.js`.
- Produces: Appendix D "JSON contracts" — schemas for `setConfig` input, `getEventMessage` events, `getCallInfo`, `getJsonStats406`, `getActiveAudioCodecs`.

- [ ] **Step 1: Extract the event types from the capture**

Run:
```bash
cat scratch/zcall-analysis/events.jsonl | node -e 'let s=0;require("readline").createInterface({input:process.stdin}).on("line",l=>{try{const e=JSON.parse(l);const m=typeof e.m==="string"?JSON.parse(e.m):e.m;console.log(m&&m.type)}catch(_){}})' | sort -u
```
Expected: the distinct `type` values the call emitted (the state-machine events). Record them.

- [ ] **Step 2: Write Appendix D**

Append `## Appendix D — JSON contracts`: the `setConfig` field map (from `vcmac.js` `setConfigData`), the observed `getEventMessage` event `type`s + payload fields, and the `getCallInfo`/`getJsonStats406`/`getActiveAudioCodecs` shapes from the sanity dumps. Where CI produced no data (headless), note "not observed in CI — from JS/static only".

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: config/event/stats JSON contracts (Appendix D)"
```

---

### Task 9: Go/No-Go report

**Files:**
- Modify (append Appendix E): the spec

**Interfaces:**
- Consumes: Appendices A–D.
- Produces: Appendix E "Go/No-Go" — feasibility verdict, blockers, effort estimate for SP2–SP6, recommended next sub-project.

- [ ] **Step 1: Synthesize the verdict**

Append `## Appendix E — Go/No-Go`. Answer, with evidence from A–D:
1. Is the ZRTC transport reproducible on Linux (packet format known? key-exchange standard or Zalo-custom? server-selection understood?).
2. Is the WebRTC fork obtainable/buildable for Linux with the required codecs (Opus/SILK/iSAC/H264/VP8/VP9)?
3. Blockers (ZRTP crypto keying, account/login/token requirement, server anti-abuse, codec licensing).
4. Effort estimate + risk for SP2–SP6.
5. Recommendation: GO (→ which sub-project next and why) or NO-GO / conditional (what must be resolved first).

- [ ] **Step 2: Update the spec Status line**

Change the spec's `Status:` from `DESIGN (approved)` to `SP1 COMPLETE — see Appendix E` (or `SP1 BLOCKED — see Appendix E`).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md
git commit -m "zcall SP1: go/no-go report + verdict (Appendix E)"
```

---

## Self-Review

**Spec coverage:** Every in-scope item of the spec maps to a task — API contract (Task 2, 8), ZRTPPacket wire format (Task 3, 7), signaling/handshake (Task 5, 6), config/event/stats JSON (Task 8), WebRTC identity (Task 1), method dynamic gate (Task 4). Deliverables: protocol appendix (A–D), PoC parser (Task 7), WebRTC version (Task 1), go/no-go (Task 9). Covered.

**Placeholder scan:** The only intentional "REPLACE_WITH_REAL…" is the captured-packet hex in Task 7, which is genuinely produced by the CI capture in Task 5/6 — it cannot be known before the run, and the task explicitly instructs replacing it. All analysis appendices are recorded from real command output, not invented.

**Type consistency:** `parseZrtpPacket(buf)` is defined in Task 7 and consumed only there. Harness `MODE`/`OUT_DIR`/`ZCALL_NODE` env names are consistent across Tasks 4–6. Artifact filenames (`zcall.pcap`, `events.jsonl`, `zcall-sanity.json`) are consistent across the workflow and Tasks 5–8.

**Note on CI gates:** Tasks 4–6 include a "CI gate (executing agent)" step because macos-latest cannot run locally; the executing agent must push, trigger `workflow_dispatch`, and download artifacts before proceeding. If a gate reveals a hard blocker (addon won't load, or no packets emitted), stop and take the go/no-go decision early rather than continuing.
