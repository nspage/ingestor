#!/bin/zsh
# Chrome launches this with a tiny PATH. Use a known python.
export HOME="${HOME:?HOME is not set}"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"

PY="/usr/bin/python3"
if [[ ! -x "$PY" ]]; then
  PY="$(command -v python3)"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$PY" "$ROOT/scripts/native-host.py"
