#!/usr/bin/env bash
set -euo pipefail

TARGET_DRIVER="/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver"
BACKUP_DRIVER="/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver.prodjlink-backup"
CONFIRM_FLAG="--i-understand-this-removes-a-system-audio-driver"

usage() {
  cat <<USAGE
Usage:
  $0 --dry-run
  sudo $0 $CONFIRM_FLAG

Removes the PRO DJ LINK LTC lab BlackHole 2ch CoreAudio HAL driver install and
restarts coreaudiod. If a previous driver backup exists, it is restored.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

echo "PRO DJ LINK LTC BlackHole uninstall plan"
echo "target=$TARGET_DRIVER"
echo "backup=$BACKUP_DRIVER"

if [[ "${1:-}" == "--dry-run" || "${1:-}" == "" ]]; then
  echo "dryRun=true"
  echo "No files changed."
  usage
  exit 0
fi

if [[ "${1:-}" != "$CONFIRM_FLAG" ]]; then
  echo "Refusing to remove without explicit confirmation flag." >&2
  usage
  exit 2
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "This uninstall writes to /Library and must be run with sudo." >&2
  exit 3
fi

if [[ -d "$TARGET_DRIVER" ]]; then
  /bin/rm -rf "$TARGET_DRIVER"
  echo "removed=$TARGET_DRIVER"
fi

if [[ -d "$BACKUP_DRIVER" ]]; then
  /bin/mv "$BACKUP_DRIVER" "$TARGET_DRIVER"
  echo "restored=$TARGET_DRIVER"
fi

if /usr/bin/killall coreaudiod 2>/dev/null; then
  echo "coreaudiod=restarted"
else
  echo "coreaudiod=not-running-or-not-permitted"
fi

echo "done=true"
