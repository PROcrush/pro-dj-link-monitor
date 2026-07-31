#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DRIVER="$ROOT/labs/BlackHole/build/BlackHole.driver"
TARGET_DRIVER="/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver"
BACKUP_DRIVER="/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver.prodjlink-backup"
CONFIRM_FLAG="--i-understand-this-installs-a-system-audio-driver"

usage() {
  cat <<USAGE
Usage:
  $0 --dry-run
  sudo $0 $CONFIRM_FLAG

Installs the locally built BlackHole 2ch CoreAudio HAL driver for the PRO DJ LINK
LTC lab. This is a persistent system-level audio plugin install. It restarts
coreaudiod so macOS can enumerate the new virtual audio device.

Source:
  $SOURCE_DRIVER

Target:
  $TARGET_DRIVER
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -d "$SOURCE_DRIVER" ]]; then
  echo "Missing built BlackHole driver: $SOURCE_DRIVER" >&2
  echo "Build or download an official BlackHole 2ch driver before running this script." >&2
  exit 1
fi

echo "PRO DJ LINK LTC BlackHole install plan"
echo "source=$SOURCE_DRIVER"
echo "target=$TARGET_DRIVER"

if [[ "${1:-}" == "--dry-run" || "${1:-}" == "" ]]; then
  echo "dryRun=true"
  echo "No files changed."
  usage
  exit 0
fi

if [[ "${1:-}" != "$CONFIRM_FLAG" ]]; then
  echo "Refusing to install without explicit confirmation flag." >&2
  usage
  exit 2
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "This install writes to /Library and must be run with sudo." >&2
  exit 3
fi

if [[ -d "$TARGET_DRIVER" && ! -d "$BACKUP_DRIVER" ]]; then
  /bin/mv "$TARGET_DRIVER" "$BACKUP_DRIVER"
  echo "backup=$BACKUP_DRIVER"
fi

/bin/mkdir -p "$(dirname "$TARGET_DRIVER")"
/usr/bin/ditto "$SOURCE_DRIVER" "$TARGET_DRIVER"
/usr/sbin/chown -R root:wheel "$TARGET_DRIVER"
/bin/chmod -R go-w "$TARGET_DRIVER"

if /usr/bin/killall coreaudiod 2>/dev/null; then
  echo "coreaudiod=restarted"
else
  echo "coreaudiod=not-running-or-not-permitted"
fi

echo "installed=$TARGET_DRIVER"
echo "Next: run node labs/ltc-audio-timecode/try-arena-ltc.cjs"
