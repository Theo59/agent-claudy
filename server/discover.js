// agent-claudy — auto-découverte des sessions Claude Code.
//
// Claude Code tient un registre des sessions dans  ~/.claude/sessions/<PID>.json
// (un fichier par session, mis à jour en continu) :
//   { pid, sessionId, cwd, status: "busy"|"idle"|"waiting", waitingFor?, version, name?, ... }
//
// Ce module lit ce dossier périodiquement, ne garde que les sessions dont le PID
// est encore vivant, et expose la liste au serveur. Zéro dépendance (fs/os natifs).
//
//   busy → working   |   waiting → needs_input   |   idle → idle   |   PID mort → tête retirée
//
// Activité courante : pour une session active, on lit la QUEUE du transcript
// (~/.claude/projects/<cwd encodé>/<sessionId>.jsonl) pour en extraire le dernier
// outil utilisé + le modèle, mémoïsés par mtime (cf. latestActivity).
//
// Sous-agents (essaim) : pour chaque session vivante en travail, Claude Code écrit
// un transcript par sous-agent dans
//   ~/.claude/projects/<cwd encodé>/<sessionId>/subagents/agent-<id>.jsonl
// (et, pour les workflows, …/subagents/workflows/wf_<id>/agent-<id>.jsonl).
// Un fichier au mtime frais = sous-agent encore actif ; figé = terminé. Le type
// d'agent (ex. "Explore", "claude-code-guide") se lit via "attributionAgent" dans
// le fichier, sans relire le (gros) transcript parent.
//
// Tous les réglages (dossiers, cadence, sous-agents, masquage…) viennent désormais
// de la couche de config centrale (server/config.js) et s'appliquent À CHAUD : on les
// relit à chaque scan plutôt que de les figer au chargement.

import { readdir, readFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import * as config from "./config.js";

// L'id doit coïncider avec celui du hook (bin/claudy-hook.js) pour que l'alerte
// rouge "needs_input" se pose sur la même tête.
function shortId(sessionId) {
  return `cc-${String(sessionId).slice(0, 8)}`;
}

// Claude Code expose plusieurs statuts. Historiquement seuls "busy"/"idle"
// existaient ; les versions récentes (≥ 2.1.187) ajoutent "waiting" : le main loop
// est bloqué sur un dialog / une réponse utilisateur (champ `waitingFor`), souvent
// PENDANT qu'un workflow tourne en tâche de fond. On mappe :
//   busy    → working
//   waiting → needs_input  (l'agent réclame une réponse — tête rouge)
//   reste   → idle (neutre)
function mapStatus(status) {
  if (status === "busy") return "working";
  if (status === "waiting") return "needs_input";
  return "idle";
}

// Une session est « active » (susceptible de faire tourner un essaim de sous-agents
// / workflows) tant qu'elle n'est pas franchement idle. Un workflow en arrière-plan
// continue d'écrire ses transcripts même quand le parent attend un dialog ("waiting").
function isActive(status) {
  return status === "busy" || status === "waiting";
}

// Un PID est-il vivant ? Le signal 0 teste l'existence sans rien tuer.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // existe mais appartient à un autre user → vivant
  }
}

function nameFor(meta) {
  if (meta.name) return String(meta.name);
  const base = String(meta.cwd || "")
    .split("/")
    .filter(Boolean)
    .pop();
  return base || "claude";
}

// Claude Code encode le cwd en remplaçant les "/" par des "-" pour nommer le dossier
// de transcripts. Ex. /chemin/vers/projet → -chemin-vers-projet.
function encodeProjectDir(cwd) {
  return String(cwd).replace(/\//g, "-");
}

// Un sessionId sert à construire des chemins de fichiers → on n'accepte qu'un identifiant
// simple (hex/tirets/underscore), ce qui exclut "/" et ".." : pas de traversée de répertoire.
function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

// Plafonne un cache (Map) en évinçant les entrées les plus anciennes (ordre d'insertion).
function capCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// Lit le début d'un fichier sans le charger en entier (les transcripts font des centaines
// de Ko ; on ne veut que les premières lignes pour le libellé).
async function readHead(path, bytes = 65536) {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh?.close();
  }
}

// Lit la FIN d'un fichier sans le charger en entier (les transcripts font plusieurs
// Mo ; on ne veut que les dernières lignes pour connaître l'activité courante).
async function readTail(path, bytes = 65536) {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh?.close();
  }
}

