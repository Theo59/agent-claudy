// agent-claudy — AI agent visualizer server.
//
// Zero dependencies: native http + Server-Sent Events (SSE) to push agent
// state to the browser in real time.
//
//   - Agents (or demo mode) POST their state to  /api/agents/:id
//   - The browser subscribes to the SSE stream at /api/events
//   - Static files (UI) are served from           public/
//
// Run:  node server/server.js   (or  npm start)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDiscovery } from "./discover.js";
import { focusSession } from "./focus.js";
import * as config from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PUBLIC_DIR = join(ROOT, "public");
const PUBLIC_ROOT = resolve(PUBLIC_DIR); // canonical path for the anti path-traversal guard

// Port/host are read at boot (changing them requires a restart, surfaced in the UI).
// Other settings are re-read dynamically via config.get() at their point of use.
const PORT = config.get().port;
const HOST = config.get().host;

// Valid agent states.
const STATES = new Set(["working", "idle", "needs_input", "offline"]);

// ── Data ──────────────────────────────────────────────────────────────────────

/** "Manual" agents: demo mode + CLI bin/claudy-report.js (POST /api/agents/:id).
 *  @type {Map<string, {id:string,name:string,state:string,quote:string|null,request:string|null,updatedAt:number}>} */
const agents = new Map();

/** "needs_input" overlay set by the hook (POST /api/notify/:id), keyed by session id.
 *  Takes precedence over the auto-discovered state while active. @type {Map<string,{request:string|null,name:string|null,at:number}>} */
const overrides = new Map();

// Auto-discovery of Claude Code sessions. The timer always runs; scanOnce bails out
// on its own if the `discover` setting is disabled (applied live).
// As soon as a real session is discovered, we stop the demo (a simple empty-state fallback).
const discovery = createDiscovery({
  onChange: () => {
    if (demoTimer && discovery.list().length > 0) stopDemo();
    broadcast();
  },
});

// Anti-duplicate: mutes Claude Code's native notifications (and restores them). The
// `muteCc` setting decides WHEN we call on/off (boot, UI toggle, shutdown); the function
// itself always performs the requested action. Synchronous to guarantee restoration before exit.
function muteClaude(state /* "on" | "off" */) {
  if (process.platform !== "darwin") return;
  try {
    spawnSync(process.execPath, [join(ROOT, "bin", "claudy-mute-claude.js"), state], { stdio: "ignore" });
  } catch {
    /* unreadable settings: don't prevent the server from running */
  }
}

/** Connected SSE clients. @type {Set<http.ServerResponse>} */
const clients = new Set();

let QUOTES = ["Éducation minimum !"];
try {
  QUOTES = JSON.parse(await readFile(join(ROOT, "data", "quotes.json"), "utf8"));
} catch (err) {
  console.warn("[claudy] data/quotes.json illisible, citations par défaut :", err.message);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = () => Date.now();

// Safety net: a local visualizer should never go down over an isolated error.
process.on("unhandledRejection", (err) =>
  console.error("[claudy] rejet non géré :", err?.message || err),
);
process.on("uncaughtException", (err) =>
  console.error("[claudy] exception non capturée :", err?.message || err),
);

// Coerce a value to a non-empty string, else null. Avoids poisoning the Map
// (and the name-based sort) with an unexpected type sent by a client.
function asText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function overrideActive(o) {
  return o && now() - o.at < config.get().overrideTtlMs;
}

// Loopback host? (anti DNS-rebinding). Handles the port and IPv6 [::1].
function isLocalHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "[::1]";
}
// Loopback origin? (anti cross-site CSRF).
function isLocalOrigin(origin) {
  try {
    return isLocalHost(new URL(origin).host);
  } catch {
    return false;
  }
}
// Caps a Map by evicting the oldest entry (guards against memory blowup if a
// client posts thousands of distinct ids). `getAt` reads an entry's timestamp.
function capMap(map, max, getAt) {
  if (map.size < max) return;
  let oldestKey;
  let oldestAt = Infinity;
  for (const [k, v] of map) {
    const t = getAt(v) || 0;
    if (t < oldestAt) {
      oldestAt = t;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
}

// Merged view broadcast to the browser: auto-discovered sessions + manual agents
// (demo/CLI) + the hook's needs_input overlay laid over the same id.
function snapshot() {
  const cfg = config.get();
  const byId = new Map();

  // 1. Auto-discovered sessions (working / idle) + their swarm of sub-agents.
  for (const d of discovery.list()) {
    byId.set(d.id, {
      id: d.id,
      name: d.name,
      state: d.state,
      quote: null,
      request: null,
      children: d.children || [],
      childExtra: d.childExtra || 0,
      swarm: d.swarm || null,
      activity: d.activity || null,
      mode: d.mode || null,
      effort: d.effort || null,
      waitingFor: d.waitingFor || null,
      updatedAt: now(),
    });
  }

  // 2. Manual agents (demo + CLI) not present in discovery. Copied so we don't
  //    mutate the stored object when applying the overlay (step 3).
  for (const a of agents.values()) {
    if (!byId.has(a.id)) byId.set(a.id, { ...a });
  }

  // 3. The hook's needs_input overlay (purging expired entries along the way).
  for (const [id, o] of overrides) {
    if (!overrideActive(o)) {
      overrides.delete(id);
      continue;
    }
    const base = byId.get(id);
    if (base) {
      base.state = "needs_input";
      base.request = o.request || base.request || null;
    } else {
      // Hook without discovery (remote session, custom folder…): create the head.
      byId.set(id, { id, name: o.name || id, state: "needs_input", quote: null, request: o.request || null, updatedAt: now() });
    }
  }

  return {
    type: "agents",
    agents: [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "fr")),
    // Display prefs (server config): pushed with every snapshot so the frontend can
    // show/hide elements live (config.onChange triggers broadcast()).
    display: { bubble: cfg.showBubble, badges: cfg.showBadges, activity: cfg.showActivity, swarm: cfg.showSwarm },
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      console.warn("[claudy] client SSE perdu :", err?.message || err);
      clients.delete(res); // dead client: drop it rather than crash
    }
  }
}

