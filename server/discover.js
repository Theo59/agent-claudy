// agent-claudy — auto-discovery of Claude Code sessions.
//
// Claude Code keeps a registry of sessions in  ~/.claude/sessions/<PID>.json
// (one file per session, continuously updated):
//   { pid, sessionId, cwd, status: "busy"|"idle"|"waiting", waitingFor?, version, name?, ... }
//
// This module reads that folder periodically, keeps only the sessions whose PID
// is still alive, and exposes the list to the server. Zero dependencies (native fs/os).
//
//   busy → working   |   waiting → needs_input   |   idle → idle   |   dead PID → head removed
//
// Current activity: for an active session, we read the TAIL of the transcript
// (~/.claude/projects/<encoded cwd>/<sessionId>.jsonl) to extract the last tool
// used + the model, memoized by mtime (see latestActivity).
//
// Subagents (swarm): for each live working session, Claude Code writes one
// transcript per subagent in
//   ~/.claude/projects/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl
// (and, for workflows, …/subagents/workflows/wf_<id>/agent-<id>.jsonl).
// A file with a fresh mtime = subagent still active; frozen = finished. The agent
// type (e.g. "Explore", "claude-code-guide") is read via "attributionAgent" in
// the file, without re-reading the (large) parent transcript.
//
// All settings (folders, cadence, subagents, hiding…) now come from the central
// config layer (server/config.js) and apply LIVE: we re-read them on every scan
// rather than freezing them at load time.

import { readdir, readFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import * as config from "./config.js";

// The id must match the one from the hook (bin/claudy-hook.js) so that the red
// "needs_input" alert lands on the same head.
function shortId(sessionId) {
  return `cc-${String(sessionId).slice(0, 8)}`;
}

// Claude Code exposes several statuses. Historically only "busy"/"idle"
// existed; recent versions (≥ 2.1.187) add "waiting": the main loop is
// blocked on a dialog / user response (`waitingFor` field), often WHILE a
// workflow runs in the background. We map:
//   busy    → working
//   waiting → needs_input  (the agent is asking for a response — red head)
//   rest    → idle (neutral)
function mapStatus(status) {
  if (status === "busy") return "working";
  if (status === "waiting") return "needs_input";
  return "idle";
}

// A session is "active" (likely to be running a swarm of subagents / workflows)
// as long as it is not fully idle. A background workflow keeps writing its
// transcripts even when the parent is waiting on a dialog ("waiting").
function isActive(status) {
  return status === "busy" || status === "waiting";
}

// Is a PID alive? Signal 0 tests for existence without killing anything.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user → alive
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

// Claude Code encodes the cwd by replacing "/" with "-" to name the transcripts
// folder. E.g. /path/to/project → -path-to-project.
function encodeProjectDir(cwd) {
  return String(cwd).replace(/\//g, "-");
}

// A sessionId is used to build file paths → we only accept a simple identifier
// (hex/dashes/underscore), which excludes "/" and "..": no directory traversal.
function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

// Caps a cache (Map) by evicting the oldest entries (insertion order).
function capCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// Reads the beginning of a file without loading it whole (transcripts are hundreds
// of KB; we only want the first lines for the label).
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

// Reads the END of a file without loading it whole (transcripts are several
// MB; we only want the last lines to know the current activity).
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

// Path of a session's main transcript.
function transcriptPath(cwd, sessionId, cfg) {
  return join(cfg.projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

// Current activity of a session, read from the TAIL of the transcript (~64 KB),
// memoized by mtime (we only re-parse if the file has changed). Returns
//   { tool, model, mode }  or null
// `tool` = raw name of the last tool; `model` = last model; `mode` = last
// `permissionMode` (plan / acceptEdits / auto / default). The frontend formats it.
const activityCache = new Map(); // transcriptPath -> { mtimeMs, value }
async function latestActivity(cwd, sessionId, cfg) {
  if (!isSafeId(sessionId)) return null;
  const path = transcriptPath(cwd, sessionId, cfg);
  let mtimeMs;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return null; // no transcript (remote session / custom folder)
  }
  const cached = activityCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;

  let value = null;
  try {
    const tail = await readTail(path);
    const lines = tail.split("\n");
    // The tail almost always starts in the middle of a line (arbitrary offset):
    // the 1st "line" is an invalid JSON fragment → we discard it. (If the transcript
    // fits entirely in 64 KB, we read from byte 0: 1st line is complete.)
    if (tail.length >= 65536) lines.shift();
    let tool = null;
    let model = null;
    let mode = null;
    // We iterate from the end toward the start: 1st value found = the most recent.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!mode && o.permissionMode) mode = o.permissionMode;
      const msg = o?.message;
      if (!msg) continue;
      if (!model && msg.model) model = msg.model;
      if (!tool && Array.isArray(msg.content)) {
        const t = msg.content.find((b) => b?.type === "tool_use");
        if (t?.name) tool = t.name;
      }
      if (tool && model && mode) break;
    }
    if (tool || model || mode) value = { tool, model, mode };
  } catch {
    /* unreadable: we keep value = null */
  }
  activityCache.set(path, { mtimeMs, value });
  capCache(activityCache, 2000);
  return value;
}

// Current effort level of the session (low/medium/high/xhigh/max/ultracode), set by
// the /effort command. It PERSISTS and may have been defined very early (outside the
// tail read for activity) → we follow the transcript INCREMENTALLY: 1st pass = one
// full read, then we only re-read the appended bytes (JSONL only appends complete
// lines). A structured marker, immune to pollution from tool outputs: a message
// whose `content` is the STRING
//   "<local-command-stdout>Set effort level to <X> ...</local-command-stdout>"
// (a tool result has an array-type content → discarded). Returns the value or null.
const effortCache = new Map(); // transcriptPath -> { size, effort }
const EFFORT_RE = /<local-command-stdout>Set effort level to (\w+)/;
function scanEffort(text, current) {
  let effort = current;
  for (const line of text.split("\n")) {
    if (!line.includes("Set effort level to")) continue; // cheap pre-filter
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const c = o?.message?.content;
    if (typeof c !== "string") continue; // tool_result (content = array) → ignored
    const m = c.match(EFFORT_RE);
    if (m) effort = m[1]; // keep the LAST value (the most recent)
  }
  return effort;
}
async function sessionEffort(cwd, sessionId, cfg) {
  if (!isSafeId(sessionId)) return null;
  const path = transcriptPath(cwd, sessionId, cfg);
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  const cached = effortCache.get(path);
  if (cached && cached.size === size) return cached.effort;

  // Delta only if the file grew compared to the last scan; otherwise (1st
  // pass, or truncated/rewritten file) we re-read from the start.
  const from = cached && size > cached.size ? cached.size : 0;
  let effort = cached?.effort ?? null;
  let fh;
  try {
    fh = await open(path, "r");
    const len = size - from;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    effort = scanEffort(buf.subarray(0, bytesRead).toString("utf8"), effort);
  } catch {
    /* unreadable: we keep the known value */
  } finally {
    await fh?.close();
  }
  effortCache.set(path, { size, effort });
  capCache(effortCache, 2000);
  return effort;
}

// A subagent's label = its type ("attributionAgent", e.g. "Explore",
// "claude-code-guide"), failing that an excerpt of its prompt, failing that a short id.
// Memoized: the definitive type is read only once (final=true); a provisional
// label (prompt excerpt) is retried until the type has appeared.
const labelCache = new Map(); // agentId -> { label, final }
async function labelForSubagent(path, agentId) {
  const cached = labelCache.get(agentId);
  if (cached?.final) return cached.label;
  capCache(labelCache, 4000);
  let label = null;
  let final = false;
  // Fast path: the "<agent>.meta.json" (33 bytes) carries the agent type.
  try {
    const metaTxt = await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8");
    const t = JSON.parse(metaTxt)?.agentType;
    if (t && t !== "workflow-subagent") {
      labelCache.set(agentId, { label: t, final: true });
      return t;
    }
  } catch {
    /* no meta.json: we fall back to reading the transcript header */
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
    /* file being written / unreadable: we fall back to the id */
  }
  label = label || (cached?.label ?? `sub-${agentId.slice(0, 6)}`);
  labelCache.set(agentId, { label, final });
  return label;
}

// Reads a workflow journal (wf_*/journal.jsonl): `started` events (the agent has
// started) and `result` events (the agent finished SUCCESSFULLY). We infer success vs failure.
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
    /* no journal (or unreadable): workflow without result tracking */
  }
  return { started, results, mtimeMs };
}