// Activité courante d'une session = dernier outil utilisé + modèle, lus dans la queue
// du transcript (~64 Ko). Mémoïsé par mtime : on ne re-parse que si le fichier a bougé.
// Renvoie { tool, model } ou null. `tool` est le nom brut (le frontend le met en forme).
const activityCache = new Map(); // transcriptPath -> { mtimeMs, value }
async function latestActivity(cwd, sessionId, cfg) {
  if (!isSafeId(sessionId)) return null;
  const path = join(cfg.projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  let mtimeMs;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return null; // pas de transcript (session distante / dossier custom)
  }
  const cached = activityCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let value = null;
  try {
    const tail = await readTail(path);
    const lines = tail.split("\n");
    // Le tail commence presque toujours au milieu d'une ligne (offset arbitraire) :
    // la 1re « ligne » est un fragment JSON invalide → on la jette. (Si le transcript
    // tient en entier dans les 64 Ko, on a lu depuis l'octet 0 : 1re ligne complète.)
    if (tail.length >= 65536) lines.shift();
    let tool = null;
    let model = null;
    // On parcourt de la fin vers le début : 1er tool_use rencontré = le plus récent.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = o?.message;
      if (!msg) continue;
      if (!model && msg.model) model = msg.model;
      if (!tool && Array.isArray(msg.content)) {
        const t = msg.content.find((b) => b?.type === "tool_use");
        if (t?.name) tool = t.name;
      }
      if (tool && model) break;
    }
    if (tool || model) value = { tool, model };
  } catch {
    /* illisible : on garde value = null */
  }
  activityCache.set(path, { mtimeMs, value });
  capCache(activityCache, 2000);
  return value;
}

// Libellé d'un sous-agent = son type ("attributionAgent", ex. "Explore",
// "claude-code-guide"), à défaut un extrait de son prompt, à défaut un id court.
// Mémoïsé : le type définitif n'est lu qu'une fois (final=true) ; un libellé
// provisoire (extrait de prompt) est ré-essayé tant que le type n'est pas apparu.
const labelCache = new Map(); // agentId -> { label, final }
async function labelForSubagent(path, agentId) {
  const cached = labelCache.get(agentId);
  if (cached?.final) return cached.label;
  capCache(labelCache, 4000);
  let label = null;
  let final = false;
  // Voie rapide : le « <agent>.meta.json » (33 octets) porte le type d'agent.
  try {
    const metaTxt = await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const t = JSON.parse(metaTxt)?.agentType;
    if (t && t !== "workflow-subagent") {
      labelCache.set(agentId, { label: t, final: true });
      return t;
    }
  } catch {
    /* pas de meta.json : on retombe sur la lecture de l'en-tête du transcript */
  }
  try {
    const head = await readHead(path);
    const m = head.match(/"attributionAgent":"([^"]+)"/);
    if (m) {
      label = m[1];
      final = true;
    } else {
      const nl = head.indexOf("\n");
      const o = JSON.parse(nl >= 0 ? head.slice(0, nl) : head);
      const c = o?.message?.content;
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b?.type === "text")?.text || "" : "";
      const clean = txt.trim().replace(/\s+/g, " ");
      if (clean) label = clean.slice(0, 42);
    }
  } catch {
    /* fichier en cours d'écriture / illisible : on retombe sur l'id */
  }
  label = label || (cached?.label ?? `sub-${agentId.slice(0, 6)}`);
  labelCache.set(agentId, { label, final });
  return label;
}

// Lit un journal de workflow (wf_*/journal.jsonl) : événements `started` (l'agent a
// démarré) et `result` (l'agent a fini AVEC SUCCÈS). On en déduit succès vs échec.
async function readWorkflowJournal(dir) {
  const started = new Set();
  const results = new Set();
  let mtimeMs = 0;
  const jpath = join(dir, "journal.jsonl");
  try {
    mtimeMs = (await stat(jpath)).mtimeMs;
    const txt = await readFile(jpath, "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "started" && o.agentId) started.add(o.agentId);
      else if (o.type === "result" && o.agentId) results.add(o.agentId);
    }
  } catch {
    /* pas de journal (ou illisible) : workflow sans suivi de résultat */
  }
  return { started, results, mtimeMs };
}

