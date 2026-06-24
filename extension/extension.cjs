// agent-claudy VS Code extension.
//
// Embeds the visualizer directly in the editor:
//   - starts the local server (server/server.js) in the background (or reuses
//     a server already running on the configured port);
//   - shows the Claudy heads in an activity-bar panel (webview pointing to the
//     UI served by the server);
//   - summarizes the agents' state in the status bar (orange when one is asking);
//   - provides handy commands, including installing the Claude Code hooks.
//
// Written in CommonJS (.cjs) because the package root is "type":"module" (ESM server).

const vscode = require("vscode");
const cp = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Hybrid mode: the hook only handles the red needs_input alert. Notification sets
// it; the other events clear it. working/idle/offline = auto-discovery.
const HOOK_EVENTS = ["Notification", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"];

let serverProc = null;
let ownsServer = false;
let output = null;
let statusItem = null;
let pollTimer = null;
let provider = null;
let demoOn = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = () => vscode.workspace.getConfiguration("agentClaudy");
const getPort = () => cfg().get("port", 4310);
const baseUrl = () => `http://127.0.0.1:${getPort()}`;

// ── Small HTTP client (native http, robust whatever the host's Node version) ──

function httpJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      baseUrl() + pathname,
      {
        method,
        timeout: 1500,
        headers: data
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null });
          } catch {
            resolve({ status: res.statusCode, json: null });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

async function probe() {
  try {
    const r = await httpJson("GET", "/api/agents");
    return r.status === 200;
  } catch {
    return false;
  }
}

// ── Server management ────────────────────────────────────────────────────────

async function startServer(context) {
  if (await probe()) {
    ownsServer = false;
    output.appendLine(`[claudy] serveur déjà actif sur ${baseUrl()} — réutilisé.`);
    return true;
  }
  const serverPath = path.join(context.extensionPath, "server", "server.js");
  // process.execPath = the editor's binary; ELECTRON_RUN_AS_NODE makes it run as Node.
  serverProc = cp.spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CLAUDY_PORT: String(getPort()),
      CLAUDY_HOST: "127.0.0.1",
    },
  });
  ownsServer = true;
  serverProc.stdout.on("data", (d) => output.append(d.toString()));
  serverProc.stderr.on("data", (d) => output.append(d.toString()));
  serverProc.on("exit", (code) => {
    output.appendLine(`[claudy] serveur arrêté (code ${code}).`);
    serverProc = null;
  });

  for (let i = 0; i < 30; i++) {
    if (await probe()) return true;
    await delay(200);
  }
  return probe();
}

function stopServer() {
  if (serverProc && ownsServer) {
    serverProc.kill();
    serverProc = null;
  }
}

// ── Webview panel (iframe to the server's UI) ──────────────────────────────────

class ClaudyViewProvider {
  constructor() {
    this.view = null;
  }
  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    await this.render();
  }
  async render() {
    if (!this.view) return;
    const ext = await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl()));
    const src = ext.toString();
    const origin = `${ext.scheme}://${ext.authority}`;
    // CSP: we allow ONLY the iframe origin + localhost on the configured PORT
    // (instead of http://127.0.0.1:* which opened any local port).
    const port = new URL(baseUrl()).port || "4310";
    this.view.webview.html = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin} http://127.0.0.1:${port} http://localhost:${port}; style-src 'unsafe-inline';" />
<style>html,body{margin:0;padding:0;height:100%;background:#14110d}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body><iframe src="${src}" title="agent-claudy"></iframe></body></html>`;
  }
}

// ── Status bar ──────────────────────────────────────────────────────────────

