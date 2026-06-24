#!/usr/bin/env bash
# install.sh — installeur « le plus simple » pour agent-claudy.
#
# Usage local (depuis le dépôt cloné) :   bash install.sh
# Usage distant (one-liner) :             curl -fsSL <URL>/install.sh | bash
#
# Ce que ça fait :
#   1. vérifie Node ≥ 18 ;
#   2. récupère le projet si besoin (mode distant) ;
#   3. sur macOS : compile les apps menubar + fenêtre flottante (swiftc) ;
#   4. affiche comment lancer.
# Zéro dépendance npm (le serveur est 100 % Node natif).

set -euo pipefail

# Dépôt à cloner en mode distant (à renseigner une fois publié).
REPO_URL="${CLAUDY_REPO:-https://github.com/CHANGE_ME/agent-claudy.git}"

say() { printf "\033[1;33m👓 %s\033[0m\n" "$*"; }
warn() { printf "\033[1;31m⚠️  %s\033[0m\n" "$*" >&2; }

# ── 1. Node ≥ 18 ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js introuvable. Installe Node ≥ 18 (https://nodejs.org) puis relance."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node $(node -v) détecté ; il faut Node ≥ 18."
  exit 1
fi
say "Node $(node -v) — OK."

# ── 2. Localiser / récupérer le projet ──────────────────────────────────────
# Si on est lancé depuis le dépôt (server/server.js présent à côté), on l'utilise ;
# sinon (one-liner curl) on clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server/server.js" ]; then
  ROOT="$SCRIPT_DIR"
  say "Projet trouvé : $ROOT"
else
  ROOT="${CLAUDY_DIR:-$HOME/.agent-claudy}"
  if [ -d "$ROOT/.git" ]; then
    say "Mise à jour de $ROOT…"
    git -C "$ROOT" pull --ff-only || warn "git pull a échoué (on continue avec l'existant)."
  else
    command -v git >/dev/null 2>&1 || { warn "git requis pour l'installation distante."; exit 1; }
    say "Clonage dans $ROOT…"
    git clone --depth 1 "$REPO_URL" "$ROOT"
  fi
fi

# ── 3. macOS : compiler les apps natives ────────────────────────────────────
if [ "$(uname)" = "Darwin" ] && command -v swiftc >/dev/null 2>&1; then
  say "Compilation des apps macOS (menubar + fenêtre flottante)…"
  bash "$ROOT/mac/build-bar.sh"   >/dev/null && say "  ✓ app menubar"
  bash "$ROOT/mac/build-float.sh" >/dev/null && say "  ✓ fenêtre flottante"
else
  say "Apps macOS ignorées (pas macOS, ou swiftc absent → xcode-select --install)."
fi

# ── 4. Comment lancer ───────────────────────────────────────────────────────
cat <<EOF

$(say "Installé ! Pour démarrer :")
  • Serveur + navigateur :  cd "$ROOT" && npm start   → http://127.0.0.1:4310
  • App menubar (macOS)  :  open "$ROOT/mac/agent-claudy.app"
  • Démarrage au login   :  bash "$ROOT/mac/install-login.sh"

« Éducation minimum ! »
EOF
