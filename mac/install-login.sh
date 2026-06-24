#!/usr/bin/env bash
# install-login.sh — starts agent-claudy automatically when you log in (launchd).
#
# Creates a LaunchAgent ~/Library/LaunchAgents/com.claudy.agent-claudy.plist that starts
# the server in the background at login (and restarts it if it dies). Reversible via
# uninstall-login.sh.
#
# Usage:
#   mac/install-login.sh [--port 4310] [--no-notify] [--no-mute] [--hide-session SID]
#
# Options:
#   --port N         listening port (default 4310)
#   --no-notify      do not show macOS notifications (enabled otherwise)
#   --no-mute        do NOT silence Claude Code's native notifications (silenced
#                    otherwise while the server runs, to avoid duplicates)
#   --hide-session   hide a specific session (e.g. your current sessionId)

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

# Validate the port: an integer in the TCP range, otherwise the daemon would fail silently at login.
case "$PORT" in
  '' | *[!0-9]*) echo "✗ Port invalide : « $PORT » (entier 1-65535 attendu)." >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "✗ Port hors plage : $PORT (attendu 1-65535)." >&2; exit 1
fi

# Paths resolved at install time (launchd has a minimal PATH → absolute paths required).
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

# In dry-run mode: generate and validate the plist in a temporary file, without loading
# anything or touching ~/Library (handy to verify before actually enabling it).
if [ "$DRY_RUN" = "1" ]; then
  PLIST="$(mktemp -t claudy-launchagent).plist"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Escape special XML characters (a sessionId is normally a UUID, but we do not
# trust the input → no corrupted plist).
esc_xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# <key>/<string> block for HIDE_SESSION only if provided.
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

# Validate the plist syntax before loading.
plutil -lint "$PLIST" >/dev/null

if [ "$DRY_RUN" = "1" ]; then
  echo "✓ [dry-run] plist valide ($PLIST) — rien chargé, machine inchangée."
  echo "  node : $NODE_BIN | port : $PORT | notifs : $NOTIFY | mute : $MUTE"
  rm -f "$PLIST"
  exit 0
fi

# Reload cleanly (unload if already present, then load).
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
