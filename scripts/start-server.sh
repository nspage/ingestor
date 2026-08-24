#!/bin/zsh
# Starts the local pipeline server if it is not already up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/yt-pipeline.log"
mkdir -p "$(dirname "$LOG")"

if curl -sf -m 1 "http://127.0.0.1:3000/api/extension/health" >/dev/null; then
  exit 0
fi

: "${HOME:?HOME is not set}"
cd "$ROOT"

# Login shell so nvm/node are available.
nohup /bin/zsh -lc "cd '$ROOT' && npm start" >>"$LOG" 2>&1 &
echo $! > "$HOME/Library/Logs/yt-pipeline.pid"
exit 0
