#!/usr/bin/env bash
# install.sh — the "simplest" installer for agent-claudy.
#
# Local usage (from the cloned repo):   bash install.sh
# Remote usage (one-liner):             curl -fsSL <URL>/install.sh | bash
#
# What it does:
#   1. checks for Node ≥ 18;
#   2. fetches the project if needed (remote mode);
#   3. on macOS: builds the menubar + floating window apps (swiftc);
#   4. prints how to launch it.
# Zero npm dependencies (the server is 100% native Node).

set -euo pipefail

# Repo to clone in remote mode (to be filled in once published).
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

# ── 2. Locate / fetch the project ────────────────────────────────────────────
# If we're running from the repo (server/server.js sitting next to us), use it;
# otherwise (curl one-liner) clone it.
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

# ── 3. macOS: build the native apps ──────────────────────────────────────────
if [ "$(uname)" = "Darwin" ] && command -v swiftc >/dev/null 2>&1; then
  say "Compilation des apps macOS (menubar + fenêtre flottante)…"
  bash "$ROOT/mac/build-bar.sh"   >/dev/null && say "  ✓ app menubar"
  bash "$ROOT/mac/build-float.sh" >/dev/null && say "  ✓ fenêtre flottante"
else
  say "Apps macOS ignorées (pas macOS, ou swiftc absent → xcode-select --install)."
fi

# ── 4. How to launch ─────────────────────────────────────────────────────────
cat <<EOF

$(say "Installé ! Pour démarrer :")
  • Serveur + navigateur :  cd "$ROOT" && npm start   → http://127.0.0.1:4310
  • App menubar (macOS)  :  open "$ROOT/mac/agent-claudy.app"
  • Démarrage au login   :  bash "$ROOT/mac/install-login.sh"

« Éducation minimum ! »
EOF
