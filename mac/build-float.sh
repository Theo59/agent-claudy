#!/usr/bin/env bash
# build-float.sh — compiles the floating window (claudy-float.swift) into
# mac/agent-claudy-float.app. Requires swiftc (Command Line Tools).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/agent-claudy-float.app"
SRC="$DIR/claudy-float.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "✗ swiftc introuvable (xcode-select --install)." >&2
  exit 1
fi

echo "Compilation de $SRC …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -framework Cocoa -framework WebKit -framework Carbon -o "$APP/Contents/MacOS/agent-claudy-float" "$SRC"

cat > "$APP/Contents/Info.plist" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agent-claudy-float</string>
  <key>CFBundleDisplayName</key><string>Agent Claudy</string>
  <key>CFBundleIdentifier</key><string>com.claudy.agent-claudy.float</string>
  <key>CFBundleExecutable</key><string>agent-claudy-float</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST_EOF

echo "✓ Construit : $APP"
echo "  Lancer : open \"$APP\"  (fenêtre flottante toujours au-dessus, déplaçable)"
echo "  Fermer la fenêtre quitte l'app."
