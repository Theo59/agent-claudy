#!/usr/bin/env node
// claudy-mute-claude — mutes (and restores) Claude Code's native notifications.
//
// When agent-claudy already shows its own notifications, we avoid duplicates by
// switching Claude Code's `preferredNotifChannel` to "notifications_disabled".
// (The Notification hook keeps running → the Claudy notification still appears.)
//
//   node bin/claudy-mute-claude.js on      → mute Claude notifs (remembers the previous value)
//   node bin/claudy-mute-claude.js off     → restore the original value
//   node bin/claudy-mute-claude.js status  → show the current state
//
// Reversible and idempotent: the original value is saved in a sidecar file.
// Targets ~/.claude/settings.json (overridable via CLAUDY_CC_SETTINGS).

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

// Atomic write: write to a temp file in the SAME directory, then rename
// (atomic on the same filesystem) → settings.json is never left
// truncated/corrupted even if another write happens concurrently.
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
    // Only save the original value if we're not already muted (idempotent).
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
      /* no sidecar: fall back to "auto" (Claude Code's default) */
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
