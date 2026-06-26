// agent-claudy — central configuration layer.
//
// Single source of truth for settings, editable from the UI (⚙ panel) which writes
// ~/.config/claudy/config.json. The server and discovery read their options HERE
// (no longer from `const`s frozen at load time) → most settings apply LIVE, with no
// restart.
//
// Precedence: defaults < config.json file < environment variable.
//   - The file is what the UI drives (day-to-day toggles).
//   - An explicit env variable (launchd, CLI, extension) WINS and locks the key in
//     the UI (flagged `overridden`): ops keeps control.
//
// Zero dependencies (native fs/os/path). Synchronous read at boot (PORT/HOST available
// immediately); atomic write (tmp + rename).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const CONFIG_PATH = process.env.CLAUDY_CONFIG || join(HOME, ".config", "claudy", "config.json");

// Option catalog. `hot:false` (port/host) ⇒ requires a server restart.
// `advanced:true` ⇒ collapsed by default in the UI. `env` = variable that overrides/locks.
const SCHEMA = [
  { key: "port", env: "CLAUDY_PORT", type: "number", default: 4310, group: "Serveur", label: "Port d'écoute", restart: true },
  { key: "host", env: "CLAUDY_HOST", type: "string", default: "127.0.0.1", group: "Serveur", label: "Adresse d'écoute", restart: true, advanced: true },

  { key: "discover", env: "CLAUDY_DISCOVER", type: "bool", default: true, group: "Découverte", label: "Auto-découverte des sessions Claude Code" },
  { key: "subagents", env: "CLAUDY_SUBAGENTS", type: "bool", default: true, group: "Découverte", label: "Essaim de sous-agents (mini-têtes)" },
  { key: "pollMs", env: "CLAUDY_POLL_MS", type: "number", default: 2000, group: "Découverte", label: "Cadence de scan (ms)", advanced: true },
  { key: "subFreshMs", env: "CLAUDY_SUB_FRESH_MS", type: "number", default: 25000, group: "Découverte", label: "Fraîcheur sous-agent « actif » (ms)", advanced: true },
  { key: "subMax", env: "CLAUDY_SUB_MAX", type: "number", default: 16, group: "Découverte", label: "Max de mini-têtes par session", advanced: true },
  { key: "hideSession", env: "CLAUDY_HIDE_SESSION", type: "string", default: "", group: "Découverte", label: "Masquer une session (sessionId complet)", advanced: true },
  { key: "sessionsDir", env: "CLAUDY_SESSIONS_DIR", type: "string", default: join(HOME, ".claude", "sessions"), group: "Découverte", label: "Dossier des sessions", advanced: true },
  { key: "projectsDir", env: "CLAUDY_PROJECTS_DIR", type: "string", default: join(HOME, ".claude", "projects"), group: "Découverte", label: "Dossier des transcripts", advanced: true },

  { key: "notify", env: "CLAUDY_NOTIFY", type: "bool", default: true, group: "Notifications", label: "Notifications macOS quand un agent réclame" },
  { key: "notifySound", env: "CLAUDY_NOTIFY_SOUND", type: "bool", default: true, group: "Notifications", label: "Son de notification" },
  { key: "muteCc", env: "CLAUDY_MUTE_CC", type: "bool", default: false, group: "Notifications", label: "Couper les notifs natives de Claude Code (anti-doublon)" },
  { key: "overrideTtlMs", env: "CLAUDY_OVERRIDE_TTL_MS", type: "number", default: 10 * 60 * 1000, group: "Notifications", label: "Expiration d'une alerte non levée (ms)", advanced: true },

  // Affichage : éléments visibles sur chaque carte (purement visuel, poussé en live via SSE).
  { key: "showBubble", env: "CLAUDY_SHOW_BUBBLE", type: "bool", default: true, group: "Affichage", label: "Bulle de réplique" },
  { key: "showBadges", env: "CLAUDY_SHOW_BADGES", type: "bool", default: true, group: "Affichage", label: "Pictos mode / effort (ultracode)" },
  { key: "showActivity", env: "CLAUDY_SHOW_ACTIVITY", type: "bool", default: true, group: "Affichage", label: "Activité au survol de la tête (outil + modèle)" },
  { key: "showSwarm", env: "CLAUDY_SHOW_SWARM", type: "bool", default: true, group: "Affichage", label: "Essaim de sous-agents (mini-têtes)" },

  // Raccourcis (lus par l'app macOS flottante, qui relit config.json et ré-enregistre
  // le hotkey global à la volée). Format : "ctrl+alt+c" (modificateurs + une lettre/chiffre).
  { key: "floatHotkey", env: "CLAUDY_FLOAT_HOTKEY", type: "string", default: "ctrl+alt+c", group: "Raccourcis", label: "Afficher / masquer la fenêtre flottante", widget: "hotkey" },
];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));
const FALSY = new Set(["0", "false", "off", "no", ""]);

