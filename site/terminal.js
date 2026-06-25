// agent-claudy — MASTER SCRIPT for the diptych (landing page).
//
// A single timeline drives EVERYTHING, in lockstep:
//   - the terminals of several Claude sessions (left), typing/scrolling away;
//   - the REAL Claudy interface (iframe, right) via postMessage → app.js renders the
//     cards/bubbles/swarm exactly like the app, at the same instant as the terminals.
// Respects prefers-reduced-motion.

(function () {
  "use strict";

  const SESSIONS = [
    { id: "cc-1", name: "agent-claudy" },
    { id: "cc-2", name: "jetsite" },
    { id: "cc-3", name: "daphn-e-lachavanne" },
  ];

  const iframe = document.querySelector(".device-screen");
  const bodies = {};
  for (const s of SESSIONS) bodies[s.id] = document.getElementById("term-" + s.id);
  if (!Object.values(bodies).every(Boolean)) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? Math.min(ms, 120) : ms));

  // ── Claudy state per session → snapshot sent to the iframe ──────────────────
  const st = {};
  for (const s of SESSIONS) st[s.id] = { state: "idle", request: null, children: [], swarm: null };
  let ready = false;

  function snapshot() {
    return {
      type: "agents",
      agents: SESSIONS.map((s) => ({
        id: s.id,
        name: s.name,
        state: st[s.id].state,
        request: st[s.id].request,
        children: st[s.id].children || [],
        childExtra: 0,
        swarm: st[s.id].swarm || null,
      })),
    };
  }
  function post() {
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(snapshot(), "*");
  }
  function set(id, patch) {
    Object.assign(st[id], patch);
    post();
  }
  // The iframe signals it's ready → we (re)push the current state.
  window.addEventListener("message", (e) => {
    if (e.data === "claudy-ready") {
      ready = true;
      post();
    }
  });

  // Workflow swarm (cc-1) making progress: `done` heads finished.
  function swarmSet(done) {
    const names = ["Explore", "design", "code", "blog-researcher", "general-purpose", "Explore"];
    const children = names.map((name, i) => ({
      id: `cc-1-sub-${i}`,
      name,
      status: i < done ? "done" : "working",
      workflowId: "wf_demo",
    }));
    return { children, swarm: { done, failed: 0, working: children.length - done, total: children.length } };
  }

  // ── Terminal helpers (per session) ──────────────────────────────────────────
  function trim(body) {
    while (body.childNodes.length > 24) body.removeChild(body.firstChild);
  }
  function line(id, text, cls) {
    const body = bodies[id];
    const ln = document.createElement("div");
    ln.className = "ln" + (cls ? " " + cls : "");
    ln.textContent = text;
    body.appendChild(ln);
    trim(body);
    return ln;
  }
  function typeLine(id, text, cls, cps) {
    const body = bodies[id];
    return new Promise((resolve) => {
      const ln = document.createElement("div");
      ln.className = "ln" + (cls ? " " + cls : "");
      const span = document.createElement("span");
      const cur = document.createElement("span");
      cur.className = "cur";
      cur.textContent = " ";
      ln.append(span, cur);
      body.appendChild(ln);
      trim(body);
      if (reduce) {
        span.textContent = text;
        cur.remove();
        return resolve();
      }
      let i = 0;
      const t = setInterval(() => {
        span.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(t);
          cur.remove();
          resolve();
        }
      }, 1000 / (cps || 30));
    });
  }
  function spin(ln, ms) {
    return new Promise((resolve) => {
      if (reduce) return resolve();
      const f = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
      let i = 0;
      const t = setInterval(() => {
        ln.textContent = f[i++ % f.length] + " Réflexion…";
      }, 90);
      setTimeout(() => {
        clearInterval(t);
        resolve();
      }, ms);
    });
  }
  function gif(id, emoji, label) {
    const body = bodies[id];
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
    trim(body);
  }

  // ── The scenario (replayed in a loop) ───────────────────────────────────────
  async function play() {
    for (const s of SESSIONS) {
      bodies[s.id].textContent = "";
      st[s.id] = { state: "idle", request: null, children: [], swarm: null };
    }
    post();

    line("cc-1", "$ claude", "ln--dim");
    line("cc-1", "✶ agent-claudy — prêt.", "ln--banner");
    await wait(550);
    await typeLine("cc-1", "> Construis le site vitrine, vite fait.", "ln--prompt", 32);
    set("cc-1", { state: "working" });
    await wait(450);

    line("cc-2", "$ claude", "ln--dim");
    await typeLine("cc-2", "> Refonte de la home jetsite.", "ln--prompt", 30);
    set("cc-2", { state: "working" });
    await wait(450);

    const s1 = line("cc-1", "⠋ Réflexion…", "ln--dim");
    await spin(s1, 850);
    s1.remove();
    line("cc-1", "▸ Workflow : 6 sous-agents", "ln--ok");
    set("cc-1", swarmSet(0));
    await wait(550);

    line("cc-3", "$ claude", "ln--dim");
    await typeLine("cc-3", "> Migration des médias vers Sanity.", "ln--prompt", 28);
    set("cc-3", { state: "working" });
    await wait(550);

    set("cc-1", swarmSet(2));
    line("cc-1", "✓ Explore   ✓ design", "ln--ok");
    await wait(750);

    line("cc-2", "⚑ « Chef, rouge ou crème ? »", "ln--warn");
    set("cc-2", { state: "needs_input", request: "Chef, rouge ou crème ? Faut prendre une décision." });
    await wait(1300);
    await typeLine("cc-2", "> Crème évidemment. T'es tendue comme une crampe.", "ln--prompt", 28);
    set("cc-2", { state: "working", request: null });
    line("cc-2", "✓ home refaite.", "ln--ok");
    await wait(500);

    set("cc-1", swarmSet(4));
    line("cc-1", "✓ code   ✓ blog-researcher", "ln--ok");
    await wait(600);
    line("cc-3", "✓ médias externalisés.", "ln--ok");
    set("cc-3", { state: "idle" });
    await wait(550);

    set("cc-1", swarmSet(6));
    line("cc-1", "✓ Workflow 6✓ / 6 — Build prêt.", "ln--ok");
    gif("cc-1", "🎤⬇️", "*drop the mic*");
    await wait(700);
    line("cc-1", "« Remets la petite sœur. »", "ln--banner");

    await wait(2800);
    play(); // loop back
  }

  play();
})();