/** Creates or updates an agent then broadcasts the state. */
function upsertAgent(id, patch = {}) {
  const existing = agents.get(id);
  const next = {
    id,
    name: asText(patch.name) ?? existing?.name ?? id,
    state: patch.state ?? existing?.state ?? "working",
    quote: asText(patch.quote) ?? existing?.quote ?? null,
    request: asText(patch.request) ?? existing?.request ?? null,
    children: patch.children ?? existing?.children ?? [],
    childExtra: patch.childExtra ?? existing?.childExtra ?? 0,
    swarm: patch.swarm ?? existing?.swarm ?? null,
    activity: patch.activity ?? existing?.activity ?? null,
    mode: patch.mode ?? existing?.mode ?? null,
    effort: patch.effort ?? existing?.effort ?? null,
    waitingFor: patch.waitingFor ?? existing?.waitingFor ?? null,
    updatedAt: now(),
  };
  if (!STATES.has(next.state)) next.state = "working";
  // A request without an explicit state implies needs_input.
  if (patch.request && !patch.state) next.state = "needs_input";
  // Leaving needs_input clears the request unless it is explicitly set again.
  if (next.state !== "needs_input" && patch.request === undefined) next.request = null;
  if (!existing) capMap(agents, 1000, (a) => a.updatedAt); // bound the manual agents
  agents.set(id, next);
  broadcast();
  return next;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("payload trop volumineux"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  // Robust anti path-traversal: resolve the canonical path and require it to stay
  // UNDER PUBLIC_ROOT (the "+ sep" prevents a sibling folder like "public-xxx" from passing).
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return sendJson(res, 400, { error: "requête invalide" });
  }
  const filePath = resolve(PUBLIC_ROOT, "." + (rel === "/" ? "/index.html" : rel));
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(PUBLIC_ROOT + sep)) {
    return sendJson(res, 403, { error: "interdit" });
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store", // local tool: always serve the latest version
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: "introuvable" });
  }
}

// ── Demo mode ───────────────────────────────────────────────────────────────────

let demoTimer = null;
const DEMO_NAMES = ["Claudy #1", "Claudy #2", "Claudy #3", "Le Poney", "L'Alien", "Le Câble"];

// Fake (workflow-style) swarm for the 1st demo head: it PROGRESSES (in-flight heads
// flip to done) instead of staying frozen — otherwise it looks like a stuck run.
const DEMO_SWARM = ["Explore", "blog-researcher", "code-review", "general-purpose", "blog-writer", "Explore", "code-review"];
// Tools cycled by the demo to illustrate the activity line (last tool used).
const DEMO_TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "WebFetch", "mcp__claude_ai_Linear__list_issues"];
const DEMO_FAILED_IDX = 4; // one head fails (to show the red status)
let demoProgress = 0; // number of heads already resolved (done/failed); the rest = working

