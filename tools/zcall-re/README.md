# zcall-re

Reverse-engineering tooling for `app/native/nativelibs/zcall/zcall_mac.node`
(Zalo's macOS voice/video calling native addon), part of the SP1 spike in
`docs/superpowers/specs/2026-07-11-zcall-sp1-zrtc-protocol-re.md`.

This is **analysis-only** tooling. It does not build WebRTC, does not implement
any Linux media I/O, and does not modify `app/`, `scripts/main.js`, or any
shipping patch.

## Two passes

### 1. Static (this machine, Linux)

`static/harvest.sh` runs `radare2`/`rabin2` (Mach-O reader, works on Linux)
against the binary to dump:
- all symbols (`symbols.txt`) — C++ mangled names give class/method structure
  even though the binary is not fully stripped.
- all strings (`strings.txt`).
- a WebRTC version/branch/commit grep (`webrtc-version.txt`).
- a codec-name occurrence count (`codecs.txt`).

Further static work (disassembly of `ZRTPPacket` serialize/parse, `ZRtcConfig`,
etc.) also happens here, using `radare2` interactively.

### 2. Dynamic (GitHub Actions `macos-latest` runner)

The CI workflow `.github/workflows/zcall-capture.yml` loads the addon on a real
macOS runner (the addon is x86_64-only and built against NODE_MODULE_VERSION 57,
so it runs under Node 8.17.0 x64 via Rosetta 2 on the arm64 runner), drives a
controlled `makeCall()` against a loopback endpoint we own, and captures `pcap` +
JSON logs. This gives ground truth to cross-validate the static findings against.
See the spec's "Method — hybrid" section and Appendix E for detail.

## Binary handling constraint

`zcall_mac.node` lives under the gitignored `app/native/nativelibs/zcall/`
directory and is **never re-committed**. All captured artifacts (symbol dumps,
strings, disassembly notes, pcaps, JSON logs) go under the gitignored
`scratch/zcall-analysis/`. Only distilled findings — counts, version stamps,
protocol layouts — are copied into tracked docs (the spec's appendices).

## Usage

```bash
chmod +x tools/zcall-re/static/harvest.sh
./tools/zcall-re/static/harvest.sh
wc -l scratch/zcall-analysis/symbols.txt scratch/zcall-analysis/codecs.txt
cat scratch/zcall-analysis/webrtc-version.txt
```
