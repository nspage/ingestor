#!/bin/zsh
set -euo pipefail

HOST_NAME="com.nspage.ytpipeline.json"
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
do
  rm -f "$dir/$HOST_NAME"
done

echo "Helper uninstalled. The extension Start button will no longer be able to launch the server."
