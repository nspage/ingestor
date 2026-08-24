#!/bin/zsh
set -euo pipefail

# Registers ytpipeline:// so Chrome can ask macOS to start the server.
APP="$HOME/Applications/YT Pipeline Helper.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$MACOS" "$RES"

cat > "$MACOS/helper" <<EOF
#!/bin/zsh
"$ROOT/scripts/start-server.sh"
EOF
chmod +x "$MACOS/helper"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>YT Pipeline Helper</string>
  <key>CFBundleDisplayName</key>
  <string>YT Pipeline Helper</string>
  <key>CFBundleIdentifier</key>
  <string>com.nspage.ytpipeline</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>YT Pipeline Start</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>ytpipeline</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
EOF

# Register the app with Launch Services
if [[ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
fi

echo "Registered: $APP"
echo "URL scheme: ytpipeline://"