async function updateStatus() {
  if (!statusItem) return;
  try {
    const r = await httpJson("GET", "/api/agents");
    if (r.status !== 200 || !r.json) throw new Error("hs");
    const agents = r.json.agents || [];
    const c = { working: 0, idle: 0, needs_input: 0, offline: 0 };
    for (const a of agents) c[a.state] = (c[a.state] || 0) + 1;
    const parts = [];
    if (c.working) parts.push(`${c.working}▶`);
    if (c.idle) parts.push(`${c.idle}⏳`);
    if (c.needs_input) parts.push(`${c.needs_input}⁉`);
    statusItem.text = `$(megaphone) Claudy ${agents.length ? parts.join(" ") : "·"}`;
    if (c.needs_input) {
      statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      statusItem.tooltip = `${c.needs_input} agent(s) réclament ton attention — clic pour ouvrir`;
    } else {
      statusItem.backgroundColor = undefined;
      statusItem.tooltip = `agent-claudy : ${agents.length} agent(s) — clic pour ouvrir`;
    }
  } catch {
    statusItem.text = "$(megaphone) Claudy $(circle-slash)";
    statusItem.backgroundColor = undefined;
    statusItem.tooltip = "agent-claudy : serveur arrêté — clic pour ouvrir";
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function toggleDemo() {
  demoOn = !demoOn;
  try {
    await httpJson("POST", "/api/demo", demoOn ? { action: "start", count: 3 } : { action: "stop" });
    vscode.window.setStatusBarMessage(
      demoOn ? "agent-claudy : démo démarrée" : "agent-claudy : démo arrêtée",
      2000,
    );
  } catch (e) {
    demoOn = !demoOn;
    vscode.window.showErrorMessage(`agent-claudy : serveur injoignable (${e.message}).`);
  }
}

async function reportState() {
  const id = await vscode.window.showInputBox({
    prompt: "Identifiant de l'agent",
    value: "agent-1",
  });
  if (!id) return;
  const pick = await vscode.window.showQuickPick(
    [
      { label: "working", description: "travaille (parle + cite Claudy)" },
      { label: "idle", description: "en attente / a fini" },
      { label: "needs_input", description: "réclame ton attention" },
      { label: "offline", description: "hors ligne" },
    ],
    { placeHolder: "État de l'agent" },
  );
  if (!pick) return;
  const body = { state: pick.label };
  if (pick.label === "needs_input") {
    body.request = await vscode.window.showInputBox({ prompt: "Demande à afficher (optionnel)" });
  }
  try {
    await httpJson("POST", `/api/agents/${encodeURIComponent(id)}`, body);
  } catch (e) {
    vscode.window.showErrorMessage(`agent-claudy : impossible de joindre le serveur (${e.message}).`);
  }
}

async function installHooks(context) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const choice = await vscode.window.showWarningMessage(
    `Installer les hooks agent-claudy dans ${settingsPath} ? Une sauvegarde .bak sera créée.`,
    { modal: true },
    "Installer",
  );
  if (choice !== "Installer") return;

  let settings = {};
  let raw = null;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    raw = null; // file missing: we'll create it
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      vscode.window.showErrorMessage(
        `agent-claudy : ${settingsPath} n'est pas du JSON valide — installation annulée pour ne pas l'écraser.`,
      );
      return;
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      vscode.window.showErrorMessage(
        `agent-claudy : ${settingsPath} n'a pas la forme attendue (objet JSON) — installation annulée.`,
      );
      return;
    }
    // Back up the raw ORIGINAL content (never a reconstruction) before writing.
    fs.writeFileSync(settingsPath + ".bak", raw);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const hookPath = path.join(context.extensionPath, "bin", "claudy-hook.js");
  // Command run by Claude Code in a shell: we rely on `node` from PATH and inject
  // the URL to follow the configured port.
  const command = `CLAUDY_URL=${baseUrl()} node "${hookPath}"`;

  settings.hooks = settings.hooks || {};
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Idempotent: remove any previous claudy entries before adding.
    const cleaned = list.filter(
      (entry) =>
        !(entry.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("claudy-hook")),
    );
    cleaned.push({ hooks: [{ type: "command", command }] });
    settings.hooks[event] = cleaned;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  const open = await vscode.window.showInformationMessage(
    "Hooks agent-claudy installés. Redémarre tes sessions Claude Code pour les activer.",
    "Ouvrir settings.json",
  );
  if (open === "Ouvrir settings.json") {
    vscode.window.showTextDocument(await vscode.workspace.openTextDocument(settingsPath));
  }
}

// ── Activation ──────────────────────────────────────────────────────────────

function activate(context) {
  output = vscode.window.createOutputChannel("agent-claudy");
  context.subscriptions.push(output);

  provider = new ClaudyViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentClaudy.panel", provider),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "agentClaudy.open";
  statusItem.text = "$(megaphone) Claudy";
  statusItem.show();
  context.subscriptions.push(statusItem);

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("agentClaudy.open", () => vscode.commands.executeCommand("agentClaudy.panel.focus"));
  reg("agentClaudy.openInBrowser", async () =>
    vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl()))),
  );
  reg("agentClaudy.restartServer", async () => {
    stopServer();
    await delay(300);
    const ok = await startServer(context);
    if (provider) await provider.render();
    vscode.window.setStatusBarMessage(
      ok ? "agent-claudy : serveur redémarré" : "agent-claudy : échec du démarrage",
      2500,
    );
  });
  reg("agentClaudy.toggleDemo", toggleDemo);
  reg("agentClaudy.reportState", reportState);
  reg("agentClaudy.installHooks", () => installHooks(context));

  (async () => {
    if (cfg().get("autoStartServer", true)) {
      const ok = await startServer(context);
      if (ok && provider) await provider.render();
      if (ok && cfg().get("autoStartDemo", false)) {
        demoOn = true;
        await httpJson("POST", "/api/demo", { action: "start", count: 3 }).catch(() => {});
      }
    }
    updateStatus();
  })();

  pollTimer = setInterval(updateStatus, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
