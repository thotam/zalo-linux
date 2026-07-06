#!/usr/bin/env bash
# Headless smoke boot. Verifies the shell boots the Zalo bundle far enough to
# create a window WITHOUT throwing when native modules (sqlite3, db-cross-v4)
# load. REQUIRES a completed SETUP: app/ extracted + patched + native .node built
# (Tasks 2-9). Does NOT log in. Usage: scripts/_smoke-boot.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset ELECTRON_RUN_AS_NODE

# Isolate the Zalo profile into a throwaway dir so the smoke boot NEVER touches
# the user's real ~/.config/ZaloData. Zalo's migration.js computes its data paths
# from XDG_*_HOME, so overriding these keeps all reads/writes inside a temp dir.
SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/zalo-smoke-XXXXXX")"
export XDG_CONFIG_HOME="$SMOKE_HOME/config"
export XDG_DATA_HOME="$SMOKE_HOME/data"
export XDG_CACHE_HOME="$SMOKE_HOME/cache"
export XDG_STATE_HOME="$SMOKE_HOME/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
trap 'rm -rf "$SMOKE_HOME"' EXIT

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
# The harness writes its verdict to SMOKE_STATUS_FILE (durable) because console
# output is buffered and can be lost through the npx -> xvfb-run pipeline when the
# app exits abruptly. We read that file, not the tee'd stdout.
STATUS_FILE="$SMOKE_HOME/smoke-status"
export SMOKE_STATUS_FILE="$STATUS_FILE"

# Outer timeout is a backstop; the harness self-exits (0 ok / 1 fail).
timeout 120 xvfb-run -a --server-args="-screen 0 1280x800x24" \
  npx electron scripts/_smoke-main.js --no-sandbox --disable-gpu 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}

if grep -q "SMOKE_OK:" "$STATUS_FILE" 2>/dev/null; then
  echo "smoke boot OK ($(cat "$STATUS_FILE"))"; rm -f "$LOG"; exit 0
else
  echo "smoke boot FAILED (rc=$rc)"
  echo "--- verdict ---"; cat "$STATUS_FILE" 2>/dev/null || echo "(no status written)"
  rm -f "$LOG"; exit 1
fi
