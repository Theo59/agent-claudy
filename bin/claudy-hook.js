#!/usr/bin/env node
// claudy-hook — bridge between Claude Code hooks and the agent-claudy server.
//
// Hybrid mode: the server's auto-discovery (reading ~/.claude/sessions) handles
// working / idle / offline on its own. This hook therefore deals ONLY with the
// red "needs_input" alert:
//
//   Notification                                   → SETS the alert (the agent wants you)
//   UserPromptSubmit / PreToolUse / Stop / SessionEnd → CLEARS the alert (you're back in control)
//
// It NEVER blocks Claude (always exits with code 0).

// Security: the hook is launched AUTOMATICALLY by Claude Code. We therefore only
// allow LOCAL targets for CLAUDY_URL → if the variable is hijacked, we don't POST
// the state elsewhere (no exfiltration). Any non-local value falls back to the default.
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
    // If nothing arrives (hook run manually), don't block indefinitely.
    setTimeout(() => resolve(data), 500);
  });
}

async function main() {
  // Absolute safeguard: whatever happens (stdin hanging, slow fetch…),
  // the hook terminates and never freezes the Claude Code session.
  setTimeout(() => process.exit(0), 2000).unref();

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    /* JSON missing/unreadable: carry on with the default values */
  }

  const event = payload.hook_event_name || process.argv[2] || "";

  // Stable per-session id, IDENTICAL to the one from auto-discovery (server/discover.js)
  // so the alert lands on the right head. Sub-agents share the session.
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
    process.exit(0); // event not relevant to the red alert
  }

  const base = localBase(process.env.CLAUDY_URL);
  try {
    await fetch(`${base.replace(/\/$/, "")}/api/notify/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // If the port is held by a silent process, don't wait indefinitely.
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* server down: never mind, we don't break Claude */
  }
  process.exit(0);
}

main();
