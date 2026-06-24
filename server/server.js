// agent-claudy — serveur de visualisation d'agents IA.
//
// Zéro dépendance : http natif + Server-Sent Events (SSE) pour pousser l'état
// des agents vers le navigateur en temps réel.
//
//   - Les agents (ou le mode démo) POSTent leur état sur  /api/agents/:id
//   - Le navigateur s'abonne au flux SSE sur             /api/events
//   - Les fichiers statiques (UI) sont servis depuis      public/
//
// Lancement :  node server/server.js   (ou  npm start)

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
const PUBLIC_ROOT = resolve(PUBLIC_DIR); // chemin canonique pour la garde anti path-traversal

// Port/hôte sont lus au boot (un changement exige un redémarrage, signalé dans l'UI).
// Les autres réglages sont relus dynamiquement via config.get() à leur point d'usage.
const PORT = config.get().port;
const HOST = config.get().host;

// États valides d'un agent.
const STATES = new Set(["working", "idle", "needs_input", "offline"]);

// ── Données ─────────────────────────────────────────────────────────────────

/** Agents « manuels » : mode démo + CLI bin/claudy-report.js (POST /api/agents/:id).
 *  @type {Map<string, {id:string,name:string,state:string,quote:string|null,request:string|null,updatedAt:number}>} */
const agents = new Map();

/** Overlay « needs_input » posé par le hook (POST /api/notify/:id), par id de session.
 *  Prend le pas sur l'état auto-découvert tant qu'il est actif. @type {Map<string,{request:string|null,name:string|null,at:number}>} */
const overrides = new Map();

// Auto-découverte des sessions Claude Code. Le timer tourne toujours ; scanOnce se
// coupe tout seul si le réglage `discover` est désactivé (application à chaud).
// Dès qu'une vraie session est découverte, on coupe la démo (simple repli d'état vide).
const discovery = createDiscovery({
  onChange: () => {
    if (demoTimer && discovery.list().length > 0) stopDemo();
    broadcast();
  },
});

// Anti-doublon : coupe les notifs natives de Claude Code (et les restaure). Le réglage
// `muteCc` décide QUAND on appelle on/off (boot, bascule UI, arrêt) ; la fonction, elle,
// applique toujours l'action demandée. Synchrone pour garantir la restauration avant exit.
function muteClaude(state /* "on" | "off" */) {
  if (process.platform !== "darwin") return;
  try {
    spawnSync(process.execPath, [join(ROOT, "bin", "claudy-mute-claude.js"), state], { stdio: "ignore" });
  } catch {
    /* réglages illisibles : on n'empêche pas le serveur de tourner */
  }
}

/** Clients SSE connectés. @type {Set<http.ServerResponse>} */
const clients = new Set();

let QUOTES = ["Éducation minimum !"];
try {
  QUOTES = JSON.parse(await readFile(join(ROOT, "data", "quotes.json"), "utf8"));
} catch (err) {
  console.warn("[claudy] data/quotes.json illisible, citations par défaut :", err.message);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = () => Date.now();

// Filet de sécurité : un visualiseur local ne doit jamais tomber sur une erreur isolée.
process.on("unhandledRejection", (err) =>
  console.error("[claudy] rejet non géré :", err?.message || err),
);
process.on("uncaughtException", (err) =>
  console.error("[claudy] exception non capturée :", err?.message || err),
);

// Force une valeur en string non vide, sinon null. Évite d'empoisonner la Map
// (et le tri par nom) avec un type inattendu envoyé par un client.
function asText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function overrideActive(o) {
  return o && now() - o.at < config.get().overrideTtlMs;
}

// Hôte loopback ? (anti DNS-rebinding). Gère le port et IPv6 [::1].
function isLocalHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "[::1]";
}
// Origine loopback ? (anti-CSRF cross-site).
function isLocalOrigin(origin) {
  try {
    return isLocalHost(new URL(origin).host);
  } catch {
    return false;
  }
}
// Plafonne une Map en évinçant l'entrée la plus ancienne (anti-saturation mémoire si un
// client poste des milliers d'ids différents). `getAt` lit l'horodatage d'une entrée.
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

