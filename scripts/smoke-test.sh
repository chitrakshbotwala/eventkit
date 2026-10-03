#!/usr/bin/env bash
# Launch a packaged EventKit build and wait for its self-check (see apps/desktop/src/main/smoke.ts):
# the window must load and complete an IPC round trip. Used by the release workflow.
#
#   scripts/smoke-test.sh <executable> [extra Electron flags...]
#
# The display comes from the environment: DISPLAY for X11, WAYLAND_DISPLAY for Wayland.
set -uo pipefail

exe=$1
shift
result="$(mktemp -d)/smoke.json"

# Job control puts the app in its own process group, so a timeout can stop it with all its
# children (an AppImage's launcher is not the Electron process).
set -m
EVENTKIT_SMOKE_TEST=$result EVENTKIT_DISABLE_UPDATES=1 "$exe" "$@" &
pid=$!
# Portable timeout (macOS has no `timeout`).
(
  sleep 150 &
  trap 'kill $! 2>/dev/null; exit 0' TERM
  wait $!
  kill -- -"$pid" 2>/dev/null && echo "--- timed out after 150 s"
) &
watchdog=$!
wait "$pid"
code=$?
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null

echo "--- exit code: $code"
# The result includes the last lines of the app log.
if [ -s "$result" ]; then cat "$result"; else echo "(no result written)"; fi

[ "$code" -eq 0 ] && grep -q '"ok": true' "$result" 2>/dev/null
