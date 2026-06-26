#!/usr/bin/env bash
# build-bar.sh — compiles the menubar app (claudy-bar.swift) into mac/agent-claudy.app.
#
# Requires the Command Line Tools (swiftc). Produces a menubar .app bundle
# (LSUIElement → no Dock icon) with an icon (Claudy's aviator logo, used for
# notifications) and an ad-hoc signature (required for UserNotifications).
# No external dependencies (qlmanage / sips / iconutil / codesign ship with macOS).

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

# ── Icon (.icns) from the SVG: render to PNG (qlmanage) → resize (sips) → iconutil ──
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

# Embed the Node runtime so the app is SELF-CONTAINED and relocatable (DMG → /Applications).
# Only for the distribution build (CLAUDY_EMBED=1, set by build-dmg.sh); a plain dev build
# stays light and runs from the live repo (projectRoot() falls back to …/mac/..).
if [ "${CLAUDY_EMBED:-0}" = "1" ]; then
  RES="$APP/Contents/Resources"
  for d in server public data bin; do
    rm -rf "$RES/$d"
    cp -R "$ROOT/$d" "$RES/$d"
  done
  # Minimal package.json so Node treats the embedded server.js as ESM (type:module).
  printf '{ "type": "module", "name": "agent-claudy" }\n' > "$RES/package.json"
  # Login-at-startup scripts: the menubar app invokes <root>/mac/{install,uninstall}-login.sh,
  # which resolve PROJECT_DIR as their own parent → Resources (the embedded runtime).
  mkdir -p "$RES/mac"
  cp "$ROOT/mac/install-login.sh" "$ROOT/mac/uninstall-login.sh" "$RES/mac/"
  echo "  ✓ runtime Node + scripts login embarqués (app autonome)"
fi

# Ad-hoc signature: without it, UNUserNotificationCenter.requestAuthorization fails
# silently on recent macOS. `-` = ad-hoc identity (no certificate required).
# (Runs AFTER embedding so the runtime is covered by the signature.)
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "  ✓ signée (ad-hoc)" || echo "  (signature ad-hoc échouée — notifs peut-être indisponibles)"
fi

echo "✓ Construit : $APP"
echo "  Lancer maintenant : open \"$APP\""
echo "  L'icône apparaît dans la barre de menus (en haut à droite), pas dans le Dock."
echo "  À la 1re notification, macOS demandera l'autorisation de notifier — accepte."
