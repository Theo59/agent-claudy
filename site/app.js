// Frontend agent-claudy.
// - S'abonne au flux SSE /api/events
// - Réconcilie une tuile (avatar + nom + bulle BD) par agent
// - Hochement de tête + bulle de citation au rythme « parler / pause » via rAF

(function () {
  "use strict";

  const PX = 3; // agrandissement de l'avatar 64×64 → canvas 192×192 (pixelisé, mis à l'échelle CSS)
  const MINI_PX = 2; // mini-têtes des sous-agents (essaim) : canvas 128×128, affiché petit en CSS
  // Ticker : vitesse de défilement en px/s. needs_input défile plus lentement (plus lisible,
  // car c'est une demande importante).
  const MARQUEE_SPEED = 45;
  const MARQUEE_SPEED_SLOW = 30;

  const FALLBACK_QUOTES = ["Éducation minimum !", "Y a moyen de tout, tout est négociable."];
  const NEEDS_DEFAULT = "Chef, ou tu sors ou j'te sors, mais faudra prendre une décision.";
  // Bulle TOUJOURS visible (la hauteur de tuile reste constante) ; texte fixe selon l'état,
  // sauf "working" qui pioche une citation. Ne change qu'au changement d'état.
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
  /** @type {EventSource|null} flux SSE courant (gardé pour pouvoir le reconnecter au refresh). */
  let es = null;
  /** @type {Map<string, any>} dernier état connu par agent */
  const agents = new Map();
  /** @type {Map<string, any>} carte DOM + état d'animation par agent */
  const cards = new Map();

  // ── Renommage manuel des sessions (persisté localement via localStorage) ──────
  // Un surnom prend le pas sur le nom découvert/serveur, pour l'id donné.
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
      /* localStorage indisponible : on ignore */
    }
  }
  // Nom à afficher : surnom si défini, sinon le nom courant de l'agent.
  function effectiveName(id) {
    const a = agents.get(id);
    return customName(id) || (a ? a.name : id);
  }
  // Édition inline du nom (double-clic) : passe l'élément en éditable et sélectionne tout.
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
  // Validation : vide ou = nom d'origine → on retire le surnom ; sinon on l'enregistre.
  function commitRename(el, id) {
    if (!el.isContentEditable) return;
    el.contentEditable = "false";
    el.classList.remove("editing");
    const typed = el.textContent.replace(/\s+/g, " ").trim();
    const original = (agents.get(id) || {}).name || "";
    setCustomName(id, !typed || typed === original ? null : typed);
    el.textContent = effectiveName(id);
  }

  // Préférence « réduire les animations » : si activée, on ne fait pas défiler le ticker
  // (repli statique enroulé géré en CSS).
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Re-mesure le ticker quand la bulle change de TAILLE (densité, redimensionnement, création).
  // Hors de la boucle rAF pour éviter des lectures de layout à chaque frame.
  const bubbleRO =
    "ResizeObserver" in window
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const card = cards.get(entry.target.dataset.agentId);
            if (card) measureBubble(card);
          }
        })
      : null;

  // Re-mesure tout si la préférence d'animation change en cours de session.
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", () => {
      for (const card of cards.values()) measureBubble(card);
    });
  }

  // ── Rendu / réconciliation ──────────────────────────────────────────────

  // Bascule « défile seulement si nécessaire » : si la réplique tient sur une ligne → statique
  // centrée (aucun mouvement) ; sinon → marquee à vitesse constante. Appelée au changement de
  // texte ET par le ResizeObserver (changement de largeur). Lit le layout → hors boucle rAF.
  function measureBubble(card) {
    const bubble = card.bubbleEl;
    if (!bubble.classList.contains("show")) return;
    // Reduced motion : pas de marquee ; le repli CSS enroule le texte sur quelques lignes.
    if (reduceMotion.matches) {
      bubble.classList.remove("is-marquee");
      return;
    }
    // Mesure « à plat » (sans la 2e copie) : largeur réelle du texte vs largeur visible.
    bubble.classList.remove("is-marquee");
    const visible = card.bubbleTextEl.clientWidth;
    const needed = card.bubbleSegEls[0].scrollWidth;
    if (needed - visible > 1) {
      bubble.classList.add("is-marquee");
      // Distance d'un cycle = demi-piste (2 copies égales). Durée = distance / vitesse.
      const cycle = card.bubbleTrackEl.getBoundingClientRect().width / 2;
      const speed = card.el.dataset.state === "needs_input" ? MARQUEE_SPEED_SLOW : MARQUEE_SPEED;
      card.bubbleTrackEl.style.setProperty("--marquee-duration", (cycle / speed).toFixed(2) + "s");
    }
  }

  // On écrit le texte sur les DEUX copies (la 2e, aria-hidden, ne sert qu'à la boucle marquee) ;
  // texte complet en infobulle. Puis on (re)mesure pour choisir statique vs défilement.
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
    avatar.className = "avatar"; // contour de statut épousant la silhouette (CSS via data-state)
    const canvas = document.createElement("canvas");
    canvas.width = Claudy.GRID_W * PX;
    canvas.height = Claudy.GRID_H * PX;
    avatar.appendChild(canvas);
    // Clic sur la tête : ramène la fenêtre de l'agent (VS Code / terminal) au premier plan.
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
        name.textContent = effectiveName(agent.id); // annule la saisie
        name.blur();
      }
    });
    name.addEventListener("blur", () => commitRename(name, agent.id));

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dataset.agentId = agent.id; // pour retrouver la carte depuis le ResizeObserver
    const bubbleText = document.createElement("div"); // viewport : rogne le ticker sur 1 ligne
    bubbleText.className = "bubble-text";
    const bubbleTrack = document.createElement("div"); // piste qui défile (transform animé)
    bubbleTrack.className = "bubble-track";
    const seg0 = document.createElement("span");
    seg0.className = "bubble-seg";
    const seg1 = document.createElement("span"); // copie pour la boucle sans couture
    seg1.className = "bubble-seg";
    seg1.setAttribute("aria-hidden", "true"); // évite une double lecture par les lecteurs d'écran
    bubbleTrack.append(seg0, seg1);
    bubbleText.appendChild(bubbleTrack);
    bubble.appendChild(bubbleText);
    if (bubbleRO) bubbleRO.observe(bubble);

    // Essaim de sous-agents : rangée de mini-têtes + compteur, sous le nom.
    const children = document.createElement("div");
    children.className = "children";
    const childCount = document.createElement("span");
    childCount.className = "children-count";
    children.appendChild(childCount);

    // Ordre BD : bulle en haut, tête au milieu, nom, puis l'essaim.
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

  // Réconcilie les mini-têtes des sous-agents d'une session (essaim dans la tuile).
  // Chaque tête porte un statut : working (pulsant), done (vert), failed (rouge).
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
        // Insère avant le compteur (qui reste en dernier, pleine largeur).
        card.childrenEl.insertBefore(mini, card.childCountEl);
        child = { el: mini, ctx: canvas.getContext("2d"), phase: Math.random() * Math.PI * 2 };
        card.childCards.set(sub.id, child);
      }
      child.status = status; // lu par la boucle d'animation (hochement si « working »)
      child.el.dataset.status = status; // couleur du contour via CSS
      child.el.title = `${sub.name} — ${STATUS_LABEL[status] || status}`;
      child.el.setAttribute("aria-label", `sous-agent ${sub.name} : ${STATUS_LABEL[status] || status}`);
    }

    // Compteur : progression du workflow si disponible, sinon simple nombre.
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

  // Met à jour nom / statut / bulle quand l'état change (hors défilement working).
  function syncCard(card, agent) {
    // Ne pas écraser le nom pendant qu'on l'édite (double-clic) ; sinon nom effectif (surnom éventuel).
    if (!card.nameEl.isContentEditable) card.nameEl.textContent = effectiveName(agent.id);
    card.el.dataset.state = agent.state; // pilote la couleur du contour de silhouette (CSS)
    // Étiquette accessible (lecteur d'écran) sans infobulle visible.
    card.el.setAttribute("aria-label", `${effectiveName(agent.id)} — ${LABELS[agent.state] || agent.state}`);

    if (agent.state !== card.renderedState) {
      // Bulle TOUJOURS affichée → la hauteur de la tuile ne change pas d'un état à l'autre.
      card.bubbleEl.classList.add("show");
      if (agent.state === "working") {
        // Réplique FIXE choisie au passage en "working" (défile si trop longue, ne tourne pas).
        card.quoteIdx = (card.quoteIdx + 1) % QUOTES.length;
        setBubble(card, QUOTES[card.quoteIdx]);
      } else if (agent.state === "needs_input") {
        setBubble(card, NEEDS_LINE);
        if (agent.request) card.bubbleEl.title = agent.request; // détail réel au survol
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
      // La demande peut changer sans changer d'état : on garde « Je t'attends ! » et on
      // met à jour le détail au survol.
      card.bubbleEl.title = agent.request;
    }

    syncChildren(card, agent.children || [], agent.childExtra || 0, agent.swarm || null);
  }

  // Densité responsive : plus il y a d'agents, plus les tuiles sont petites.
  function applyDensity(n) {
    // Bulle sur 1 ligne (ticker) → tuiles très compactes : 2 colonnes tiennent dès ~258px
    // (la fenêtre flottante), et la grille en empile davantage sur un écran large.
    const [tile, avatar] =
      n <= 8 ? [100, 52] : n <= 16 ? [92, 47] : n <= 32 ? [84, 42] : [78, 37];
    els.grid.style.setProperty("--tile", `${tile}px`);
    els.grid.style.setProperty("--avatar", `${avatar}px`);
  }

  // Résumé compact des statuts dans la barre du haut (● 3  ◔ 1  ‼ 1).
  function updateSummary(list) {
    if (!els.summary) return;
    const c = { working: 0, idle: 0, needs_input: 0, offline: 0 };
    for (const a of list) c[a.state] = (c[a.state] || 0) + 1;
    // Indicateur compact : icône AU-DESSUS du nombre (mini-colonne) → prend peu de largeur.
    const stat = (cls, ico, n) =>
      n
        ? `<span class="stat ${cls}"><span class="stat-ico">${ico}</span><span class="stat-num">${n}</span></span>`
        : "";
    els.summary.innerHTML = [
      stat("stat--working", "●", c.working),
      stat("stat--needs", "‼", c.needs_input),
      stat("stat--idle", "◔", c.idle),
      stat("stat--offline", "○", c.offline),
    ].join(""); // contenu statique + nombres : sûr
  }

  function reconcile(list) {
    const ids = new Set(list.map((a) => a.id));

    // Supprime les cartes disparues.
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        if (bubbleRO) bubbleRO.unobserve(card.bubbleEl);
        card.el.remove();
        cards.delete(id);
        agents.delete(id);
      }
    }

    // Crée / met à jour.
    for (const agent of list) {
      agents.set(agent.id, agent);
      let card = cards.get(agent.id);
      if (!card) card = createCard(agent);
      syncCard(card, agent);
    }

    // Réaligne l'ordre du DOM sur l'ordre (trié par nom) reçu du serveur, mais SANS
    // toucher au DOM si l'ordre n'a pas changé : on ne déplace un nœud que s'il n'est
    // pas déjà à sa place. Indispensable — ré-appendChild tous les nœuds à chaque
    // message SSE réinitialisait le scroll (perte de position, insupportable).
    let prev = null;
    for (const agent of list) {
      const el = cards.get(agent.id).el;
      const ref = prev ? prev.nextSibling : els.grid.firstChild;
      if (el !== ref) els.grid.insertBefore(el, ref);
      prev = el;
    }

    // Compteur, résumé, densité, état vide.
    const n = list.length;
    els.count.textContent = `${n} agent${n > 1 ? "s" : ""}`;
    els.empty.style.display = n === 0 ? "" : "none";
    applyDensity(n);
    updateSummary(list);
  }

  // ── Boucle d'animation ────────────────────────────────────────────────────

  function frame(t) {
    for (const [id, card] of cards) {
      const agent = agents.get(id);
      if (!agent) continue;

      let bob = 0;
      let dim = false;
      let tint = null;

      if (agent.state === "working") {
        bob = Math.sin(t * 0.013 + card.phase) * 6; // hochement : « il parle »
        // La réplique est posée au changement d'état (syncCard), pas ici : elle reste FIXE
        // et défile en CSS. La boucle ne fait plus que le hochement.
      } else if (agent.state === "needs_input") {
        bob = Math.sin(t * 0.006 + card.phase) * 3; // sollicitation
        tint = "#d65a4a";
      } else if (agent.state === "idle") {
        dim = true;
        bob = Math.sin(t * 0.0025 + card.phase) * 1.5; // respiration légère
      } else {
        dim = true; // offline
      }

      Claudy.draw(card.ctx, { px: PX, bob, dim, tint });

      // Mini-têtes des sous-agents : toujours actives → hochement, déphasées entre elles.
      for (const child of card.childCards.values()) {
        // Seules les têtes « en cours » hochent ; terminées/échouées restent fixes
        // (atténuées si échec) pour bien lire l'état figé du run.
        const working = child.status === "working" || child.status === undefined;
        const bob = working ? Math.sin(t * 0.013 + child.phase) * 3 : 0;
        Claudy.draw(child.ctx, { px: MINI_PX, bob, dim: child.status === "failed" });
      }
    }
    requestAnimationFrame(frame);
  }

  // ── Connexion SSE ──────────────────────────────────────────────────────────

  function setConn(ok) {
    els.conn.className = "dot " + (ok ? "dot--on" : "dot--off");
    els.connLabel.textContent = ok ? "connecté" : "déconnecté";
  }

  function connect() {
    if (es) es.close(); // évite les flux en double lors d'une reconnexion (refresh)
    es = new EventSource("/api/events");
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false); // EventSource se reconnecte tout seul
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "agents") reconcile(msg.agents);
      } catch {
        /* ping ou message non-JSON : ignoré */
      }
    };
  }

  // Refresh manuel : re-tire l'état courant tout de suite et reconnecte le flux si besoin.
  async function refreshNow() {
    if (els.refresh) els.refresh.classList.add("spinning");
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      if (data && data.type === "agents") reconcile(data.agents);
    } catch {
      /* serveur injoignable : le bouton arrête juste de tourner */
    }
    if (!es || es.readyState === 2) connect(); // 2 = CLOSED → on rétablit le flux SSE
    setTimeout(() => els.refresh && els.refresh.classList.remove("spinning"), 600);
  }

  // ── Démarrage ───────────────────────────────────────────────────────────────

  async function init() {
    try {
      const res = await fetch("/api/quotes");
      const data = await res.json();
      if (Array.isArray(data.quotes) && data.quotes.length) QUOTES = data.quotes;
    } catch {
      /* on garde le fallback */
    }

    if (els.refresh) els.refresh.addEventListener("click", refreshNow);
    connect();
    requestAnimationFrame(frame);
  }

  init();
})();
