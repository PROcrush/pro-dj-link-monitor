#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL="$ROOT/labs/ltc-audio-timecode/install-blackhole-hal.sh"
UNINSTALL="$ROOT/labs/ltc-audio-timecode/uninstall-blackhole-hal.sh"
SMOKE="$ROOT/labs/ltc-audio-timecode/try-arena-ltc.cjs"
INSTALL_FLAG="--i-understand-this-installs-a-system-audio-driver"
UNINSTALL_FLAG="--i-understand-this-removes-a-system-audio-driver"

mode="${1:---dry-run}"
rollback_on_fail="false"

for arg in "$@"; do
  if [[ "$arg" == "--rollback-on-fail" ]]; then
    rollback_on_fail="true"
  fi
done

usage() {
  cat <<USAGE
Usage:
  $0 --dry-run
  $0 --install-test [--rollback-on-fail]

Dry-run prints the exact install/test/rollback flow without changing the system.

--install-test installs the local BlackHole 2ch HAL driver through:
  $INSTALL $INSTALL_FLAG

Then it runs:
  node $SMOKE

This is intentionally gated because the install writes to /Library/Audio/Plug-Ins/HAL
and restarts coreaudiod. If the smoke test fails and --rollback-on-fail is set,
it runs:
  $UNINSTALL $UNINSTALL_FLAG
USAGE
}

if [[ "$mode" == "--help" || "$mode" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$mode" == "--dry-run" ]]; then
  echo "PRO DJ LINK Arena LTC smoke dry-run"
  echo "install=$INSTALL $INSTALL_FLAG"
  echo "wait=3s"
  echo "smoke=node $SMOKE"
  echo "rollbackOnFail=$rollback_on_fail"
  if [[ "$rollback_on_fail" == "true" ]]; then
    echo "rollback=$UNINSTALL $UNINSTALL_FLAG"
  fi
  echo "No files changed."
  exit 0
fi

if [[ "$mode" != "--install-test" ]]; then
  echo "Unknown mode: $mode" >&2
  usage
  exit 2
fi

echo "Installing BlackHole HAL driver for Arena LTC smoke..."
"$INSTALL" "$INSTALL_FLAG"

echo "Waiting for CoreAudio to enumerate devices..."
/bin/sleep 3

echo "Running Arena LTC smoke..."
set +e
/usr/bin/env node "$SMOKE"
smoke_status=$?
set -e

if [[ "$smoke_status" -ne 0 && "$rollback_on_fail" == "true" ]]; then
  echo "Smoke failed with status $smoke_status; rolling back BlackHole install..."
  "$UNINSTALL" "$UNINSTALL_FLAG"
fi

exit "$smoke_status"
