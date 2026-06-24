#!/usr/bin/env node
// claudy-mute-claude — coupe (et restaure) les notifications natives de Claude Code.
//
// Quand agent-claudy affiche déjà ses propres notifications, on évite le doublon en
// basculant `preferredNotifChannel` de Claude Code sur "notifications_disabled".
// (Le hook Notification continue de tourner → la notif Claudy s'affiche quand même.)
//
//   node bin/claudy-mute-claude.js on      → coupe les notifs Claude (mémorise l'ancienne valeur)
//   node bin/claudy-mute-claude.js off     → restaure la valeur d'origine
//   node bin/claudy-mute-claude.js status  → affiche l'état courant
//
// Réversible et idempotent : la valeur d'origine est sauvegardée dans un sidecar.
// Cible ~/.claude/settings.json (surchargeable via CLAUDY_CC_SETTINGS).

import { readFile, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SETTINGS = process.env.CLAUDY_CC_SETTINGS || join(homedir(), ".claude", "settings.json");
const SIDECAR = join(homedir(), ".claude", ".claudy-notif-prev");
const DISABLED = "notifications_disabled";

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return {};
  }
}

// Écriture atomique : on écrit dans un fichier temporaire du MÊME dossier puis on
// rename (atomique sur le même système de fichiers) → jamais de settings.json
// tronqué/corrompu même si une autre écriture survient en parallèle.
async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.claudy.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await rename(tmp, p);
}

async function main() {
  const cmd = (process.argv[2] || "status").toLowerCase();
  const settings = await readJson(SETTINGS);
  const current = settings.preferredNotifChannel ?? "auto";

  if (cmd === "status") {
    const muted = current === DISABLED ? "  (notifs Claude coupées)" : "";
    console.log(`preferredNotifChannel = ${current}${muted}`);
    return;
  }

  if (cmd === "on") {
    // Ne sauvegarde la valeur d'origine que si on n'est pas déjà coupé (idempotent).
    if (current !== DISABLED) await writeFile(SIDECAR, current, "utf8");
    settings.preferredNotifChannel = DISABLED;
    await writeJsonAtomic(SETTINGS, settings);
    console.log(`✓ notifs Claude Code coupées (preferredNotifChannel = ${DISABLED}).`);
    return;
  }

  if (cmd === "off") {
    let prev = "auto";
    try {
      prev = (await readFile(SIDECAR, "utf8")).trim() || "auto";
    } catch {
      /* pas de sidecar : on retombe sur "auto" (le défaut de Claude Code) */
    }
    settings.preferredNotifChannel = prev;
    await writeJsonAtomic(SETTINGS, settings);
    await rm(SIDECAR, { force: true });
    console.log(`✓ notifs Claude Code restaurées (preferredNotifChannel = ${prev}).`);
    return;
  }

  console.error("Usage : claudy-mute-claude.js on|off|status");
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
