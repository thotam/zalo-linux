#!/usr/bin/env bash
# Locate the native implementations of the MainApp() JS methods.
set -euo pipefail
BIN="app/native/nativelibs/zcall/zcall_mac.node"
OUT="scratch/zcall-analysis"
METHODS="test setConfig setMediaConfig setListServers setConfigServer setState setCallback makeCall incomingCall updateCallerInfo mute holdAudio stopCapture getCallInfo getJsonStats406 getExtendData getActiveAudioCodecs getListDevices changeAudioDevice setAudioVolume changeVideoDevice setAgc startDesktopCapture stopDesktopCapture changeMinMaxMobileBitrate getVideoFrame getVideoFrameLocal getEventMessage stop"
: > "$OUT/methods.txt"
for m in $METHODS; do
  # Itanium C++ mangling encodes identifiers as <length><name> with NO
  # separator (e.g. `__ZN4zvcm14MainAppWrapper4testE...` for `test`), so a
  # plain \b<name>\b regex never matches inside a mangled symbol -- every
  # character around the name is a "word" character, so no boundary exists.
  # Match the exact mangled form instead: <len><name>E, which is how a
  # nested-name-specifier component terminates right after the identifier.
  pattern="${#m}${m}E"
  # Note: under `set -o pipefail`, a `grep` that matches nothing makes the
  # whole pipeline's exit status non-zero even though `head`/`tr` succeed,
  # which would otherwise trip `set -e` on every miss. Append `|| true` so a
  # miss falls through to the fallback / <none> instead of aborting the loop.
  # (No "setState[a-z]|getState" de-dup filter here: the exact <len><name>E
  # match above is already precise, and a case-insensitive [A-Za-z] filter
  # would wrongly strip legitimate hits whose mangling terminator is itself
  # the letter "E", e.g. `...8setStateERKN3Nan...` for setState.)
  hits=$(grep -aE "$pattern" "$OUT/symbols.txt" | head -3 | tr '\n' ';') || true
  if [ -z "$hits" ]; then
    # Fallback: plain word-boundary match, in case the symbol is a
    # non-mangled/C export or otherwise doesn't follow the pattern above.
    hits=$(grep -aiE "\b${m}\b" "$OUT/symbols.txt" | grep -viE 'setState[a-z]|getState' | head -3 | tr '\n' ';') || true
  fi
  printf '%-26s %s\n' "$m" "${hits:-<none>}" >> "$OUT/methods.txt"
done
# also dump the module-init / NAPI or ObjectWrap registration function
r2 -qc 'aa; afl~[3]init; afl~MainApp' "$BIN" 2>/dev/null | head -40 >> "$OUT/methods.txt" || true
cat "$OUT/methods.txt"
