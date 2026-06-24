// agent-claudy — la « session Claude Code » du diptyque (texte qui se tape/défile).
//
// Les têtes de Claudy, elles, sont rendues par la VRAIE interface dans l'iframe
// (demo-app.html) à droite. Ici on ne joue que le fil de la session, en boucle.
// Respecte prefers-reduced-motion.

(function () {
  "use strict";

  const body = document.getElementById("termBody");
  if (!body) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? Math.min(ms, 150) : ms));

  function trim() {
    while (body.childNodes.length > 40) body.removeChild(body.firstChild);
  }

  function line(text, cls) {
    const ln = document.createElement("div");
    ln.className = "ln" + (cls ? " " + cls : "");
    ln.textContent = text;
    body.appendChild(ln);
    trim();
    return ln;
  }

  function typeLine(text, cls, cps) {
    return new Promise((resolve) => {
      const ln = document.createElement("div");
      ln.className = "ln" + (cls ? " " + cls : "");
      const span = document.createElement("span");
      const cur = document.createElement("span");
      cur.className = "cur";
      cur.textContent = " ";
      ln.append(span, cur);
      body.appendChild(ln);
      trim();
      if (reduce) {
        span.textContent = text;
        cur.remove();
        return resolve();
      }
      let i = 0;
      const id = setInterval(() => {
        span.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(id);
          cur.remove();
          resolve();
        }
      }, 1000 / (cps || 32));
    });
  }

  function spinFor(ln, ms) {
    return new Promise((resolve) => {
      if (reduce) return resolve();
      const f = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
      let i = 0;
      const id = setInterval(() => {
        ln.textContent = f[i++ % f.length] + " Réflexion…";
      }, 90);
      setTimeout(() => {
        clearInterval(id);
        resolve();
      }, ms);
    });
  }

  // GIF / meme « maison » (slot ; remplaçable par un <img> Giphy/Tenor).
  function gif(emoji, label) {
    const ln = document.createElement("div");
    ln.className = "ln";
    const box = document.createElement("span");
    box.className = "term-gif";
    const e = document.createElement("span");
    e.className = "emoji";
    e.textContent = emoji;
    box.append(e, document.createTextNode(" " + label));
    ln.appendChild(box);
    body.appendChild(ln);
    trim();
  }

  async function play() {
    body.textContent = "";

    line("$ claude", "ln--dim");
    await wait(500);
    line("👓  agent-claudy — Éducation minimum.", "ln--banner");
    await wait(700);
    await typeLine("> Construis-moi un site vitrine, vite fait bien fait.", "ln--prompt", 34);
    await wait(450);
    const spin = line("⠋ Réflexion…", "ln--dim");
    await spinFor(spin, 1100);
    spin.remove();

    line("▸ Claudy se met au travail →", "ln--ok");
    await wait(850);
    line("▸ Lancement d'un workflow (6 sous-agents)…", "ln--dim");
    await wait(700);
    gif("⌨️", "le code part en cacahuète…");
    await wait(1300);

    line("⚑ design — « Chef, rouge ou crème ? »", "ln--warn");
    await wait(1200);
    await typeLine("> Crème évidemment. T'es tendue comme une crampe.", "ln--prompt", 32);
    await wait(450);
    line("✓ design   ✓ Explore   ✓ code …", "ln--ok");
    await wait(700);
    line("✓ Workflow terminé — 6✓ / 6.", "ln--ok");
    await wait(450);
    line("✓ Build prêt en 4,2 s.", "ln--ok");
    await wait(450);
    gif("🎤⬇️", "*drop the mic*");
    await wait(800);
    line("« Remets la petite sœur. »", "ln--banner");

    await wait(2800);
    play(); // reboucle
  }

  play();
})();
