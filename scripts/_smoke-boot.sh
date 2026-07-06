#!/usr/bin/env bash
# Headless smoke boot. Verifies the shell boots the Zalo bundle far enough to
# create a window WITHOUT throwing when native modules (sqlite3, db-cross-v4)
# load. REQUIRES a completed SETUP: app/ extracted + patched + native .node built
# (Tasks 2-9). Does NOT log in. Usage: scripts/_smoke-boot.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset ELECTRON_RUN_AS_NODE

SQLITE_NODE="app/native/nativelibs/sqlite3/binding/napi-v6-linux-x64/node_sqlite3.node"
DBCROSS_NODE="app/native/nativelibs/db-cross-v4/prebuilt/linux/electron/x64/db-cross-v4-native.node"
for f in "app/bootstrap.js" "$SQLITE_NODE" "$DBCROSS_NODE"; do
  if [ ! -e "$f" ]; then
    echo "SMOKE_FAIL: missing $f -- run SETUP first (npm run setup)"; exit 2
  fi
done

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "SMOKE_FAIL: xvfb-run not found -- sudo apt-get install -y xvfb"; exit 2
fi

LOG="$(mktemp)"
# Outer timeout is a backstop; the harness self-exits (0 ok / 1 fail).
timeout 120 xvfb-run -a --server-args="-screen 0 1280x800x24" \
  npx electron scripts/_smoke-main.js --no-sandbox --disable-gpu 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}

if [ "$rc" -eq 0 ] && grep -q "SMOKE_OK:" "$LOG"; then
  echo "smoke boot OK"; rm -f "$LOG"; exit 0
else
  echo "smoke boot FAILED (rc=$rc)"; rm -f "$LOG"; exit 1
fi
