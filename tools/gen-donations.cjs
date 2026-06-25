#!/usr/bin/env node
// Generates DONATIONS.md + per-wallet QR codes from the single source of truth
// public/donations.json. Run after editing the addresses there:
//
//   node tools/gen-donations.cjs
//
// The in-app panel (public/donate.js) reads the same JSON live and builds its QR codes
// client-side, so this script only matters for the GitHub-rendered DONATIONS.md (which
// can't run JS → it needs committed SVG files). CommonJS (.cjs) because the repo is
// type:module. Zero npm dependency: the QR encoder is the vendored MIT file.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "public", "donations.json");
const QR_DIR = path.join(ROOT, "media", "qr");
const OUT_MD = path.join(ROOT, "DONATIONS.md");
const VENDOR = path.join(ROOT, "public", "vendor", "qrcode.js");

// Load the vendored encoder. The file is a classic script (`var qrcode = ...`) wrapped in
// a UMD tail that no-ops outside AMD/CJS-with-exports; we run it in a function scope and
// grab the resulting global. Avoids ESM/CJS extension headaches in a type:module repo.
function loadQrcode() {
  const src = fs.readFileSync(VENDOR, "utf8");
  return new Function(src + "\n;return qrcode;")();
}

function isConfigured(addr) {
  return !!addr && !/^REMPLACER_/.test(addr);
}

function paymentUri(w) {
  return `${w.uriScheme}:${w.address}`;
}

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch (err) {
    console.error(`Lecture de ${DATA} impossible : ${err.message}`);
    process.exit(1);
  }
  const wallets = Array.isArray(data.wallets) ? data.wallets.filter(Boolean) : [];
  const qrcode = loadQrcode();

  fs.mkdirSync(QR_DIR, { recursive: true });

  const lines = [];
  lines.push(`# ${data.title || "Soutenir le créateur"}`, "");
  if (data.blurb) lines.push(data.blurb, "");
  lines.push(
    "> ⚠️ Vérifie toujours l'**adresse complète** avant d'envoyer : les transactions crypto sont **irréversibles**.",
    "",
    "<!-- Fichier généré par `node tools/gen-donations.cjs` à partir de public/donations.json. Ne pas éditer à la main. -->",
    ""
  );

  let configured = 0;
  for (const w of wallets) {
    lines.push(`## ${w.name}`, "");
    const meta = [w.network, (w.accepts || []).join(" · ")].filter(Boolean).join(" — accepte ");
    if (meta) lines.push(`*${meta}*`, "");

    if (!isConfigured(w.address)) {
      lines.push("_Adresse non encore configurée._", "");
      continue;
    }
    configured++;

    // QR → committed SVG (GitHub renders relative-path SVGs as images).
    const qr = qrcode(0, "M");
    qr.addData(paymentUri(w));
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const rel = path.join("media", "qr", `${w.id}.svg`);
    fs.writeFileSync(path.join(ROOT, rel), svg);

    lines.push("```", w.address, "```", "");
    lines.push(`![QR ${w.name}](${rel.split(path.sep).join("/")})`, "");
  }

  fs.writeFileSync(OUT_MD, lines.join("\n"));
  console.log(
    `DONATIONS.md généré (${wallets.length} wallet(s), ${configured} configuré(s)). ` +
      (configured ? `QR dans media/qr/.` : `Aucun QR (toutes les adresses sont encore des placeholders).`)
  );
}

main();