// Rassemble l'essaim d'une session, avec un STATUT par tête :
//   - hors workflow : on ne montre que les sous-agents ACTIFS (status "working") ;
//   - dans un workflow : on montre TOUTES les têtes du run en cours, colorées via le
//     journal — "done" (a un result), "failed" (démarré, figé, sans result), "working"
//     (fichier frais, pas encore de result). Un workflow n'est affiché que tant qu'il
//     est « vivant » (journal récent ou au moins une tête active).
// Renvoie { children, swarm } où swarm résume la progression (ou null si pas de workflow).
async function gatherSwarm(cwd, sessionId, nowMs, cfg) {
  if (!isSafeId(sessionId)) return { children: [], swarm: null };
  const root = join(cfg.projectsDir, encodeProjectDir(cwd), sessionId, "subagents");
  const direct = []; // [{agentId, path, mtimeMs}]
  const wfDirs = new Map(); // wfId -> { dir, agents: [{agentId, path, mtimeMs}] }

  async function walk(dir, wfId, wfDir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const isWf = e.name.startsWith("wf_");
        await walk(p, isWf ? e.name : wfId, isWf ? p : wfDir);
      } else if (e.isFile() && /^agent-.+\.jsonl$/.test(e.name)) {
        let st;
        try {
          st = await stat(p);
        } catch {
          continue;
        }
        const agentId = e.name.slice("agent-".length, -".jsonl".length);
        const rec = { agentId, path: p, mtimeMs: st.mtimeMs };
        if (wfId) {
          if (!wfDirs.has(wfId)) wfDirs.set(wfId, { dir: wfDir, agents: [] });
          wfDirs.get(wfId).agents.push(rec);
        } else if (nowMs - st.mtimeMs <= cfg.subFreshMs) {
          direct.push(rec); // hors workflow : actifs seulement
        }
      }
    }
  }
  await walk(root, null, null);

  const children = [];
  let swarm = null;

  // Sous-agents directs (hors workflow) : tous "working" (on n'a pas de succès/échec).
  for (const r of direct.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    children.push({
      id: `sub-${r.agentId.slice(0, 8)}`,
      name: await labelForSubagent(r.path, r.agentId),
      status: "working",
      workflowId: null,
      mtimeMs: r.mtimeMs,
    });
  }

  // Workflows : on lit le journal et on colore chaque tête.
  //   - done   : l'agent a un `result` dans le journal (succès avéré) ;
  //   - working: pas (encore) de result ALORS QUE le workflow est vivant (journal qui
  //              écrit encore) → il tourne / réfléchit, même si son fichier est figé ;
  //   - failed : pas de result ET le workflow est TERMINÉ (journal figé) → l'agent n'a
  //              jamais rendu sa valeur (tué / interrompu). On n'accuse l'échec qu'une
  //              fois le run fini, pour ne pas rougir un agent encore en réflexion.
  const LIVE_WINDOW = cfg.subFreshMs + 30000; // un workflow fini reste affiché ~30 s
  for (const [wfId, grp] of wfDirs) {
    const { results, mtimeMs } = await readWorkflowJournal(grp.dir);
    const anyFresh = grp.agents.some((a) => nowMs - a.mtimeMs <= cfg.subFreshMs);
    const journalLive = mtimeMs > 0 && nowMs - mtimeMs <= cfg.subFreshMs; // écrit récemment
    const recent = mtimeMs > 0 && nowMs - mtimeMs <= LIVE_WINDOW;
    if (!journalLive && !recent && !anyFresh) continue; // run terminé depuis longtemps → masqué

    let done = 0;
    let failed = 0;
    let working = 0;
    for (const a of grp.agents.sort((x, y) => y.mtimeMs - x.mtimeMs)) {
      let status;
      if (results.has(a.agentId)) {
        status = "done";
        done++;
      } else if (journalLive || nowMs - a.mtimeMs <= cfg.subFreshMs) {
        // workflow vivant (ou agent qui écrit encore) → considéré en cours.
        status = "working";
        working++;
      } else {
        status = "failed"; // workflow terminé, jamais de result → échec/interruption.
        failed++;
      }
      children.push({
        id: `sub-${a.agentId.slice(0, 8)}`,
        name: await labelForSubagent(a.path, a.agentId),
        status,
        workflowId: wfId,
        mtimeMs: a.mtimeMs,
      });
    }
    const total = grp.agents.length;
    if (!swarm) swarm = { done: 0, failed: 0, working: 0, total: 0 };
    swarm.done += done;
    swarm.failed += failed;
    swarm.working += working;
    swarm.total += total;
  }

  return { children, swarm };
}

