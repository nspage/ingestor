#!/usr/bin/env bash
set -euo pipefail
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR"
shot() {
  local file="$1" w="$2" h="$3" name="$4"
  local profile
  profile="$(mktemp -d /tmp/ingestor-shot.XXXXXX)"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --no-first-run --no-default-browser-check \
    --user-data-dir="$profile" \
    --force-device-scale-factor=2 \
    --window-size="$w,$h" \
    --screenshot="$OUT/$name.png" \
    "file://$DIR/$file"
  rm -rf "$profile"
  echo "wrote $name.png (${w}x${h} @2x)"
}
shot pending.html 400 820 pending
shot channels.html 400 820 channels
shot history.html 400 820 history
shot note.html 400 820 note
shot pick.html 1280 800 pick
shot watch.html 1280 800 watch
shot og.html 1200 630 og
shot pill.html 280 72 pill
shot chips.html 400 88 chips
cp "$OUT/og.png" "$DIR/../og.png"
echo done