// Coerce a value (raw env or JSON) to the expected type. `undefined` = invalid.
function coerce(type, v) {
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "bool") return !FALSY.has(String(v).toLowerCase());
  return v == null ? "" : String(v);
}

let fileObj = {}; // latest content of config.json (what the UI edits)
let values = {}; // effective values (defaults < file < env)
let overridden = []; // keys forced by an env variable (locked in the UI)
let onChange = null; // server callback to apply changes live

function recompute() {
  const next = {};
  const over = [];
  for (const s of SCHEMA) {
    const envRaw = process.env[s.env];
    if (envRaw !== undefined) {
      const c = coerce(s.type, envRaw);
      next[s.key] = c === undefined ? s.default : c;
      over.push(s.key);
    } else if (Object.prototype.hasOwnProperty.call(fileObj, s.key)) {
      const c = coerce(s.type, fileObj[s.key]);
      next[s.key] = c === undefined ? s.default : c;
    } else {
      next[s.key] = s.default;
    }
  }
  values = next;
  overridden = over;
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    fileObj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    fileObj = {}; // missing / unreadable: fall back to defaults, never crash
  }
  recompute();
}

load();

/** Current effective values (a copy, to prevent any external mutation). */
export function get() {
  return { ...values };
}

/** Schema + values + keys locked by env: everything the UI needs. */
export function meta() {
  return {
    schema: SCHEMA.map((s) => ({ ...s })),
    values: { ...values },
    overridden: [...overridden],
    path: CONFIG_PATH,
  };
}

/**
 * Apply a patch: validate, write config.json atomically, recompute, and notify the
 * server of keys whose effective value changed (for live application).
 * @param {Record<string, unknown>} patch
 * @returns {Promise<ReturnType<typeof meta>>}
 */
export async function save(patch = {}) {
  if (!patch || typeof patch !== "object") throw new Error("patch invalide");
  const before = { ...values };

  for (const [k, v] of Object.entries(patch)) {
    const s = BY_KEY.get(k);
    if (!s) continue; // unknown key: ignored
    const c = coerce(s.type, v);
    if (c !== undefined) fileObj[k] = c;
  }

  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(fileObj, null, 2)}\n`);
    renameSync(tmp, CONFIG_PATH); // atomic replacement
  } catch (err) {
    throw new Error(`écriture de ${CONFIG_PATH} impossible : ${err.message}`);
  }

  recompute();
  const changed = SCHEMA.map((s) => s.key).filter((k) => before[k] !== values[k]);
  if (changed.length && onChange) {
    try {
      onChange(changed, get());
    } catch (err) {
      console.error("[claudy] onChange config :", err?.message || err);
    }
  }
  return meta();
}

/** Registers the live-application callback (called by the server). */
export function setOnChange(fn) {
  onChange = typeof fn === "function" ? fn : null;
}

export { CONFIG_PATH };