// Vue fusionnée diffusée au navigateur : sessions auto-découvertes + agents manuels
// (démo/CLI) + overlay needs_input du hook posé par-dessus le même id.
function snapshot() {
  const byId = new Map();

  // 1. Sessions auto-découvertes (working / idle) + leur essaim de sous-agents.
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
      waitingFor: d.waitingFor || null,
      updatedAt: now(),
    });
  }

  // 2. Agents manuels (démo + CLI) absents de la découverte. Copie pour ne pas
  //    muter l'objet stocké lors de l'application de l'overlay (étape 3).
  for (const a of agents.values()) {
    if (!byId.has(a.id)) byId.set(a.id, { ...a });
  }

  // 3. Overlay needs_input du hook (purge des entrées expirées au passage).
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
      // Hook sans découverte (session distante, dossier custom…) : on crée la tête.
      byId.set(id, { id, name: o.name || id, state: "needs_input", quote: null, request: o.request || null, updatedAt: now() });
    }
  }

  return {
    type: "agents",
    agents: [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "fr")),
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      console.warn("[claudy] client SSE perdu :", err?.message || err);
      clients.delete(res); // client mort : on le purge plutôt que de planter
    }
  }
}

/** Crée ou met à jour un agent puis diffuse l'état. */
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
    waitingFor: patch.waitingFor ?? existing?.waitingFor ?? null,
    updatedAt: now(),
  };
  if (!STATES.has(next.state)) next.state = "working";
  // Une demande sans état explicite implique needs_input.
  if (patch.request && !patch.state) next.state = "needs_input";
  // Quitter needs_input efface la demande sauf si on la repasse explicitement.
  if (next.state !== "needs_input" && patch.request === undefined) next.request = null;
  if (!existing) capMap(agents, 1000, (a) => a.updatedAt); // borne les agents manuels
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
  // Anti path-traversal robuste : on résout le chemin canonique et on exige qu'il
  // reste SOUS PUBLIC_ROOT (le « + sep » évite qu'un dossier voisin « public-xxx » passe).
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
      "cache-control": "no-store", // outil local : toujours servir la dernière version
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: "introuvable" });
  }
}

// ── Mode démo ─────────────────────────────────────────────────────────────────

let demoTimer = null;
const DEMO_NAMES = ["Claudy #1", "Claudy #2", "Claudy #3", "Le Poney", "L'Alien", "Le Câble"];