function buildDemoSwarm() {
  const children = DEMO_SWARM.map((name, i) => {
    const status = i < demoProgress ? (i === DEMO_FAILED_IDX ? "failed" : "done") : "working";
    return { id: `demo-1-sub-${i}`, name, status, workflowId: "wf_demo" };
  });
  const count = (s) => children.filter((c) => c.status === s).length;
  return { children, swarm: { done: count("done"), failed: count("failed"), working: count("working"), total: children.length } };
}

function startDemo(count = 3) {
  stopDemo();
  const n = Math.min(Math.max(1, count | 0), DEMO_NAMES.length);
  for (let i = 0; i < n; i++) {
    upsertAgent(`demo-${i + 1}`, { name: DEMO_NAMES[i], state: "working" });
  }
  // 1st head: a "workflow-style" swarm that progresses (see buildDemoSwarm). It stays
  // WORKING so the "workflow in progress" context makes sense.
  demoProgress = 0;
  upsertAgent("demo-1", { state: "working", ...buildDemoSwarm() });

  // Drives the demo forward: demo-1's swarm advances by one step; the other heads cycle
  // through states to show the variety (working / idle / needs_input).
  demoTimer = setInterval(() => {
    try {
      // Guard: if a real session is present, the demo stops itself.
      if (discovery.list().length > 0) {
        stopDemo();
        return;
      }
      demoProgress = demoProgress >= DEMO_SWARM.length ? 0 : demoProgress + 1; // loop
      // demo-1 "works": its activity (tool) cycles to illustrate the activity line.
      const tool = DEMO_TOOLS[Math.floor(now() / 1500) % DEMO_TOOLS.length];
      upsertAgent("demo-1", {
        state: "working",
        activity: { tool, model: "claude-opus-4-8" },
        mode: "acceptEdits",
        effort: "ultracode", // showcase the ultracode badge
        ...buildDemoSwarm(),
      });
      for (let i = 1; i < n; i++) {
        const id = `demo-${i + 1}`;
        const roll = (i + Math.floor(now() / 1500)) % 10;
        if (roll === 3) {
          upsertAgent(id, {
            state: "needs_input",
            request: "Chef, ou tu sors ou j'te sors, mais faudra prendre une décision.",
            waitingFor: "dialog open", // illustrates the wait reason on hover
          });
        } else if (roll === 7) {
          upsertAgent(id, { state: "idle", mode: "plan", effort: "high" });
        } else {
          upsertAgent(id, {
            state: "working",
            quote: QUOTES[Math.floor(now() / 1500 + i * 3) % QUOTES.length],
            activity: { tool: DEMO_TOOLS[(i + Math.floor(now() / 1500)) % DEMO_TOOLS.length], model: "claude-opus-4-8" },
          });
        }
      }
    } catch (err) {
      console.error("[claudy] erreur du mode démo :", err?.message || err);
    }
  }, 1500);
  return n;
}

function stopDemo() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  for (const id of [...agents.keys()]) {
    if (id.startsWith("demo-")) agents.delete(id);
  }
  broadcast();
}

