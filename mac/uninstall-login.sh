#!/usr/bin/env bash
# uninstall-login.sh — removes agent-claudy's start-at-login entry.
#
# Unloads and deletes the LaunchAgent, and restores Claude Code's native
# notifications if they had been muted.

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

# Restore Claude Code's notifications in case the server didn't do it.
node "$PROJECT_DIR/bin/claudy-mute-claude.js" off 2>/dev/null || true
echo "✓ notifications de Claude Code restaurées (si nécessaire)."
