#!/usr/bin/env bash
# build-dmg.sh — assemble un .dmg macOS contenant les deux apps (menubar + fenêtre
# flottante) et un raccourci /Applications, pour un glisser-déposer classique.
#
# Produit : mac/agent-claudy.dmg
# Nécessite : swiftc (pour (re)builder les apps) + hdiutil (natif macOS).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BAR="$DIR/agent-claudy.app"
FLOAT="$DIR/agent-claudy-float.app"
DMG="$DIR/agent-claudy.dmg"
VOL="agent-claudy"

if [ "$(uname)" != "Darwin" ]; then
  echo "✗ build-dmg.sh ne tourne que sur macOS." >&2
  exit 1
fi

# Rebuild systématique. L'app menubar embarque le runtime Node (CLAUDY_EMBED=1) pour être
# AUTONOME une fois glissée dans /Applications ; la fenêtre flottante n'ouvre qu'une WebView
# vers le serveur (pas besoin d'embarquer).
CLAUDY_EMBED=1 bash "$DIR/build-bar.sh"
bash "$DIR/build-float.sh"

# Dossier de montage temporaire (les 2 apps + lien Applications).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$BAR" "$STAGE/"
cp -R "$FLOAT" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "Création de $DMG …"
rm -f "$DMG"
hdiutil create \
  -volname "$VOL" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null

echo "✓ Construit : $DMG"
echo "  Glisse agent-claudy.app dans Applications."
echo "  Non notarisé → au 1er lancement : clic droit sur l'app → « Ouvrir »."