export function createDiscovery({ onChange } = {}) {
  let timer = null;
  /** @type {Map<string, {id:string,name:string,state:string,sessionId:string,cwd:string,pid:number}>} */
  let current = new Map();
  let lastSig = "";
  let warned = false;

  function publish(next) {
    // Signature stable : on ne notifie le serveur que si l'affichage change vraiment.
    const sig = [...next.values()]
      .map((a) => {
        const kids = (a.children || [])
          .map((c) => `${c.id}=${c.status}`)
          .sort()
          .join(",");
        const sw = a.swarm ? `${a.swarm.done}/${a.swarm.failed}/${a.swarm.working}/${a.swarm.total}` : "";
        const act = a.activity ? `${a.activity.tool || ""}@${a.activity.model || ""}` : "";
        return `${a.id}:${a.state}:${a.name}:${kids}+${a.childExtra || 0}#${sw}~${act}|${a.waitingFor || ""}`;
      })
      .sort()
      .join("|");
    current = next;
    if (sig !== lastSig) {
      lastSig = sig;
      if (onChange) onChange();
    }
  }

  async function scanOnce() {
    const cfg = config.get();
    // Découverte coupée (réglage à chaud) : on n'affiche aucune session.
    if (!cfg.discover) return publish(new Map());

    let files;
    try {
      files = await readdir(cfg.sessionsDir);
    } catch (err) {
      // Dossier absent (pas de Claude Code, ou chemin custom) : on n'affiche rien
      // mais on ne casse pas le serveur. Averti une seule fois.
      if (!warned) {
        warned = true;
        console.warn(
          `[claudy] découverte inactive : ${cfg.sessionsDir} illisible (${err.code || err.message})`,
        );
      }
      return publish(new Map());
    }

    const nowMs = Date.now();
    const next = new Map();
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let meta;
      try {
        meta = JSON.parse(await readFile(join(cfg.sessionsDir, f), "utf8"));
      } catch {
        continue; // fichier en cours d'écriture / illisible : ignoré ce tour-ci
      }
      if (!meta || typeof meta !== "object" || !meta.sessionId) continue;
      if (!isAlive(meta.pid)) continue;
      if (cfg.hideSession && meta.sessionId === cfg.hideSession) continue;
      const id = shortId(meta.sessionId);
      const state = mapStatus(meta.status);

      // Essaim : on ne scanne les sous-agents que pour une session ACTIVE
      // (busy ou waiting). Un workflow lancé en tâche de fond continue de tourner
      // pendant que le parent attend un dialog → il faut le scanner aussi, sinon
      // les têtes du workflow restent invisibles. I/O évitée pour les sessions idle.
      let children = [];
      let childExtra = 0;
      let swarm = null;
      let activity = null;
      if (cfg.subagents && isActive(meta.status)) {
        const gathered = await gatherSwarm(meta.cwd, meta.sessionId, nowMs, cfg);
        swarm = gathered.swarm;
        // En cours d'abord, puis terminés/échoués ; on plafonne l'affichage.
        const order = { working: 0, failed: 1, done: 2 };
        const all = gathered.children.sort((a, b) => order[a.status] - order[b.status] || b.mtimeMs - a.mtimeMs);
        const shown = all.slice(0, cfg.subMax);
        childExtra = all.length - shown.length;
        children = shown.map((c) => ({
          id: `${id}-${c.id}`,
          name: c.name,
          status: c.status,
          workflowId: c.workflowId,
        }));
      }
      // Activité courante (dernier outil + modèle) : seulement pour une session active,
      // lue dans la queue du transcript (mémoïsée par mtime → quasi gratuit au repos).
      if (isActive(meta.status)) {
        activity = await latestActivity(meta.cwd, meta.sessionId, cfg);
      }

      // `waitingFor` : pourquoi la session réclame (ex. "dialog open"). Renseigné par
      // Claude Code uniquement quand le statut est "waiting" → contexte de l'alerte.
      const waitingFor = meta.status === "waiting" && meta.waitingFor ? String(meta.waitingFor) : null;

      next.set(id, {
        id,
        name: nameFor(meta),
        state,
        sessionId: String(meta.sessionId),
        cwd: String(meta.cwd || ""),
        pid: meta.pid,
        children,
        childExtra,
        swarm,
        activity,
        waitingFor,
      });
    }
    publish(next);
  }

  // Boucle auto-replanifiée : on relit la cadence (pollMs) à chaque tour pour qu'un
  // changement de config s'applique sans redémarrage (impossible avec setInterval figé).
  function schedule() {
    timer = setTimeout(async () => {
      try {
        await scanOnce();
      } catch (err) {
        console.error("[claudy] erreur de découverte :", err?.message || err);
      }
      if (timer) schedule(); // sauf si stop() est passé entre-temps
    }, config.get().pollMs);
    timer.unref?.(); // ne maintient pas le process en vie à lui seul
  }

  return {
    start() {
      if (timer) return;
      scanOnce().catch((err) =>
        console.error("[claudy] erreur de découverte :", err?.message || err),
      );
      schedule();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** Liste des agents auto-découverts (sessions vivantes). */
    list() {
      return [...current.values()];
    },
    has(id) {
      return current.has(id);
    },
  };
}
