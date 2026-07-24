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
