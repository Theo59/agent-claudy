#!/usr/bin/env bash
# install-login.sh — lance agent-claudy automatiquement à l'ouverture de session (launchd).
#
# Crée un LaunchAgent ~/Library/LaunchAgents/com.claudy.agent-claudy.plist qui démarre
# le serveur en arrière-plan au login (et le relance s'il tombe). Réversible via
# uninstall-login.sh.
#
# Usage :
#   mac/install-login.sh [--port 4310] [--no-notify] [--no-mute] [--hide-session SID]
#
# Options :
#   --port N         port d'écoute (défaut 4310)
#   --no-notify      ne pas afficher les notifications macOS (sinon activées)
#   --no-mute        ne PAS couper les notifs natives de Claude Code (sinon coupées
#                    tant que le serveur tourne, pour éviter le doublon)
#   --hide-session   masque une session précise (ex. ton sessionId courant)

set -euo pipefail

PORT=4310
NOTIFY=1
MUTE=1
HIDE_SESSION=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-notify) NOTIFY=0; shift ;;
    --no-mute) MUTE=0; shift ;;
    --hide-session) HIDE_SESSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 1 ;;
  esac
done

# Valide le port : entier dans la plage TCP, sinon le daemon échouerait silencieusement au login.
case "$PORT" in
  '' | *[!0-9]*) echo "✗ Port invalide : « $PORT » (entier 1-65535 attendu)." >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "✗ Port hors plage : $PORT (attendu 1-65535)." >&2; exit 1
fi

# Chemins résolus à l'installation (launchd a un PATH minimal → chemins absolus requis).
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_JS="$PROJECT_DIR/server/server.js"
NODE_BIN="$(command -v node || true)"
LABEL="com.claudy.agent-claudy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agent-claudy.log"

if [ -z "$NODE_BIN" ]; then
  echo "✗ node introuvable dans le PATH. Installe Node ≥ 18 puis relance." >&2
  exit 1
fi
if [ ! -f "$SERVER_JS" ]; then
  echo "✗ $SERVER_JS introuvable." >&2
  exit 1
fi

# En dry-run : on génère et valide le plist dans un fichier temporaire, sans rien
# charger ni toucher à ~/Library (utile pour vérifier avant d'activer pour de vrai).
if [ "$DRY_RUN" = "1" ]; then
  PLIST="$(mktemp -t claudy-launchagent).plist"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Échappe les caractères XML spéciaux (un sessionId est normalement un UUID, mais on
# ne fait pas confiance à l'entrée → pas de plist corrompu).
esc_xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# Bloc <key>/<string> pour HIDE_SESSION seulement si fourni.
HIDE_BLOCK=""
if [ -n "$HIDE_SESSION" ]; then
  HIDE_BLOCK="    <key>CLAUDY_HIDE_SESSION</key><string>$(esc_xml "$HIDE_SESSION")</string>"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>n=\$(ls "\$HOME"/.nvm/versions/node/*/bin/node | tail -1); [ -x "\$n" ] || n=\$(command -v node); exec "\${n:-$NODE_BIN}" "$SERVER_JS"</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDY_PORT</key><string>$PORT</string>
    <key>CLAUDY_NOTIFY</key><string>$NOTIFY</string>
    <key>CLAUDY_MUTE_CC</key><string>$MUTE</string>
$HIDE_BLOCK
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

# Valide la syntaxe du plist avant de charger.
plutil -lint "$PLIST" >/dev/null

if [ "$DRY_RUN" = "1" ]; then
  echo "✓ [dry-run] plist valide ($PLIST) — rien chargé, machine inchangée."
  echo "  node : $NODE_BIN | port : $PORT | notifs : $NOTIFY | mute : $MUTE"
  rm -f "$PLIST"
  exit 0
fi

# Recharge proprement (unload si déjà présent, puis load).
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✓ LaunchAgent installé : $PLIST"
echo "  node    : $NODE_BIN"
echo "  port    : $PORT | notifs : $NOTIFY | mute Claude : $MUTE"
[ -n "$HIDE_SESSION" ] && echo "  session masquée : $HIDE_SESSION"
echo "  logs    : $LOG"
echo
echo "  → http://127.0.0.1:$PORT  (démarre maintenant et à chaque login)"
echo "  Pour désinstaller : mac/uninstall-login.sh"
