#!/bin/zsh
set -euo pipefail

# One-time: lets the Chrome extension start the local server with a button.
# No Docker. No Trigger.dev.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_NAME="com.nspage.ytpipeline"
HOST_SCRIPT="$ROOT/scripts/native-host.sh"
EXT_ID="ohmmfomloggnnjcfdfmgjloefbfnmoih"

chmod +x "$HOST_SCRIPT" "$ROOT/scripts/native-host.py" "$ROOT/scripts/start-server.sh" "$ROOT/scripts/install-app.sh"

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Start the YouTube pipeline local server",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

install_for() {
  local dir="$1"
  mkdir -p "$dir"
  echo "$MANIFEST" > "$dir/$HOST_NAME.json"
  echo "  installed: $dir/$HOST_NAME.json"
}

echo "Installing the Start local server helper…"
bash "$ROOT/scripts/install-app.sh"
install_for "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
install_for "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
install_for "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
install_for "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
install_for "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
install_for "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

echo ""
echo "Done. Next:"
echo "  1. Chrome → chrome://extensions"
echo "  2. Reload “YT LLM Pipeline Assistant” (unpacked folder: chrome-extension)"
echo "  3. Open the extension and click “Start local server” when you want to process a video."
