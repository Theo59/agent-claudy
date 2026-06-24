#!/usr/bin/env node
// claudy-hook — pont entre les hooks de Claude Code et le serveur agent-claudy.
//
// Mode hybride : l'auto-découverte du serveur (lecture de ~/.claude/sessions)
// gère working / idle / offline toute seule. Ce hook ne s'occupe donc QUE de
// l'alerte rouge « needs_input » :
//
//   Notification                                   → POSE l'alerte (l'agent te réclame)
//   UserPromptSubmit / PreToolUse / Stop / SessionEnd → LÈVE l'alerte (tu as repris la main)
//
// Il ne bloque JAMAIS Claude (sort toujours en code 0).

// Sécurité : le hook est lancé AUTOMATIQUEMENT par Claude Code. On n'autorise donc
// que des cibles LOCALES pour CLAUDY_URL → si la variable est détournée, on ne POST
// pas l'état ailleurs (pas d'exfiltration). Toute valeur non-locale retombe sur le défaut.
const DEFAULT_URL = "http://127.0.0.1:4310";
function localBase(raw) {
  if (!raw) return DEFAULT_URL;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    return (u.protocol === "http:" || u.protocol === "https:") && local ? raw : DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

const SET_EVENTS = new Set(["Notification"]);
const CLEAR_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // Si rien n'arrive (hook lancé à la main), on ne bloque pas indéfiniment.
    setTimeout(() => resolve(data), 500);
  });
}

async function main() {
  // Garde-fou absolu : quoi qu'il arrive (stdin qui pend, fetch lent…),
  // le hook se termine et ne gèle jamais la session Claude Code.
  setTimeout(() => process.exit(0), 2000).unref();

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    /* JSON absent/illisible : on continue avec les valeurs par défaut */
  }

  const event = payload.hook_event_name || process.argv[2] || "";

  // Id stable par session, IDENTIQUE à celui de l'auto-découverte (server/discover.js)
  // pour que l'alerte se pose sur la bonne tête. Les sous-agents partagent la session.
  const sessionId = payload.session_id || "claude";
  const id = `cc-${String(sessionId).slice(0, 8)}`;

  let body;
  if (SET_EVENTS.has(event)) {
    const cwd = payload.cwd || process.cwd();
    const project = cwd.split("/").filter(Boolean).pop() || "claude";
    body = { request: payload.message || "L'agent réclame ton attention.", name: project };
  } else if (CLEAR_EVENTS.has(event)) {
    body = { clear: true };
  } else {
    process.exit(0); // événement non pertinent pour l'alerte rouge
  }

  const base = localBase(process.env.CLAUDY_URL);
  try {
    await fetch(`${base.replace(/\/$/, "")}/api/notify/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Si le port est occupé par un process muet, on n'attend pas indéfiniment.
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* serveur éteint : tant pis, on ne casse pas Claude */
  }
  process.exit(0);
}

main();
