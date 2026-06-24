// agent-claudy — « aller à la fenêtre de l'agent ».
//
// À partir du PID d'une session Claude Code, on remonte l'arbre des processus pour
// déterminer QUI l'héberge (éditeur VS Code / Cursor, terminal, autre) puis on
// active la bonne fenêtre :
//   - éditeur : `code <cwd>` / `cursor <cwd>` ramène la fenêtre du dossier au premier
//     plan (et l'ouvre si besoin), + activation de l'app ;
//   - terminal : on active l'app du terminal ;
//   - sinon : on ouvre le dossier dans le Finder (repli).
//
// macOS uniquement (osascript / open). Zéro dépendance.

import { spawn, spawnSync } from "node:child_process";

// Un cran de l'arbre : ppid + chemin complet de l'exécutable (ps -o comm= donne le path).
function procInfo(pid) {
  const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.trim().match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), comm: m[2] };
}

// Remonte jusqu'à launchd (pid 1) ; renvoie la liste des exécutables traversés.
function ancestry(pid) {
  const chain = [];
  let p = Number(pid);
  let guard = 0;
  while (p > 1 && guard++ < 12) {
    const info = procInfo(p);
    if (!info) break;
    chain.push(info.comm);
    p = info.ppid;
  }
  return chain;
}

function classify(chain) {
  const joined = chain.join("\n");
  if (/Cursor\.app/i.test(joined)) return { kind: "editor", app: "Cursor", cli: "cursor" };
  if (/Visual Studio Code\.app|\/Code Helper|\/MacOS\/Code\b/i.test(joined)) {
    return { kind: "editor", app: "Visual Studio Code", cli: "code" };
  }
  const term = chain
    .map((c) => {
      if (/iTerm\.app/i.test(c)) return "iTerm";
      if (/Terminal\.app/i.test(c)) return "Terminal";
      if (/ghostty/i.test(c)) return "Ghostty";
      if (/kitty/i.test(c)) return "kitty";
      if (/[Aa]lacritty/.test(c)) return "Alacritty";
      if (/wezterm/i.test(c)) return "WezTerm";
      if (/WarpTerminal|Warp\.app/i.test(c)) return "Warp";
      return null;
    })
    .find(Boolean);
  if (term) return { kind: "terminal", app: term };
  return { kind: "unknown", app: null };
}

// Lance une commande sans bloquer (réponse HTTP immédiate ; l'activation suit ~200ms).
function run(cmd, args) {
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    /* on ne casse jamais le serveur pour un focus */
  }
}

/**
 * Ramène au premier plan la fenêtre hébergeant la session.
 * Via `open -a` (LaunchServices) : rapide (~200ms) et focuse la fenêtre du dossier
 * pour les éditeurs — contrairement au CLI `code`/`cursor` qui démarre un pont lent.
 * @param {{pid:number, cwd:string}} session
 * @returns {{ok:boolean, action:string, app:string|null}}
 */
export function focusSession({ pid, cwd }) {
  if (process.platform !== "darwin") return { ok: false, action: "unsupported", app: null };
  const info = classify(ancestry(pid));

  if (info.kind === "editor") {
    // `open -a "VS Code" <cwd>` : VS Code focuse la fenêtre qui a déjà ce dossier ouvert.
    run("open", cwd ? ["-a", info.app, cwd] : ["-a", info.app]);
    return { ok: true, action: "editor", app: info.app };
  }
  if (info.kind === "terminal") {
    run("open", ["-a", info.app]);
    return { ok: true, action: "terminal", app: info.app };
  }
  // Repli : ouvrir le dossier dans le Finder.
  if (cwd) run("open", [cwd]);
  return { ok: false, action: "fallback", app: null };
}
