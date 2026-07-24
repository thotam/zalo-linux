#!/usr/bin/env bash
# Disassemble the ZRTPPacket class methods to recover the wire layout.
set -euo pipefail
BIN="app/native/nativelibs/zcall/zcall_mac.node"
OUT="scratch/zcall-analysis"
# find candidate functions: ZRTPPacket ctor/serialize/parse/read/write
#
# Deviations from the brief (learned the hard way on the first run of this
# script):
#
# 1. `s sym.$sym` (the brief's per-symbol seek, one `r2 -qc` invocation per
#    symbol) silently fails. r2's `aa` analysis pass demangles every Itanium
#    C++ symbol and renames the flag from
#    `sym.__ZN4zrtc10ZRTPPacket20_buildPacketInternalEPhRj` (mangled) to
#    `sym.zrtc::ZRTPPacket::_buildPacketInternal_unsigned_char__unsigned_int_`
#    (demangled). So by the time `s sym.$sym` runs (after `aa;` in the same
#    -qc chain), the mangled flag name no longer exists, `s` on an
#    unresolvable expression is a silent no-op, and `pdf` dumps whatever
#    function the seek was already sitting at (empirically the Mach-O entry
#    point / first function r2 lands on after `aa`, `MainApp::MainApp()` at
#    0x1560) -- for EVERY symbol, identically. The first run of this script
#    produced exactly that: 51 identical `MainApp::MainApp` dumps and zero
#    real ZRTPPacket disassembly, despite `wc -l` reporting a large
#    non-empty file (a silent logic bug, not a crash -- worth calling out
#    since the "non-empty file" check in the brief's Step 2 does not catch
#    it; you have to actually read the disassembly).
#    Fix: seek by raw hex ADDRESS (`s 0x...`) instead of by mangled symbol
#    name -- addresses are stable across the `aa` demangling rename, so
#    capture address+name pairs from symbols.txt up front
#    (`awk '{print $1, $NF}'`) rather than just names.
# 2. Running `aa` once per symbol (51 separate `r2 -qc "aa; ..."` process
#    launches, the brief's structure) re-analyzes the whole 7.5MB binary
#    from scratch every time -- this took ~19 minutes wall clock for 51
#    symbols on this machine. Switched to a single r2 session (one `aa`,
#    then loop `s <addr>; pdf` for every symbol via an r2 batch script fed
#    with `-i`) which finishes in well under a minute.
# 3. Symbols ARE Itanium-mangled (`__ZN4zrtc10ZRTPPacket...`), but the
#    literal string "ZRTPPacket" survives unmangled inside the mangled name
#    (Itanium mangling keeps identifier text verbatim, only length-prefixing
#    it), so the brief's plain case-insensitive substring grep on
#    symbols.txt still matches correctly -- no mangled `<len><name>E`
#    rewrite needed here (contrast with Task 2's methods.sh, which
#    mangled-matched short generic names like "test"/"stop" that otherwise
#    false-positive/miss).
# 4. Under `set -o pipefail`, a `grep` that matches nothing makes the whole
#    pipeline's exit status non-zero even though `awk`/`sort` would have
#    succeeded downstream, tripping `set -e`. Added `|| true` defensively.
grep -aiE 'ZRTPPacket' "$OUT/symbols.txt" | awk '{print $1, $NF}' | sort -u -k2,2 > "$OUT/zrtppacket-syms.txt" || true

R2SCRIPT="$OUT/zrtppacket.r2"
: > "$R2SCRIPT"
echo "aa" >> "$R2SCRIPT"
while read -r addr sym; do
  [ -z "${sym:-}" ] && continue
  printf '%s\n' "?e ==== $sym ($addr) ====" >> "$R2SCRIPT"
  printf '%s\n' "s $addr" >> "$R2SCRIPT"
  printf '%s\n' "pdf" >> "$R2SCRIPT"
done < "$OUT/zrtppacket-syms.txt"

r2 -qi "$R2SCRIPT" "$BIN" 2>/dev/null > "$OUT/zrtppacket.asm" || true
wc -l "$OUT/zrtppacket.asm"