// ── Routing ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const origin = req.headers.origin;

  // Anti DNS-rebinding: only loopback hosts are accepted. A site that "rebinds"
  // its domain to 127.0.0.1 sends a non-local Host → rejected right away.
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403);
    return res.end();
  }

  // Restricted CORS: we ONLY reflect loopback origins (never "*"). Scripts/CLI
  // (curl, hook, menubar app) don't send an Origin → not affected.
  if (origin && isLocalOrigin(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Anti-CSRF: a cross-origin browser request (Origin present and NON-local) is
  // refused — including the "simple requests" that bypass the CORS preflight.
  if (origin && !isLocalOrigin(origin)) {
    return sendJson(res, 403, { error: "origine non autorisée" });
  }

  // Host validated above → safe URL parsing.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return sendJson(res, 400, { error: "requête invalide" });
  }
  const path = url.pathname;

  try {
    // Real-time SSE stream.
    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      ping.unref?.(); // doesn't keep the process alive → clean shutdown possible
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (path === "/api/quotes" && method === "GET") {
      return sendJson(res, 200, { quotes: QUOTES });
    }

    if (path === "/api/agents" && method === "GET") {
      return sendJson(res, 200, snapshot());
    }

    // Configuration: GET returns schema + values + keys locked by the env;
    // PUT applies a patch (writes ~/.config/claudy/config.json, applied live).
    if (path === "/api/config") {
      if (method === "GET") return sendJson(res, 200, config.meta());
      if (method === "PUT" || method === "POST") {
        const body = await readBody(req);
        const updated = await config.save(body);
        return sendJson(res, 200, updated);
      }
    }

    // Demo: POST /api/demo  { action: "start"|"stop", count?: number }
    if (path === "/api/demo" && method === "POST") {
      const body = await readBody(req);
      if (body.action === "stop") {
        stopDemo();
        return sendJson(res, 200, { ok: true, demo: false });
      }
      const count = startDemo(body.count ?? 3);
      return sendJson(res, 200, { ok: true, demo: true, count });
    }

    // The hook's needs_input overlay: /api/notify/:id
    //   POST { request?, name? }  → raises the red alert
    //   POST { clear:true } | DELETE → clears it
    const notifyMatch = path.match(/^\/api\/notify\/([^/]+)$/);
    if (notifyMatch && (method === "POST" || method === "DELETE")) {
      const id = decodeURIComponent(notifyMatch[1]);
      const body = method === "POST" ? await readBody(req) : {};
      if (method === "DELETE" || body.clear) {
        overrides.delete(id);
      } else {
        const request = asText(body.request);
        const name = asText(body.name);
        if (!overrides.has(id)) capMap(overrides, 2000, (o) => o.at); // bound the alerts
        overrides.set(id, { request, name, at: now() });
        // Refreshes the display when the TTL expires even without another event.
        setTimeout(() => broadcast(), config.get().overrideTtlMs).unref?.();
        // Native notifications are emitted by the menubar app (UserNotifications):
        // it can route the click to the right session and carry the logo, which osascript
        // (attributed to "Script Editor") could not do.
      }
      broadcast();
      return sendJson(res, 200, { ok: true });
    }

    // Jump to the agent's window: /api/focus/:id (activates VS Code/terminal/…)
    const focusMatch = path.match(/^\/api\/focus\/([^/]+)$/);
    if (focusMatch && method === "POST") {
      const id = decodeURIComponent(focusMatch[1]);
      const sess = discovery.list().find((d) => d.id === id);
      if (!sess || !sess.pid) {
        return sendJson(res, 404, { ok: false, error: "session non découverte (pas de fenêtre liée)" });
      }
      let result = { ok: false, action: "error", app: null };
      try {
        result = focusSession({ pid: sess.pid, cwd: sess.cwd });
      } catch (err) {
        result = { ok: false, action: "error", app: null, error: err.message };
      }
      return sendJson(res, 200, result);
    }

    // Single agent: /api/agents/:id
    const match = path.match(/^\/api\/agents\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "POST") {
        const body = await readBody(req);
        const agent = upsertAgent(id, {
          name: body.name,
          state: body.state,
          quote: body.quote,
          request: body.request,
        });
        return sendJson(res, 200, { ok: true, agent });
      }
      if (method === "DELETE") {
        agents.delete(id);
        broadcast();
        return sendJson(res, 200, { ok: true });
      }
    }

    // Otherwise: static files.
    if (method === "GET") return serveStatic(res, path);

    sendJson(res, 405, { error: "méthode non autorisée" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

// Applies settings changed via the UI live (PUT /api/config). Discovery reconfigures
// itself (it re-reads config.get() on every scan); here we handle the server-side
// side effects: muting/unmuting Claude Code's notifications, and re-broadcasting the state.
config.setOnChange((changed) => {
  if (changed.includes("muteCc")) muteClaude(config.get().muteCc ? "on" : "off");
  broadcast();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  👓  agent-claudy en écoute sur  http://${HOST}:${PORT}\n`);
  // The timer always runs; scanOnce honors the `discover` setting live.
  discovery.start();
  console.log(`  🔎  Auto-découverte des sessions Claude Code ${config.get().discover ? "activée" : "en veille (réglage discover off)"}.`);
  console.log(`  ⚙  Réglages : ${config.CONFIG_PATH}`);
  if (config.get().muteCc) {
    muteClaude("on");
    console.log(`  🔕  Notifs natives de Claude Code coupées (anti-doublon) le temps de la session.`);
  }
  console.log(`  Ouvre cette URL dans ton navigateur.\n`);
});

// Restores Claude Code's notifications on a clean server shutdown.
function shutdown() {
  muteClaude("off");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
