#!/usr/bin/env node
// claudy-report — pousse l'état d'un agent vers le serveur agent-claudy.
//
// Exemples :
//   node bin/claudy-report.js mon-agent working
//   node bin/claudy-report.js mon-agent working --name "Crawler" --quote "Y a moyen de tout"
//   node bin/claudy-report.js mon-agent needs_input --request "Je continue ?"
//   node bin/claudy-report.js mon-agent idle
//   node bin/claudy-report.js mon-agent --delete
//
// Cible le serveur via CLAUDY_URL (défaut http://127.0.0.1:4310) ou --url.

const STATES = ["working", "idle", "needs_input", "offline"];

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--delete" || a === "--remove") {
      opts.delete = true;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a.startsWith("--")) {
      const value = argv[++i];
      // Une option attendant une valeur mais sans valeur (ou suivie d'une autre
      // option) est une erreur explicite plutôt qu'un oubli silencieux.
      if (value === undefined || value.startsWith("--")) {
        opts.error = `valeur manquante pour ${a}`;
        break;
      }
      opts[a.slice(2)] = value;
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function usage(msg) {
  if (msg) console.error(`Erreur : ${msg}\n`);
  console.error(
    "Usage : claudy-report <id> [état] [--name N] [--quote Q] [--request R] [--url U] [--delete]\n" +
      `États : ${STATES.join(", ")}`,
  );
  process.exit(msg ? 1 : 0);
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [id, state] = positional;

  if (opts.help || id === "help") return usage(); // aide propre, code de sortie 0
  if (opts.error) return usage(opts.error);
  if (!id) return usage("id manquant");
  if (state && !STATES.includes(state)) return usage(`état inconnu « ${state} »`);

  const base = opts.url || process.env.CLAUDY_URL || "http://127.0.0.1:4310";
  const url = `${base.replace(/\/$/, "")}/api/agents/${encodeURIComponent(id)}`;

  try {
    let res;
    if (opts.delete) {
      res = await fetch(url, { method: "DELETE" });
    } else {
      const body = {};
      if (state) body.state = state;
      if (opts.name) body.name = opts.name;
      if (opts.quote) body.quote = opts.quote;
      if (opts.request) body.request = opts.request;
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      console.error(`Échec (${res.status}) : ${await res.text()}`);
      process.exit(1);
    }
    console.log(`✓ ${id} → ${opts.delete ? "supprimé" : state || "mis à jour"}`);
  } catch (err) {
    console.error(`Impossible de joindre le serveur (${base}) : ${err.message}`);
    process.exit(1);
  }
}

main();
