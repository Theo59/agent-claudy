// agent-claudy — settings panel (⚙).
//
// Reads the server config (GET /api/config: schema + values + keys locked by the env)
// and drives it (PUT /api/config) without touching environment variables.
// Also hosts the demo-mode controls (moved out of the topbar).
//
// Opened by the ⚙ button or the #settings anchor (used by the macOS menubar app).
// Vanilla, zero dependencies.

(function () {
  "use strict";

  const openBtn = document.getElementById("settings-open");
  let dialog = null;
  let bodyEl = null;
  let statusEl = null;
  let meta = null; // { schema, values, overridden, path }

  // Reuses the shared mark defined in index.html (#claudy-mark).
  const GLASSES = '<svg aria-hidden="true"><use href="#claudy-mark"/></svg>';

  // ── Server exchanges ─────────────────────────────────────────────────────────
  async function loadConfig() {
    const res = await fetch("/api/config");
    meta = await res.json();
    render();
  }

  async function put(patch) {
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      meta = await res.json();
      flash("Enregistré ✓");
      render(); // reflects normalized values + any locks
    } catch {
      flash("Échec de l'enregistrement", true);
    }
  }

  function demo(action, count) {
    fetch("/api/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(count != null ? { action, count } : { action }),
    }).catch(() => {});
  }

  // ── Panel construction ───────────────────────────────────────────────────────
  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "settings";
    dialog.innerHTML =
      '<form method="dialog" class="settings-head">' +
      `<span class="settings-title"><span class="brand-mark">${GLASSES}</span>Réglages</span>` +
      '<button class="icon-btn" value="close" aria-label="Fermer">✕</button>' +
      "</form>" +
      '<div class="settings-body"></div>' +
      '<div class="settings-foot"><span class="settings-status" aria-live="polite"></span>' +
      '<span class="settings-path"></span></div>';
    document.body.appendChild(dialog);
    bodyEl = dialog.querySelector(".settings-body");
    statusEl = dialog.querySelector(".settings-status");

    // Close by clicking the backdrop (outside the content).
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  function flash(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle("is-error", !!isError);
    clearTimeout(flash._t);
    flash._t = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.classList.remove("is-error");
    }, 1800);
  }

  // A single settings row (label + control + badges).
  function optionRow(opt) {
    const value = meta.values[opt.key];
    const locked = meta.overridden.includes(opt.key);

    const row = document.createElement("label");
    row.className = "set-row";

    const head = document.createElement("span");
    head.className = "set-label";
    head.textContent = opt.label;
    if (opt.restart) head.appendChild(badge("redémarrage requis", "warn"));
    if (locked) head.appendChild(badge(`défini par ${opt.env}`, "lock"));
    row.appendChild(head);

    let control;
    if (opt.type === "bool") {
      control = document.createElement("input");
      control.type = "checkbox";
      control.className = "set-toggle";
      control.checked = !!value;
      control.addEventListener("change", () => put({ [opt.key]: control.checked }));
    } else {
      control = document.createElement("input");
      control.type = opt.type === "number" ? "number" : "text";
      control.className = "set-input";
      control.value = value;
      // Commit on blur / Enter (change), not on every keystroke.
      control.addEventListener("change", () => {
        const v = opt.type === "number" ? Number(control.value) : control.value;
        put({ [opt.key]: v });
      });
    }
    control.disabled = locked; // locked by an environment variable
    row.appendChild(control);
    return row;
  }

  function badge(text, kind) {
    const b = document.createElement("span");
    b.className = `set-badge set-badge--${kind}`;
    b.textContent = text;
    return b;
  }

  function render() {
    if (!meta) return;
    bodyEl.textContent = "";

    // Common settings, grouped (the "advanced" options go in a shared collapsible).
    const groups = new Map();
    const advanced = [];
    for (const opt of meta.schema) {
      if (opt.advanced) advanced.push(opt);
      else {
        if (!groups.has(opt.group)) groups.set(opt.group, []);
        groups.get(opt.group).push(opt);
      }
    }

    for (const [group, opts] of groups) {
      bodyEl.appendChild(section(group, opts));
    }

    // Demo mode (moved here from the topbar).
    bodyEl.appendChild(demoSection());

    // Collapsed advanced options.
    if (advanced.length) {
      const det = document.createElement("details");
      det.className = "set-advanced";
      const sum = document.createElement("summary");
      sum.textContent = "Options avancées";
      det.appendChild(sum);
      for (const opt of advanced) det.appendChild(optionRow(opt));
      bodyEl.appendChild(det);
    }

    dialog.querySelector(".settings-path").textContent = meta.path;
  }

  function section(title, opts) {
    const sec = document.createElement("section");
    sec.className = "set-section";
    const h = document.createElement("h3");
    h.textContent = title;
    sec.appendChild(h);
    for (const opt of opts) sec.appendChild(optionRow(opt));
    return sec;
  }

  function demoSection() {
    const sec = document.createElement("section");
    sec.className = "set-section";
    const h = document.createElement("h3");
    h.textContent = "Mode démo";
    sec.appendChild(h);

    const row = document.createElement("div");
    row.className = "set-row set-row--actions";
    const label = document.createElement("span");
    label.className = "set-label";
    label.textContent = "Têtes factices (essaim de démonstration)";
    row.appendChild(label);

    const actions = document.createElement("span");
    actions.className = "set-actions";
    const count = document.createElement("input");
    count.type = "number";
    count.className = "set-input set-input--mini";
    count.value = 6;
    count.min = 1;
    count.max = 6;
    const start = document.createElement("button");
    start.type = "button";
    start.className = "btn";
    start.textContent = "Démarrer";
    start.addEventListener("click", () => demo("start", Math.max(1, Number(count.value) || 6)));
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn ghost";
    stop.textContent = "Arrêter";
    stop.addEventListener("click", () => demo("stop"));
    actions.append(count, start, stop);
    row.appendChild(actions);
    sec.appendChild(row);
    return sec;
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function open() {
    if (!dialog) build();
    loadConfig();
    if (!dialog.open) dialog.showModal();
  }

  if (openBtn) openBtn.addEventListener("click", open);

  // The menubar app opens  http://…/#settings  → we unfold the panel on load.
  if (location.hash === "#settings") open();
  window.addEventListener("hashchange", () => {
    if (location.hash === "#settings") open();
  });
})();
