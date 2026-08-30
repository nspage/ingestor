#!/bin/zsh
# Kill the local helper on :3000 (if any) and start it again so code changes load.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$HOME/Library/Logs/yt-pipeline.pid"
LOG="$HOME/Library/Logs/yt-pipeline.log"

stop() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    rm -f "$PID_FILE"
  fi
  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    kill -9 "$pid" 2>/dev/null || true
  fi
  local port_pids
  port_pids="$(lsof -t -iTCP:3000 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$port_pids" ]]; then
    echo "$port_pids" | xargs kill 2>/dev/null || true
    sleep 0.4
    echo "$port_pids" | xargs kill -9 2>/dev/null || true
  fi
}

echo "Restarting helper…"
stop
mkdir -p "$(dirname "$LOG")"
cd "$ROOT"
nohup /bin/zsh -lc "cd '$ROOT' && npm start" >>"$LOG" 2>&1 &
echo $! > "$PID_FILE"

for _ in {1..20}; do
  if curl -sf -m 1 "http://127.0.0.1:3000/api/extension/health" >/dev/null; then
    echo "Helper is up on http://127.0.0.1:3000"
    echo "Logs: $LOG"
    exit 0
  fi
  sleep 0.4
done

echo "Helper did not answer on :3000. Check $LOG" >&2
exit 1
