#!/usr/bin/env bash
# uninstall-login.sh — retire le démarrage au login d'agent-claudy.
#
# Décharge et supprime le LaunchAgent, et restaure les notifications natives de
# Claude Code si elles avaient été coupées.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.claudy.agent-claudy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ LaunchAgent retiré : $PLIST"
else
  echo "(aucun LaunchAgent trouvé : $PLIST)"
fi

# Restaure les notifs de Claude Code au cas où le serveur ne l'aurait pas fait.
node "$PROJECT_DIR/bin/claudy-mute-claude.js" off 2>/dev/null || true
echo "✓ notifications de Claude Code restaurées (si nécessaire)."
