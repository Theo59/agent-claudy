// agent-claudy — "jump to the agent's window".
//
// Starting from a Claude Code session's PID, we walk up the process tree to
// figure out WHO is hosting it (VS Code / Cursor editor, terminal, other) and then
// bring the right window to the front:
//   - editor: `code <cwd>` / `cursor <cwd>` brings the folder's window to the
//     foreground (opening it if needed), plus activating the app;
//   - terminal: we activate the terminal app;
//   - otherwise: we open the folder in Finder (fallback).
//
// macOS only (osascript / open). Zero dependencies.

import { spawn, spawnSync } from "node:child_process";

// One step up the tree: ppid + full path of the executable (ps -o comm= gives the path).
function procInfo(pid) {
  const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.trim().match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), comm: m[2] };
}

// Walks up to launchd (pid 1); returns the list of executables traversed.
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

// Runs a command without blocking (immediate HTTP response; activation follows ~200ms later).
function run(cmd, args) {
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    /* we never crash the server over a focus attempt */
  }
}

/**
 * Brings the window hosting the session to the foreground.
 * Via `open -a` (LaunchServices): fast (~200ms) and focuses the folder's window
 * for editors — unlike the `code`/`cursor` CLI, which spins up a slow bridge.
 * @param {{pid:number, cwd:string}} session
 * @returns {{ok:boolean, action:string, app:string|null}}
 */
export function focusSession({ pid, cwd }) {
  if (process.platform !== "darwin") return { ok: false, action: "unsupported", app: null };
  const info = classify(ancestry(pid));

  if (info.kind === "editor") {
    // Sans chemin : active la fenêtre existante sans en ouvrir une nouvelle.
    // Passer cwd peut créer une nouvelle fenêtre si le dossier ne correspond pas au workspace root.
    run("open", ["-a", info.app]);
    return { ok: true, action: "editor", app: info.app };
  }
  if (info.kind === "terminal") {
    run("open", ["-a", info.app]);
    return { ok: true, action: "terminal", app: info.app };
  }
  // Fallback: open the folder in Finder.
  if (cwd) run("open", [cwd]);
  return { ok: false, action: "fallback", app: null };
}