// Essaim factice (façon workflow) de la 1ère tête démo : il PROGRESSE (les têtes en
// cours passent à terminé) au lieu de rester figé — sinon il ressemble à un run bloqué.
const DEMO_SWARM = ["Explore", "blog-researcher", "code-review", "general-purpose", "blog-writer", "Explore", "code-review"];
// Outils cyclés par la démo pour illustrer la ligne d'activité (dernier outil utilisé).
const DEMO_TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "WebFetch", "mcp__claude_ai_Linear__list_issues"];
const DEMO_FAILED_IDX = 4; // une tête échoue (pour montrer le statut rouge)
let demoProgress = 0; // nombre de têtes déjà résolues (done/failed) ; le reste = working

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
  // 1ère tête : essaim « façon workflow » qui progresse (cf. buildDemoSwarm). Elle reste
  // EN TRAVAIL pour que le contexte « workflow en cours » ait du sens.
  demoProgress = 0;
  upsertAgent("demo-1", { state: "working", ...buildDemoSwarm() });

  // Fait évoluer la démo : l'essaim de demo-1 avance d'un cran ; les autres têtes cyclent
  // entre les états pour montrer la variété (working / idle / needs_input).
  demoTimer = setInterval(() => {
    try {
      // Garde-fou : si une vraie session est présente, la démo se coupe d'elle-même.
      if (discovery.list().length > 0) {
        stopDemo();
        return;
      }
      demoProgress = demoProgress >= DEMO_SWARM.length ? 0 : demoProgress + 1; // boucle
      // demo-1 « travaille » : son activité (outil) cycle pour illustrer la ligne d'activité.
      const tool = DEMO_TOOLS[Math.floor(now() / 1500) % DEMO_TOOLS.length];
      upsertAgent("demo-1", {
        state: "working",
        activity: { tool, model: "claude-opus-4-8" },
        ...buildDemoSwarm(),
      });
      for (let i = 1; i < n; i++) {
        const id = `demo-${i + 1}`;
        const roll = (i + Math.floor(now() / 1500)) % 10;
        if (roll === 3) {
          upsertAgent(id, {
            state: "needs_input",
            request: "Chef, ou tu sors ou j'te sors, mais faudra prendre une décision.",
            waitingFor: "dialog open", // illustre la raison d'attente au survol
          });
        } else if (roll === 7) {
          upsertAgent(id, { state: "idle" });
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

// ── Routage ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const origin = req.headers.origin;

  // Anti DNS-rebinding : on n'accepte que les hôtes loopback. Un site qui « rebind »
  // son domaine vers 127.0.0.1 envoie un Host non-local → rejeté d'emblée.
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403);
    return res.end();
  }

  // CORS restreint : on ne reflète QUE des origines loopback (jamais « * »). Les
  // scripts/CLI (curl, hook, app menubar) n'envoient pas d'Origin → non concernés.
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

  // Anti-CSRF : une requête de navigateur cross-origin (Origin présent et NON-local) est
  // refusée — y compris les « simple requests » qui échappent au préflight CORS.
  if (origin && !isLocalOrigin(origin)) {
    return sendJson(res, 403, { error: "origine non autorisée" });
  }

  // Host validé ci-dessus → parsing d'URL sûr.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return sendJson(res, 400, { error: "requête invalide" });
  }
  const path = url.pathname;

  try {
    // Flux SSE temps réel.
    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      ping.unref?.(); // ne maintient pas le process en vie → arrêt propre possible
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

    // Configuration : GET renvoie schéma + valeurs + clés verrouillées par l'env ;
    // PUT applique un patch (écrit ~/.config/claudy/config.json, applique à chaud).
    if (path === "/api/config") {
      if (method === "GET") return sendJson(res, 200, config.meta());
      if (method === "PUT" || method === "POST") {
        const body = await readBody(req);
        const updated = await config.save(body);
        return sendJson(res, 200, updated);
      }
    }

    // Démo : POST /api/demo  { action: "start"|"stop", count?: number }
    if (path === "/api/demo" && method === "POST") {
      const body = await readBody(req);
      if (body.action === "stop") {
        stopDemo();
        return sendJson(res, 200, { ok: true, demo: false });
      }
      const count = startDemo(body.count ?? 3);
      return sendJson(res, 200, { ok: true, demo: true, count });
    }

    // Overlay needs_input du hook : /api/notify/:id
    //   POST { request?, name? }  → pose l'alerte rouge
    //   POST { clear:true } | DELETE → la lève
    const notifyMatch = path.match(/^\/api\/notify\/([^/]+)$/);
    if (notifyMatch && (method === "POST" || method === "DELETE")) {
      const id = decodeURIComponent(notifyMatch[1]);
      const body = method === "POST" ? await readBody(req) : {};
      if (method === "DELETE" || body.clear) {
        overrides.delete(id);
      } else {
        const request = asText(body.request);
        const name = asText(body.name);
        if (!overrides.has(id)) capMap(overrides, 2000, (o) => o.at); // borne les alertes
        overrides.set(id, { request, name, at: now() });
        // Rafraîchit l'affichage à l'expiration du TTL même sans autre événement.
        setTimeout(() => broadcast(), config.get().overrideTtlMs).unref?.();
        // Les notifications natives sont émises par l'app menubar (UserNotifications) :
        // elle peut router le clic vers la bonne session et porter le logo, ce qu'osascript
        // (attribué à « Éditeur de script ») ne permettait pas.
      }
      broadcast();
      return sendJson(res, 200, { ok: true });
    }

    // Aller à la fenêtre de l'agent : /api/focus/:id (active VS Code/terminal/…)
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

    // Agent individuel : /api/agents/:id
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

    // Sinon : fichiers statiques.
    if (method === "GET") return serveStatic(res, path);

    sendJson(res, 405, { error: "méthode non autorisée" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

// Applique à chaud les réglages changés via l'UI (PUT /api/config). La découverte se
// reconfigure seule (elle relit config.get() à chaque scan) ; ici on gère les effets
// de bord du serveur : (dé)couper les notifs Claude Code, et rediffuser l'état.
config.setOnChange((changed) => {
  if (changed.includes("muteCc")) muteClaude(config.get().muteCc ? "on" : "off");
  broadcast();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  👓  agent-claudy en écoute sur  http://${HOST}:${PORT}\n`);
  // Le timer tourne toujours ; scanOnce respecte le réglage `discover` à chaud.
  discovery.start();
  console.log(`  🔎  Auto-découverte des sessions Claude Code ${config.get().discover ? "activée" : "en veille (réglage discover off)"}.`);
  console.log(`  ⚙  Réglages : ${config.CONFIG_PATH}`);
  if (config.get().muteCc) {
    muteClaude("on");
    console.log(`  🔕  Notifs natives de Claude Code coupées (anti-doublon) le temps de la session.`);
  }
  console.log(`  Ouvre cette URL dans ton navigateur.\n`);
});

// Restaure les notifs de Claude Code à l'arrêt propre du serveur.
function shutdown() {
  muteClaude("off");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
