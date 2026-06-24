// agent-claudy frontend.
// - Subscribes to the /api/events SSE stream
// - Reconciles one tile (avatar + name + comic bubble) per agent
// - Head nod + quote bubble on a "speak / pause" rhythm via rAF

(function () {
  "use strict";

  const PX = 3; // scales the 64×64 avatar up to a 192×192 canvas (pixelated, CSS-scaled)
  const MINI_PX = 2; // sub-agent mini-heads (swarm): 128×128 canvas, displayed small in CSS
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

  // ── Manual session renaming (persisted locally via localStorage) ──────
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
    el.contentEditable = "plaintext-only";
    el.classList.add("editing");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // Commit: empty or = original name → remove the nickname; otherwise save it.
  function commitRename(el, id) {
    if (!el.isContentEditable) return;
    el.contentEditable = "false";
    el.classList.remove("editing");
    const typed = el.textContent.replace(/\s+/g, " ").trim();
    const original = (agents.get(id) || {}).name || "";
    setCustomName(id, !typed || typed === original ? null : typed);
    el.textContent = effectiveName(id);
  }

  // "Reduce motion" preference: when enabled, we don't scroll the ticker
  // (static wrapped fallback handled in CSS).
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Re-measure the ticker when the bubble changes SIZE (density, resize, creation).
  // Kept out of the rAF loop to avoid layout reads on every frame.
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

  // ── Rendering / reconciliation ──────────────────────────────────────────────

  // "Scroll only when needed" toggle: if the line fits on one row → static
  // centered (no motion); otherwise → marquee at constant speed. Called on text
  // change AND by the ResizeObserver (width change). Reads layout → out of the rAF loop.
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
      // One cycle's distance = half the track (2 equal copies). Duration = distance / speed.
      const cycle = card.bubbleTrackEl.getBoundingClientRect().width / 2;
      const speed = card.el.dataset.state === "needs_input" ? MARQUEE_SPEED_SLOW : MARQUEE_SPEED;
      card.bubbleTrackEl.style.setProperty("--marquee-duration", (cycle / speed).toFixed(2) + "s");
    }
  }

  // Write the text on BOTH copies (the 2nd, aria-hidden, only serves the marquee loop);
  // full text in the tooltip. Then (re)measure to choose static vs scrolling.
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

    const avatar = document.createElement("div");
    avatar.className = "avatar"; // status outline hugging the silhouette (CSS via data-state)
    const canvas = document.createElement("canvas");
    canvas.width = Claudy.GRID_W * PX;
    canvas.height = Claudy.GRID_H * PX;
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
    bubble.dataset.agentId = agent.id; // to find the card back from the ResizeObserver
    const bubbleText = document.createElement("div"); // viewport: clips the ticker to 1 line
    bubbleText.className = "bubble-text";
    const bubbleTrack = document.createElement("div"); // scrolling track (animated transform)
    bubbleTrack.className = "bubble-track";
    const seg0 = document.createElement("span");
    seg0.className = "bubble-seg";
    const seg1 = document.createElement("span"); // copy for the seamless loop
    seg1.className = "bubble-seg";
    seg1.setAttribute("aria-hidden", "true"); // avoids a double read by screen readers
    bubbleTrack.append(seg0, seg1);
    bubbleText.appendChild(bubbleTrack);
    bubble.appendChild(bubbleText);
    if (bubbleRO) bubbleRO.observe(bubble);

    // Sub-agent swarm: a row of mini-heads + counter, below the name.
    const children = document.createElement("div");
    children.className = "children";
    const childCount = document.createElement("span");
    childCount.className = "children-count";
    children.appendChild(childCount);

    // Comic order: bubble on top, head in the middle, name, then the swarm.
    el.append(bubble, avatar, name, children);
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
      childrenEl: children,
      childCountEl: childCount,
      childCards: new Map(), // childId -> { el, ctx, phase }
      phase: Math.random() * Math.PI * 2,
      renderedState: null,
      quoteIdx: Math.floor(Math.random() * QUOTES.length),
    };
    cards.set(agent.id, card);
    return card;
  }

  // Reconciles the sub-agent mini-heads of a session (swarm inside the tile).
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
        mini.appendChild(canvas);
        // Insert before the counter (which stays last, full width).
        card.childrenEl.insertBefore(mini, card.childCountEl);
        child = { el: mini, ctx: canvas.getContext("2d"), phase: Math.random() * Math.PI * 2 };
        card.childCards.set(sub.id, child);
      }
      child.status = status; // read by the animation loop (nod if "working")
      child.el.dataset.status = status; // outline color via CSS
      child.el.title = `${sub.name} — ${STATUS_LABEL[status] || status}`;
      child.el.setAttribute("aria-label", `sous-agent ${sub.name} : ${STATUS_LABEL[status] || status}`);
    }

    // Counter: workflow progress if available, otherwise a plain count.
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
    // Don't overwrite the name while it's being edited (double-click); otherwise the effective name (possible nickname).
    if (!card.nameEl.isContentEditable) card.nameEl.textContent = effectiveName(agent.id);
    card.el.dataset.state = agent.state; // drives the silhouette outline color (CSS)
    // Accessible label (screen reader) without a visible tooltip.
    card.el.setAttribute("aria-label", `${effectiveName(agent.id)} — ${LABELS[agent.state] || agent.state}`);

    if (agent.state !== card.renderedState) {
      // Bubble ALWAYS shown → the tile height doesn't change from one state to another.
      card.bubbleEl.classList.add("show");
      if (agent.state === "working") {
        // FIXED line chosen when entering "working" (scrolls if too long, doesn't rotate).
        card.quoteIdx = (card.quoteIdx + 1) % QUOTES.length;
        setBubble(card, QUOTES[card.quoteIdx]);
      } else if (agent.state === "needs_input") {
        setBubble(card, NEEDS_LINE);
        if (agent.request) card.bubbleEl.title = agent.request; // actual detail on hover
        if (els.srLive) {
          els.srLive.textContent = `${agent.name} réclame : ${agent.request || NEEDS_DEFAULT}`;
        }
      } else if (agent.state === "idle") {
        setBubble(card, IDLE_LINE);
      } else {
        setBubble(card, OFFLINE_LINE); // offline
      }
      card.renderedState = agent.state;
    } else if (agent.state === "needs_input" && agent.request) {
      // The request can change without changing state: we keep "Je t'attends !" and
      // update the detail on hover.
      card.bubbleEl.title = agent.request;
    }

    syncChildren(card, agent.children || [], agent.childExtra || 0, agent.swarm || null);
  }

  // Responsive density: the more agents there are, the smaller the tiles.
  function applyDensity(n) {
    // Single-line bubble (ticker) → very compact tiles: 2 columns fit from ~258px
    // (the floating window), and the grid stacks more of them on a wide screen.
    const [tile, avatar] =
      n <= 8 ? [100, 52] : n <= 16 ? [92, 47] : n <= 32 ? [84, 42] : [78, 37];
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

    // Remove the cards that have disappeared.
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

    // Realign the DOM order with the (name-sorted) order received from the server, but WITHOUT
    // touching the DOM if the order hasn't changed: we only move a node if it isn't
    // already in place. Essential — re-appendChild'ing every node on each
    // SSE message reset the scroll (position lost, unbearable).
    let prev = null;
    for (const agent of list) {
      const el = cards.get(agent.id).el;
      const ref = prev ? prev.nextSibling : els.grid.firstChild;
      if (el !== ref) els.grid.insertBefore(el, ref);
      prev = el;
    }

    // Counter, summary, density, empty state.
    const n = list.length;
    els.count.textContent = `${n} agent${n > 1 ? "s" : ""}`;
    els.empty.style.display = n === 0 ? "" : "none";
    applyDensity(n);
    updateSummary(list);
  }

  // ── Animation loop ────────────────────────────────────────────────────

  function frame(t) {
    for (const [id, card] of cards) {
      const agent = agents.get(id);
      if (!agent) continue;

      let bob = 0;
      let dim = false;
      let tint = null;

      if (agent.state === "working") {
        bob = Math.sin(t * 0.013 + card.phase) * 6; // nod: "he's talking"
        // The line is set on the state change (syncCard), not here: it stays FIXED
        // and scrolls in CSS. The loop only does the nod now.
      } else if (agent.state === "needs_input") {
        bob = Math.sin(t * 0.006 + card.phase) * 3; // soliciting
        tint = "#d65a4a";
      } else if (agent.state === "idle") {
        dim = true;
        bob = Math.sin(t * 0.0025 + card.phase) * 1.5; // gentle breathing
      } else {
        dim = true; // offline
      }

      Claudy.draw(card.ctx, { px: PX, bob, dim, tint });

      // Sub-agent mini-heads: always active → nodding, out of phase with each other.
      for (const child of card.childCards.values()) {
        // Only "working" heads nod; done/failed ones stay fixed
        // (dimmed if failed) to clearly read the run's frozen state.
        const working = child.status === "working" || child.status === undefined;
        const bob = working ? Math.sin(t * 0.013 + child.phase) * 3 : 0;
        Claudy.draw(child.ctx, { px: MINI_PX, bob, dim: child.status === "failed" });
      }
    }
    requestAnimationFrame(frame);
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
        if (msg.type === "agents") reconcile(msg.agents);
      } catch {
        /* ping or non-JSON message: ignored */
      }
    };
  }

  // Manual refresh: re-pulls the current state right away and reconnects the stream if needed.
  async function refreshNow() {
    if (els.refresh) els.refresh.classList.add("spinning");
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      if (data && data.type === "agents") reconcile(data.agents);
    } catch {
      /* server unreachable: the button just stops spinning */
    }
    if (!es || es.readyState === 2) connect(); // 2 = CLOSED → we re-establish the SSE stream
    setTimeout(() => els.refresh && els.refresh.classList.remove("spinning"), 600);
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  async function init() {
    try {
      const res = await fetch("/api/quotes");
      const data = await res.json();
      if (Array.isArray(data.quotes) && data.quotes.length) QUOTES = data.quotes;
    } catch {
      /* we keep the fallback */
    }

    if (els.refresh) els.refresh.addEventListener("click", refreshNow);
    connect();
    requestAnimationFrame(frame);
  }

  init();
})();