// Gathers a session's swarm, with a STATUS per head:
//   - outside a workflow: we only show ACTIVE subagents (status "working");
//   - inside a workflow: we show ALL heads of the current run, colored via the
//     journal — "done" (has a result), "failed" (started, frozen, no result), "working"
//     (fresh file, no result yet). A workflow is only shown while it is
//     "alive" (recent journal or at least one active head).
// Returns { children, swarm } where swarm summarizes the progress (or null if no workflow).
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
          direct.push(rec); // outside a workflow: active only
        }
      }
    }
  }
  await walk(root, null, null);

  const children = [];
  let swarm = null;

  // Direct subagents (outside a workflow): all "working" (we have no success/failure).
  for (const r of direct.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    children.push({
      id: `sub-${r.agentId.slice(0, 8)}`,
      name: await labelForSubagent(r.path, r.agentId),
      status: "working",
      workflowId: null,
      mtimeMs: r.mtimeMs,
    });
  }

  // Workflows: we read the journal and color each head.
  //   - done   : the agent has a `result` in the journal (confirmed success);
  //   - working: no result (yet) WHILE the workflow is alive (journal still
  //              writing) → it is running / thinking, even if its file is frozen;
  //   - failed : no result AND the workflow is FINISHED (frozen journal) → the agent
  //              never returned its value (killed / interrupted). We only declare failure
  //              once the run is over, so as not to redden an agent still thinking.
  const LIVE_WINDOW = cfg.subFreshMs + 30000; // a finished workflow stays shown ~30 s
  for (const [wfId, grp] of wfDirs) {
    const { results, mtimeMs } = await readWorkflowJournal(grp.dir);
    const anyFresh = grp.agents.some((a) => nowMs - a.mtimeMs <= cfg.subFreshMs);
    const journalLive = mtimeMs > 0 && nowMs - mtimeMs <= cfg.subFreshMs; // recently written
    const recent = mtimeMs > 0 && nowMs - mtimeMs <= LIVE_WINDOW;
    if (!journalLive && !recent && !anyFresh) continue; // run finished long ago → hidden

    let done = 0;
    let failed = 0;
    let working = 0;
    for (const a of grp.agents.sort((x, y) => y.mtimeMs - x.mtimeMs)) {
      let status;
      if (results.has(a.agentId)) {
        status = "done";
        done++;
      } else if (journalLive || nowMs - a.mtimeMs <= cfg.subFreshMs) {
        // workflow alive (or agent still writing) → considered in progress.
        status = "working";
        working++;
      } else {
        status = "failed"; // workflow finished, never a result → failure/interruption.
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
    // Stable signature: we only notify the server if the display actually changes.
    const sig = [...next.values()]
      .map((a) => {
        const kids = (a.children || [])
          .map((c) => `${c.id}=${c.status}`)
          .sort()
          .join(",");
        const sw = a.swarm ? `${a.swarm.done}/${a.swarm.failed}/${a.swarm.working}/${a.swarm.total}` : "";
        const act = a.activity ? `${a.activity.tool || ""}@${a.activity.model || ""}` : "";
        return `${a.id}:${a.state}:${a.name}:${kids}+${a.childExtra || 0}#${sw}~${act}|${a.waitingFor || ""}^${a.mode || ""}*${a.effort || ""}`;
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
    // Discovery turned off (live setting): we display no session.
    if (!cfg.discover) return publish(new Map());

    let files;
    try {
      files = await readdir(cfg.sessionsDir);
    } catch (err) {
      // Folder absent (no Claude Code, or custom path): we display nothing
      // but we don't break the server. Warned only once.
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
        continue; // file being written / unreadable: ignored this round
      }
      if (!meta || typeof meta !== "object" || !meta.sessionId) continue;
      if (!isAlive(meta.pid)) continue;
      if (cfg.hideSession && meta.sessionId === cfg.hideSession) continue;
      const id = shortId(meta.sessionId);
      let state = mapStatus(meta.status);

      // Swarm: we only scan subagents for an ACTIVE session (busy or waiting).
      // A workflow started in the background keeps running while the parent waits
      // on a dialog → it must be scanned too, otherwise the workflow's heads stay
      // invisible. I/O avoided for idle sessions.
      let children = [];
      let childExtra = 0;
      let swarm = null;
      let activity = null;
      let mode = null;
      let effort = null;
      if (cfg.subagents && isActive(meta.status)) {
        const gathered = await gatherSwarm(meta.cwd, meta.sessionId, nowMs, cfg);
        swarm = gathered.swarm;
        // In progress first, then finished/failed; we cap the display.
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

      // A "waiting" parent WHILE a dynamic workflow is actively running is the
      // workflow's OWN dialog (e.g. a sub-agent prompt), which the user can't act on.
      // Don't raise a red "needs_input" alert for it → show it as plain "working".
      if (state === "needs_input" && swarm && swarm.working > 0) {
        state = "working";
      }

      // Activity (last tool + model), mode (permissionMode) and effort level
      // (ultracode…): only for an active session. Everything is memoized (by mtime
      // for activity, by size + incremental scan for effort) → nearly free once
      // read. The mode comes from the tail, read at the same time as the activity.
      if (isActive(meta.status)) {
        const info = await latestActivity(meta.cwd, meta.sessionId, cfg);
        mode = info?.mode || null;
        activity = info && (info.tool || info.model) ? { tool: info.tool, model: info.model } : null;
        effort = await sessionEffort(meta.cwd, meta.sessionId, cfg);
      }

      // `waitingFor`: why the session is asking (e.g. "dialog open"). Set by
      // Claude Code only when the status is "waiting" → context for the alert.
      const waitingFor = state === "needs_input" && meta.waitingFor ? String(meta.waitingFor) : null;

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
        mode,
        effort,
        waitingFor,
      });
    }
    publish(next);
  }

  // Self-rescheduling loop: we re-read the cadence (pollMs) each round so that a
  // config change applies without a restart (impossible with a fixed setInterval).
  function schedule() {
    timer = setTimeout(async () => {
      try {
        await scanOnce();
      } catch (err) {
        console.error("[claudy] erreur de découverte :", err?.message || err);
      }
      if (timer) schedule(); // unless stop() was called in the meantime
    }, config.get().pollMs);
    timer.unref?.(); // does not keep the process alive on its own
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
    /** List of auto-discovered agents (live sessions). */
    list() {
      return [...current.values()];
    },
    has(id) {
      return current.has(id);
    },
  };
}
