// agent-claudy frontend.
// - Subscribes to the SSE stream /api/events
// - Reconciles one tile (avatar + name + comic bubble) per agent
// - Head nod + quote bubble on a "speak / pause" rhythm via rAF

(function () {
  "use strict";

  const PX = 3; // scales the 64×64 avatar up → 192×192 canvas (pixelated, scaled down via CSS)
  const MINI_PX = 2; // sub-agent mini-heads (swarm): 128×128 canvas, displayed small via CSS
  // Ticker: scroll speed in px/s. needs_input scrolls more slowly (more readable,
  // since it's an important request).
  const MARQUEE_SPEED = 45;
  const MARQUEE_SPEED_SLOW = 30;

  const FALLBACK_QUOTES = ["Éducation minimum !", "Y a moyen de tout, tout est négociable."];
  const NEEDS_DEFAULT = "Chef, ou tu sors ou j'te sors, mais faudra prendre une décision.";
  // Bubble ALWAYS visible (tile height stays constant); fixed text per state,
  // except "working" which picks a quote. Only changes on a state change.
  const IDLE_LINE = "Remets la petite sœur.";
  const NEEDS_LINE = "Je t'attends !";
  const OFFLINE_LINE = "À la revoyure.";
  const LABELS = {
    working: "en travail",
    idle: "en attente",
    needs_input: "demande !",
    offline: "hors ligne",
  };

  const els = {
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    count: document.getElementById("count"),
    summary: document.getElementById("summary"),
    conn: document.getElementById("conn"),
    connLabel: document.getElementById("conn-label"),
    srLive: document.getElementById("sr-live"),
    refresh: document.getElementById("refresh"),
  };

  let QUOTES = FALLBACK_QUOTES.slice();
  /** @type {EventSource|null} current SSE stream (kept so it can be reconnected on refresh). */
  let es = null;
  /** @type {Map<string, any>} last known state per agent */
  const agents = new Map();
  /** @type {Map<string, any>} DOM card + animation state per agent */
  const cards = new Map();
  // Préférences d'affichage (config serveur, via SSE) : lues par setActivity.
  let display = {};

  // Le hochement de tête est désormais une transform CSS (composité GPU, voir
  // styles.css), et le canvas n'est redessiné qu'au CHANGEMENT d'état : plus aucune
  // boucle requestAnimationFrame ni redraw permanent → scroll fluide même en iframe.

  // ── Manual session renaming (persisted locally via localStorage) ──────────────
  // A nickname takes precedence over the discovered/server name, for the given id.
  function customName(id) {
    try {
      return localStorage.getItem("claudy:name:" + id) || null;
    } catch {
      return null;
    }
  }
  function setCustomName(id, name) {
    try {
      if (name) localStorage.setItem("claudy:name:" + id, name);
      else localStorage.removeItem("claudy:name:" + id);
    } catch {
      /* localStorage unavailable: ignore */
    }
  }
  // Name to display: nickname if set, otherwise the agent's current name.
  function effectiveName(id) {
    const a = agents.get(id);
    return customName(id) || (a ? a.name : id);
  }
  // Inline name editing (double-click): makes the element editable and selects all.
  function startRename(el) {
    // Disable the card's drag while editing, otherwise selecting text by dragging
    // would start a card move instead.
    const card = el.closest(".card");
    if (card) card.draggable = false;
    el.contentEditable = "plaintext-only";
    el.classList.add("editing");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Commit: empty or = original name → drop the nickname; otherwise save it.
  function commitRename(el, id) {
    if (!el.isContentEditable) return;
    el.contentEditable = "false";
    el.classList.remove("editing");
    const card = el.closest(".card");
    if (card) card.draggable = true; // re-enable card drag once editing is done
    const typed = el.textContent.replace(/\s+/g, " ").trim();
    const original = (agents.get(id) || {}).name || "";
    setCustomName(id, !typed || typed === original ? null : typed);
    el.textContent = effectiveName(id);
  }

  // ── Manual card ordering (drag & drop, persisted locally) ──────────────────────
  // A user-defined order (array of ids) takes precedence over the server's name sort,
  // so cards can be dragged around to organise them — same spirit as the nicknames above.
  /** @type {string|null} id of the card currently being dragged (null when idle). */
  let dragging = null;
  function loadOrder() {
    try {
      const arr = JSON.parse(localStorage.getItem("claudy:order") || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveOrder(ids) {
    try {
      localStorage.setItem("claudy:order", JSON.stringify(ids));
    } catch {
      /* localStorage unavailable: ignore */
    }
  }
  // Freezes the current DOM order into localStorage (only the cards present → stale ids
  // get pruned automatically).
  function persistDomOrder() {
    const ids = [];
    for (const el of els.grid.querySelectorAll(".card")) {
      if (el.dataset.agentId) ids.push(el.dataset.agentId);
    }
    saveOrder(ids);
  }
  // Re-sorts the server list (sorted by name) by the saved manual order when present.
  // Ids not yet placed keep their server order, appended after the placed ones.
  function applyManualOrder(list) {
    const saved = loadOrder();
    if (!saved.length) return list;
    const rank = new Map(saved.map((id, i) => [id, i]));
    return list
      .map((agent, i) => ({ agent, i }))
      .sort((a, b) => {
        const ra = rank.has(a.agent.id) ? rank.get(a.agent.id) : Infinity;
        const rb = rank.has(b.agent.id) ? rank.get(b.agent.id) : Infinity;
        return ra - rb || a.i - b.i; // ties / unplaced ids keep the server (name) order
      })
      .map((x) => x.agent);
  }
  // Picks the card the dragged one should be inserted before (null → append at the end).
  // 2D grid: nearest card center, then before/after depending on the cursor side.
  function dragAfterElement(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const child of els.grid.querySelectorAll(".card:not(.dragging)")) {
      const box = child.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        const before = y < box.top || (y <= box.bottom && x < cx);
        best = before ? child : child.nextElementSibling;
      }
    }
    return best;
  }
  // Wires the grid-level drag handlers once (the per-card dragstart/dragend live in createCard).
  function setupDnd() {
    els.grid.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const dragEl = cards.get(dragging) && cards.get(dragging).el;
      if (!dragEl) return;
      const after = dragAfterElement(e.clientX, e.clientY);
      if (after == null) els.grid.appendChild(dragEl);
      else if (after !== dragEl) els.grid.insertBefore(dragEl, after);
    });
    els.grid.addEventListener("drop", (e) => {
      if (dragging) e.preventDefault(); // keep the DOM order we built during dragover
    });
  }

  // "Reduce motion" preference: when enabled, the ticker doesn't scroll
  // (static wrapped fallback handled in CSS).
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Re-measures the ticker when the bubble changes SIZE (density, resize, creation).
  // Done on change (ResizeObserver), never by polling → no repeated layout reads.
  const bubbleRO =
    "ResizeObserver" in window
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const card = cards.get(entry.target.dataset.agentId);
            if (card) measureBubble(card);
          }
        })
      : null;

  // Re-measure everything if the animation preference changes mid-session.
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", () => {
      for (const card of cards.values()) measureBubble(card);
    });
  }

  // ── Render / reconciliation ─────────────────────────────────────────────

  // "Scroll only if needed" toggle: if the line fits on one line → static centered
  // (no movement); otherwise → marquee at constant speed. Called on text change AND
  // by the ResizeObserver (width change). Reads layout → only on change, never per frame.
  function measureBubble(card) {
    const bubble = card.bubbleEl;
    if (!bubble.classList.contains("show")) return;
    // Reduced motion: no marquee; the CSS fallback wraps the text over a few lines.
    if (reduceMotion.matches) {
      bubble.classList.remove("is-marquee");
      return;
    }
    // "Flat" measurement (without the 2nd copy): actual text width vs visible width.
    bubble.classList.remove("is-marquee");
    const visible = card.bubbleTextEl.clientWidth;
    const needed = card.bubbleSegEls[0].scrollWidth;
    if (needed - visible > 1) {
      bubble.classList.add("is-marquee");
      // Distance of one cycle = half the track (2 equal copies). Duration = distance / speed.
      const cycle = card.bubbleTrackEl.getBoundingClientRect().width / 2;
      const speed = card.el.dataset.state === "needs_input" ? MARQUEE_SPEED_SLOW : MARQUEE_SPEED;
      card.bubbleTrackEl.style.setProperty("--marquee-duration", (cycle / speed).toFixed(2) + "s");
    }
  }

  // We write the text on BOTH copies (the 2nd, aria-hidden, only serves the marquee loop);
  // full text in the tooltip. Then we (re)measure to choose static vs scrolling.
  // Current tool → emoji + short label. MCP tools (mcp__server__action)
  // are shortened to "server/action". Unknown → raw name.
  // Nom de l'outil tel quel (texte mono, sans emoji → reste dans le design system).
  // Les outils MCP sont raccourcis en « serveur/action ».
  function prettyTool(tool) {
    if (!tool) return "";
    if (tool.startsWith("mcp__")) {
      const parts = tool.split("__");
      return `${parts[1] || ""}${parts[2] ? "/" + parts[2] : ""}`;
    }
    return tool;
  }
  // claude-opus-4-8 → "Opus 4.8"; claude-sonnet-4-6 → "Sonnet 4.6"; etc.
  function prettyModel(model) {
    if (!model) return "";
    const m = String(model).match(/(opus|sonnet|haiku|fable)-(\d+)-?(\d+)?/i);
    if (!m) return "";
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
  }
  // Waiting reason (Claude Code's `waitingFor` field) → readable text.
  const WAITING_LABEL = {
    "dialog open": "dialogue ouvert (permission ?)",
    "tool use": "validation d'un outil",
    permission: "demande de permission",
  };
  function prettyWaiting(reason) {
    if (!reason) return "";
    return WAITING_LABEL[reason] || `en attente : ${reason}`;
  }

  // Updates the activity line; empty → hidden (CSS via :empty).
  // Permission mode (permissionMode) -> readable chip. "default" stays hidden (normal).
  // Mode -> corner picto (top-left). Only behaviour-changing modes; auto/default empty.
  const MODE_PICTO = { plan: "plan", acceptEdits: "edit", bypassPermissions: "bypass", auto: "auto", default: "normal" };
  const MODE_TITLE = { plan: "Mode plan", acceptEdits: "Mode edit (auto-accept)", bypassPermissions: "Mode bypass permissions", auto: "Mode auto", default: "Mode normal" };
  // Effort -> corner picto (top-right). Only elevated levels; ultracode = the violet star.
  const EFFORT_PICTO = { high: "high", xhigh: "xhigh", max: "max", ultracode: "ultra" };
  const EFFORT_TITLE = { high: "Effort high", xhigh: "Effort xhigh", max: "Effort max", ultracode: "ULTRACODE — xhigh + workflows" };
  // Sets the corner pictos; ultracode gets the styled star and flags the card (data-ultra)
  // so the head itself gains a violet halo.
  function setBadges(card, mode, effort) {
    card.pictoTLEl.textContent = MODE_PICTO[mode] || "";
    card.pictoTLEl.title = MODE_TITLE[mode] || "";
    card.pictoTREl.textContent = EFFORT_PICTO[effort] || "";
    card.pictoTREl.title = EFFORT_TITLE[effort] || "";
    const ultra = effort === "ultracode";
    card.pictoTREl.classList.toggle("picto--ultra", ultra);
    card.el.toggleAttribute("data-ultra", ultra);
  }

  // Tool + model on the head's hover title (kept off the card so it stays small).
  // Suppressed when the "activity" display pref is off.
  function setActivity(card, activity, show) {
    const on = display.activity !== false && show && activity;
    const txt = on ? [prettyTool(activity.tool), prettyModel(activity.model)].filter(Boolean).join(" · ") : "";
    card.activityEl.textContent = txt;
  }

  function setBubble(card, text) {
    card.bubbleSegEls[0].textContent = text;
    card.bubbleSegEls[1].textContent = text;
    card.bubbleEl.title = text;
    measureBubble(card);
  }

  function createCard(agent) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.state = agent.state;
    el.dataset.agentId = agent.id; // identifies the card for reordering
    // Drag to reorder: the saved order then takes precedence over the server's name sort.
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragging = agent.id;
      el.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", agent.id);
        } catch {
          /* some browsers forbid setData here: harmless */
        }
      }
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      dragging = null;
      persistDomOrder(); // freeze the new order
    });

    const avatar = document.createElement("div");
    avatar.className = "avatar"; // status outline hugging the silhouette (CSS via data-state)
    const canvas = document.createElement("canvas");
    canvas.width = Claudy.GRID_W * PX;
    canvas.height = Claudy.GRID_H * PX;
    // Negative delay desyncs the CSS nod so heads don't bob in unison.
    canvas.style.animationDelay = `-${(Math.random() * 2.4).toFixed(2)}s`;
    avatar.appendChild(canvas);
    // Click on the head: brings the agent's window (VS Code / terminal) to the foreground.
    avatar.style.cursor = "pointer";
    avatar.title = "Aller à la fenêtre de l'agent";
    avatar.addEventListener("click", () => {
      fetch(`/api/focus/${encodeURIComponent(agent.id)}`, { method: "POST" }).catch(() => {});
    });

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = effectiveName(agent.id);
    name.title = "Double-cliquer pour renommer";
    name.addEventListener("dblclick", () => startRename(name));
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        name.blur(); // → commit
      } else if (e.key === "Escape") {
        e.preventDefault();
        name.textContent = effectiveName(agent.id); // cancels the input
        name.blur();
      }
    });
    name.addEventListener("blur", () => commitRename(name, agent.id));

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dataset.agentId = agent.id; // to find the card again from the ResizeObserver
    const bubbleText = document.createElement("div"); // viewport: clips the ticker to 1 line
    bubbleText.className = "bubble-text";
    const bubbleTrack = document.createElement("div"); // scrolling track (animated transform)
    bubbleTrack.className = "bubble-track";
    const seg0 = document.createElement("span");
    seg0.className = "bubble-seg";
    const seg1 = document.createElement("span"); // copy for the seamless loop
    seg1.className = "bubble-seg";
    seg1.setAttribute("aria-hidden", "true"); // avoids double reading by screen readers
    bubbleTrack.append(seg0, seg1);
    bubbleText.appendChild(bubbleTrack);
    bubble.appendChild(bubbleText);
    if (bubbleRO) bubbleRO.observe(bubble);

    // Current activity: last tool + model (e.g. "✏️ Edit · Opus 4.8").
    // Hidden as long as there's nothing to show (idle session).
    // Session badges: mode (plan/edit...) + effort level (ultracode highlighted).
    // Each chip hides when empty (CSS :empty); the row collapses when both are empty.
    // Corner pictos hugging the head: mode (top-left) + effort (top-right). Absolute,
    // zero card height, hidden when empty. Tool/model go on the head's hover title.
    const pictoTL = document.createElement("div");
    pictoTL.className = "picto picto--tl";
    const pictoTR = document.createElement("div");
    pictoTR.className = "picto picto--tr picto--effort";
    avatar.append(pictoTL, pictoTR);

    // Thin line under the name: current tool + model (e.g. "✏️ Edit · Opus 4.8").
    const activity = document.createElement("div");
    activity.className = "activity";

    // Sub-agent swarm: row of mini-heads + counter, below the name.
    const children = document.createElement("div");
    children.className = "children";
    const childCount = document.createElement("span");
    childCount.className = "children-count";
    children.appendChild(childCount);

    // Comic-panel order: bubble on top, head in the middle, name, activity, then the swarm.
    el.append(bubble, avatar, name, activity, children);
    els.grid.appendChild(el);

    const card = {
      el,
      canvas,
      ctx: canvas.getContext("2d"),
      nameEl: name,
      bubbleEl: bubble,
      bubbleTextEl: bubbleText,
      bubbleTrackEl: bubbleTrack,
      bubbleSegEls: [seg0, seg1],
      avatarEl: avatar,
      pictoTLEl: pictoTL,
      pictoTREl: pictoTR,
      activityEl: activity,
      childrenEl: children,
      childCountEl: childCount,
      childCards: new Map(), // childId -> { el, ctx, status }
      renderedState: null,
      quoteIdx: Math.floor(Math.random() * QUOTES.length),
    };
    cards.set(agent.id, card);
    return card;
  }

  // Reconciles the mini-heads of a session's sub-agents (swarm in the tile).
  // Each head carries a status: working (pulsing), done (green), failed (red).
  function syncChildren(card, list, extra, swarm) {
    const wanted = new Set(list.map((c) => c.id));
    for (const [id, child] of card.childCards) {
      if (!wanted.has(id)) {
        child.el.remove();
        card.childCards.delete(id);
      }
    }
    const STATUS_LABEL = { working: "en cours", done: "terminé", failed: "échoué" };
    for (const sub of list) {
      const status = sub.status || "working";
      let child = card.childCards.get(sub.id);
      if (!child) {
        const mini = document.createElement("div");
        mini.className = "mini";
        const canvas = document.createElement("canvas");
        canvas.width = Claudy.GRID_W * MINI_PX;
        canvas.height = Claudy.GRID_H * MINI_PX;
        canvas.style.animationDelay = `-${(Math.random() * 1.6).toFixed(2)}s`; // desync the nod
        mini.appendChild(canvas);
        // Insert before the counter (which stays last, full width).
        card.childrenEl.insertBefore(mini, card.childCountEl);
        child = { el: mini, ctx: canvas.getContext("2d") };
        card.childCards.set(sub.id, child);
      }
      // Repaint only when the status changes (no per-frame loop). The nod is CSS.
      if (child.status !== status) {
        paintChild(child.ctx, status);
      }
      child.status = status;
      child.el.dataset.status = status; // outline color (and nod animation) via CSS
      child.el.title = `${sub.name} — ${STATUS_LABEL[status] || status}`;
      child.el.setAttribute("aria-label", `sous-agent ${sub.name} : ${STATUS_LABEL[status] || status}`);
    }

    // Counter: workflow progress if available, otherwise just a count.
    if (swarm && swarm.total) {
      const parts = [`${swarm.done}✓`];
      if (swarm.failed) parts.push(`${swarm.failed}✗`);
      if (swarm.working) parts.push(`${swarm.working}◔`);
      card.childCountEl.textContent = `${parts.join(" ")} / ${swarm.total}`;
    } else {
      const n = list.length + (extra || 0);
      card.childCountEl.textContent = n ? `${n} sous-agent${n > 1 ? "s" : ""}` : "";
    }
  }

  // Updates name / status / bubble when the state changes (outside the working scroll).
  function syncCard(card, agent) {
    // Don't overwrite the name while it's being edited (double-click); otherwise effective name (possible nickname).
    if (!card.nameEl.isContentEditable) card.nameEl.textContent = effectiveName(agent.id);
    card.el.dataset.state = agent.state; // drives the silhouette outline color (CSS)
    // Accessible label (screen reader) without a visible tooltip.
    card.el.setAttribute("aria-label", `${effectiveName(agent.id)} — ${LABELS[agent.state] || agent.state}`);

    if (agent.state !== card.renderedState) {
      paintHead(card.ctx, PX, agent.state, agent.effort === "ultracode"); // redraw for the new state
      // Bubble ALWAYS shown → the tile height doesn't change from one state to another.
      card.bubbleEl.classList.add("show");
      if (agent.state === "working") {
        // FIXED line chosen when entering "working" (scrolls if too long, doesn't rotate).
        card.quoteIdx = (card.quoteIdx + 1) % QUOTES.length;
        setBubble(card, QUOTES[card.quoteIdx]);
      } else if (agent.state === "needs_input") {
        setBubble(card, NEEDS_LINE);
        // Actual detail on hover: explicit request (hook) or waiting reason (waitingFor).
        const detail = agent.request || prettyWaiting(agent.waitingFor);
        if (detail) card.bubbleEl.title = detail;
        if (els.srLive) {
          els.srLive.textContent = `${agent.name} réclame : ${detail || NEEDS_DEFAULT}`;
        }
      } else if (agent.state === "idle") {
        setBubble(card, IDLE_LINE);
      } else {
        setBubble(card, OFFLINE_LINE); // offline
      }
      card.renderedState = agent.state;
    } else if (agent.state === "needs_input") {
      // The request / waiting reason can change without changing state: we keep
      // "Je t'attends !" and update the detail on hover.
      const detail = agent.request || prettyWaiting(agent.waitingFor);
      if (detail) card.bubbleEl.title = detail;
    }

    // Current activity: visible as soon as we have one (the tool changes during "working").
    setActivity(card, agent.activity, !!agent.activity);
    setBadges(card, agent.mode, agent.effort);

    syncChildren(card, agent.children || [], agent.childExtra || 0, agent.swarm || null);
  }

  // Responsive density: the more agents there are, the smaller the tiles.
  // Display prefs (server config): toggle element visibility via grid-level classes.
  // Missing key defaults to visible (true) so an older server doesn't hide everything.
  function applyDisplay(d) {
    display = d || {};
    els.grid.classList.toggle("hide-bubble", display.bubble === false);
    els.grid.classList.toggle("hide-badges", display.badges === false);
    els.grid.classList.toggle("hide-swarm", display.swarm === false);
  }

  function applyDensity(n) {
    // Single-line bubble (ticker) → very compact tiles: 2 columns fit from ~258px
    // (the floating window), and the grid stacks more of them on a wide screen.
    const [tile, avatar] =
      n <= 8 ? [100, 50] : n <= 16 ? [92, 46] : n <= 32 ? [84, 40] : [78, 36];
    els.grid.style.setProperty("--tile", `${tile}px`);
    els.grid.style.setProperty("--avatar", `${avatar}px`);
  }

  // Compact status summary in the top bar (● 3  ◔ 1  ‼ 1).
  function updateSummary(list) {
    if (!els.summary) return;
    const c = { working: 0, idle: 0, needs_input: 0, offline: 0 };
    for (const a of list) c[a.state] = (c[a.state] || 0) + 1;
    // Compact indicator: icon ABOVE the number (mini-column) → takes little width.
    const stat = (cls, ico, n) =>
      n
        ? `<span class="stat ${cls}"><span class="stat-ico">${ico}</span><span class="stat-num">${n}</span></span>`
        : "";
    els.summary.innerHTML = [
      stat("stat--working", "●", c.working),
      stat("stat--needs", "‼", c.needs_input),
      stat("stat--idle", "◔", c.idle),
      stat("stat--offline", "○", c.offline),
    ].join(""); // static content + numbers: safe
  }

  function reconcile(list) {
    const ids = new Set(list.map((a) => a.id));

    // Remove cards that have disappeared.
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        if (bubbleRO) bubbleRO.unobserve(card.bubbleEl);
        card.el.remove();
        cards.delete(id);
        agents.delete(id);
      }
    }

    // Create / update.
    for (const agent of list) {
      agents.set(agent.id, agent);
      let card = cards.get(agent.id);
      if (!card) card = createCard(agent);
      syncCard(card, agent);
    }

    // Realign the DOM order with the display order, but WITHOUT touching the DOM if the
    // order hasn't changed: we only move a node if it isn't already in place. Essential —
    // re-appendChild'ing every node on each SSE message reset the scroll (loss of position,
    // unbearable). The display order is the user's manual order (drag & drop) when set,
    // otherwise the server's name sort. Skipped while a drag is in progress so the live
    // reordering isn't fought by an incoming SSE message.
    if (!dragging) {
      let prev = null;
      for (const agent of applyManualOrder(list)) {
        const el = cards.get(agent.id).el;
        const ref = prev ? prev.nextSibling : els.grid.firstChild;
        if (el !== ref) els.grid.insertBefore(el, ref);
        prev = el;
      }
    }

    // Counter, summary, density, empty state.
    const n = list.length;
    els.count.textContent = `${n} agent${n > 1 ? "s" : ""}`;
    els.empty.style.display = n === 0 ? "" : "none";
    applyDensity(n);
    updateSummary(list);
  }

  // ── Head painting (on state change only — the nod is CSS) ────────────────────

  // Outline colors, baked into the canvas by Claudy.draw (no CSS filter anymore).
  // Kept in sync with the --green/--red/--muted CSS vars and the ultracode violet.
  const RING = { working: "#6fae5a", needs_input: "#d65a4a", idle: "#a8967c", offline: "#4a4338" };
  const MINI_RING = { working: "#e0a93b", done: "#6fae5a", failed: "#d65a4a" };
  const ULTRA_RING = "#8b5cf6";

  // Map a state to its visual: idle/offline dimmed, needs_input tinted red,
  // outline color per state (violet when ultracode).
  function paintHead(ctx, px, state, ultra) {
    Claudy.draw(ctx, {
      px,
      dim: state === "idle" || state === "offline",
      tint: state === "needs_input" ? "#d65a4a" : null,
      ring: ultra ? ULTRA_RING : RING[state] || RING.idle,
    });
  }

  function paintChild(ctx, status) {
    Claudy.draw(ctx, { px: MINI_PX, dim: status === "failed", ring: MINI_RING[status] || MINI_RING.working });
  }

  // Repaint every head + mini-head with its current state (used when the face
  // image finishes loading, since there's no longer a loop to catch up).
  function repaintAll() {
    for (const card of cards.values()) {
      paintHead(card.ctx, PX, card.el.dataset.state, card.el.hasAttribute("data-ultra"));
      for (const child of card.childCards.values()) {
        paintChild(child.ctx, child.status);
      }
    }
  }

  // Pause the CSS nod animations (off-screen / hidden tab): animation-play-state.
  function setAnimPaused(paused) {
    els.grid.classList.toggle("anim-paused", paused);
  }

  // ── SSE connection ──────────────────────────────────────────────────────────

  function setConn(ok) {
    els.conn.className = "dot " + (ok ? "dot--on" : "dot--off");
    els.connLabel.textContent = ok ? "connecté" : "déconnecté";
  }

  function connect() {
    if (es) es.close(); // avoids duplicate streams on a reconnection (refresh)
    es = new EventSource("/api/events");
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSource reconnects on its own
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "agents") {
          applyDisplay(msg.display);
          reconcile(msg.agents);
        }
      } catch {
        /* ping or non-JSON message: ignored */
      }
    };
  }

  // Manual refresh: re-pulls the current state immediately and reconnects the stream if needed.
  async function refreshNow() {
    if (els.refresh) els.refresh.classList.add("spinning");
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      if (data && data.type === "agents") {
        applyDisplay(data.display);
        reconcile(data.agents);
      }
    } catch {
      /* server unreachable: the button just stops spinning */
    }
    if (!es || es.readyState === 2) connect(); // 2 = CLOSED → re-establish the SSE stream
    setTimeout(() => els.refresh && els.refresh.classList.remove("spinning"), 600);
  }

  // ── Startup ───────────────────────────────────────────────────────────────────

  async function init() {
    try {
      const res = await fetch("/api/quotes");
      const data = await res.json();
      if (Array.isArray(data.quotes) && data.quotes.length) QUOTES = data.quotes;
    } catch {
      /* keep the fallback */
    }

    if (els.refresh) els.refresh.addEventListener("click", refreshNow);
    setupDnd();
    connect();
    // Repaint heads once the face image is ready (no loop to catch up anymore).
    Claudy.onReady(repaintAll);
    // Pause the CSS nods when the tab is hidden or an embedding host asks (the
    // landing posts {type:"claudy-render", active} via IntersectionObserver).
    document.addEventListener("visibilitychange", () => setAnimPaused(document.hidden));
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (d && d.type === "claudy-render") setAnimPaused(!d.active);
    });
  }

  init();
})();
