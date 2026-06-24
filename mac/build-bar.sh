#!/usr/bin/env bash
# build-bar.sh — compile l'app menubar (claudy-bar.swift) en mac/agent-claudy.app.
#
# Nécessite les Command Line Tools (swiftc). Produit un bundle .app menubar
# (LSUIElement → pas d'icône dans le Dock) avec une icône (logo aviateur de Claudy,
# pour la notification) et une signature ad-hoc (requise pour UserNotifications).
# Aucune dépendance externe (qlmanage / sips / iconutil / codesign sont natifs macOS).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
APP="$DIR/agent-claudy.app"
SRC="$DIR/claudy-bar.swift"
ICON_SVG="$ROOT/media/claudy-icon.svg"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "✗ swiftc introuvable (installe les Command Line Tools : xcode-select --install)." >&2
  exit 1
fi

echo "Compilation de $SRC …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -framework Cocoa -framework UserNotifications \
  -o "$APP/Contents/MacOS/agent-claudy" "$SRC"

# ── Icône (.icns) depuis le SVG : rendu PNG (qlmanage) → tailles (sips) → iconutil ──
HAS_ICON=false
if [ -f "$ICON_SVG" ] && command -v qlmanage >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  TMP="$DIR/.icon-build"
  ICONSET="$TMP/claudy.iconset"
  rm -rf "$TMP"; mkdir -p "$ICONSET"
  qlmanage -t -s 1024 -o "$TMP" "$ICON_SVG" >/dev/null 2>&1 || true
  MASTER="$TMP/$(basename "$ICON_SVG").png"
  if [ -f "$MASTER" ]; then
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s" "$MASTER" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
      d=$((s * 2))
      sips -z "$d" "$d" "$MASTER" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
    done
    if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/claudy.icns" 2>/dev/null; then
      HAS_ICON=true
    fi
  fi
  rm -rf "$TMP"
fi
$HAS_ICON && echo "  ✓ icône intégrée (logo aviateur)" || echo "  (icône non générée — l'app reste fonctionnelle)"

cat > "$APP/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agent-claudy</string>
  <key>CFBundleDisplayName</key><string>agent-claudy</string>
  <key>CFBundleIdentifier</key><string>com.claudy.agent-claudy.bar</string>
  <key>CFBundleExecutable</key><string>agent-claudy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
$($HAS_ICON && echo '  <key>CFBundleIconFile</key><string>claudy</string>')
</dict>
</plist>
PLIST_EOF

# Signature ad-hoc : sans elle, UNUserNotificationCenter.requestAuthorization échoue
# silencieusement sur macOS récent. `-` = identité ad-hoc (pas de certificat requis).
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "  ✓ signée (ad-hoc)" || echo "  (signature ad-hoc échouée — notifs peut-être indisponibles)"
fi

echo "✓ Construit : $APP"
echo "  Lancer maintenant : open \"$APP\""
echo "  L'icône apparaît dans la barre de menus (en haut à droite), pas dans le Dock."
echo "  À la 1re notification, macOS demandera l'autorisation de notifier — accepte."
