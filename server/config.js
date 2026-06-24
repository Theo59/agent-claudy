// agent-claudy — couche de configuration centrale.
//
// Source de vérité unique des réglages, éditable depuis l'UI (panneau ⚙) qui écrit
// ~/.config/claudy/config.json. Le serveur et la découverte lisent leurs options ICI
// (et non plus dans des `const` figés au chargement) → la plupart des réglages
// s'appliquent À CHAUD, sans redémarrage.
//
// Précédence : défauts < fichier config.json < variable d'environnement.
//   - Le fichier est ce que pilote l'UI (toggles du quotidien).
//   - Une variable d'env explicite (launchd, CLI, extension) GAGNE et verrouille la
//     clé dans l'UI (signalée `overridden`) : l'ops garde la main.
//
// Zéro dépendance (fs/os/path natifs). Lecture synchrone au boot (PORT/HOST dispo
// immédiatement) ; écriture atomique (tmp + rename).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const CONFIG_PATH = process.env.CLAUDY_CONFIG || join(HOME, ".config", "claudy", "config.json");

// Catalogue des options. `hot:false` (port/host) ⇒ nécessite un redémarrage du serveur.
// `advanced:true` ⇒ replié par défaut dans l'UI. `env` = variable qui surcharge/verrouille.
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
];

const BY_KEY = new Map(SCHEMA.map((s) => [s.key, s]));
const FALSY = new Set(["0", "false", "off", "no", ""]);

// Coerce une valeur (env brut ou JSON) vers le type attendu. `undefined` = invalide.
function coerce(type, v) {
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "bool") return !FALSY.has(String(v).toLowerCase());
  return v == null ? "" : String(v);
}

let fileObj = {}; // dernier contenu de config.json (ce que l'UI édite)
let values = {}; // valeurs effectives (défauts < fichier < env)
let overridden = []; // clés forcées par une variable d'env (verrouillées dans l'UI)
let onChange = null; // callback serveur pour appliquer les changements à chaud

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
    fileObj = {}; // absent / illisible : on retombe sur les défauts, jamais de crash
  }
  recompute();
}

load();

/** Valeurs effectives courantes (copie, pour éviter toute mutation externe). */
export function get() {
  return { ...values };
}

/** Schéma + valeurs + clés verrouillées par l'env : tout ce qu'il faut à l'UI. */
export function meta() {
  return {
    schema: SCHEMA.map((s) => ({ ...s })),
    values: { ...values },
    overridden: [...overridden],
    path: CONFIG_PATH,
  };
}

/**
 * Applique un patch : valide, écrit config.json atomiquement, recalcule, et notifie
 * le serveur des clés dont la valeur effective a changé (pour l'application à chaud).
 * @param {Record<string, unknown>} patch
 * @returns {Promise<ReturnType<typeof meta>>}
 */
export async function save(patch = {}) {
  if (!patch || typeof patch !== "object") throw new Error("patch invalide");
  const before = { ...values };

  for (const [k, v] of Object.entries(patch)) {
    const s = BY_KEY.get(k);
    if (!s) continue; // clé inconnue : ignorée
    const c = coerce(s.type, v);
    if (c !== undefined) fileObj[k] = c;
  }

  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(fileObj, null, 2)}\n`);
    renameSync(tmp, CONFIG_PATH); // remplacement atomique
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

/** Enregistre le callback d'application à chaud (appelé par le serveur). */
export function setOnChange(fn) {
  onChange = typeof fn === "function" ? fn : null;
}

export { CONFIG_PATH };
