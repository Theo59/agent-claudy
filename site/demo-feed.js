// agent-claudy — alimentation scriptée de l'aperçu (demo-app.html), SANS serveur.
//
// Remplace `EventSource` et `fetch` par des bouchons : app.js tourne EXACTEMENT comme
// en vrai (mêmes cartes BD, bulles, essaim, contour silhouette), mais les données
// viennent d'un scénario rejoué en boucle au lieu du flux SSE du serveur.

(function () {
  "use strict";

  // Vraies répliques de Claudy (cf. data/quotes.json) pour /api/quotes.
  const QUOTES = [
    "T'es épais comme un cable de frein à main !",
    "Y a moyen de tout, tout est négociable.",
    "Éducation minimum !",
    "T'es tendue comme une crampe…",
    "Va te faire refaire hein, alien !",
    "Faut pas commencer à jouer avec mes couilles !",
    "Tu vas pas m'dire toi c'que j'dois dire moi hein.",
    "Non, c'est un électrique !",
  ];
  const NEEDS = "Chef, ou tu sors ou j'te sors, mais faudra prendre une décision.";

  // Essaim de workflow (jetsite) qui progresse : `done` têtes terminées, le reste working.
  function swarm(done) {
    const names = ["Explore", "blog-researcher", "code-review", "general-purpose", "design", "Explore"];
    const children = names.map((name, i) => ({
      id: `cc-jet-sub-${i}`,
      name,
      status: i < done ? "done" : "working",
      workflowId: "wf_demo",
    }));
    return {
      children,
      childExtra: 0,
      swarm: { done, failed: 0, working: children.length - done, total: children.length },
    };
  }

  // Construit un snapshot. `opts` ajuste l'état narratif (avancement essaim, alerte…).
  function snap(opts) {
    const jet = swarm(opts.swarmDone);
    return {
      type: "agents",
      agents: [
        { id: "cc-1", name: "claudy-ui-pro-upgrade", state: opts.alert ? "needs_input" : "working", request: opts.alert ? NEEDS : null },
        { id: "cc-2", name: "daphn-e-lachavanne", state: opts.daphnWorking ? "working" : "idle" },
        { id: "cc-3", name: "jetsite", state: "working", children: jet.children, childExtra: jet.childExtra, swarm: jet.swarm },
        { id: "cc-4", name: "externalize-media-to-sanity", state: opts.extIdle ? "idle" : "working" },
      ],
    };
  }

  // Scénario rejoué en boucle (chaque image tient `hold` ms).
  const FRAMES = [
    { hold: 2600, snap: snap({ swarmDone: 0 }) },
    { hold: 2600, snap: snap({ swarmDone: 1, daphnWorking: true }) },
    { hold: 3000, snap: snap({ swarmDone: 2, daphnWorking: true, alert: true }) }, // alerte rouge
    { hold: 2600, snap: snap({ swarmDone: 3, alert: true }) },
    { hold: 2600, snap: snap({ swarmDone: 4, extIdle: true }) }, // alerte levée
    { hold: 2600, snap: snap({ swarmDone: 6, extIdle: true }) }, // workflow fini (tout vert)
  ];

  // ── Bouchon fetch : /api/quotes (et no-op pour le reste). ───────────────────
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (url) {
    const u = String(url);
    if (u.indexOf("/api/quotes") !== -1) {
      return Promise.resolve(new Response(JSON.stringify({ quotes: QUOTES }), { headers: { "content-type": "application/json" } }));
    }
    if (u.indexOf("/api/") !== -1) {
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    }
    return realFetch ? realFetch.apply(this, arguments) : Promise.reject(new Error("offline"));
  };

  // ── Bouchon EventSource : rejoue FRAMES en boucle. ──────────────────────────
  function FakeES() {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    const self = this;
    let i = 0;
    function tick() {
      const f = FRAMES[i % FRAMES.length];
      if (self.onmessage) self.onmessage({ data: JSON.stringify(f.snap) });
      i++;
      self._t = setTimeout(tick, f.hold);
    }
    setTimeout(function () {
      if (self.onopen) self.onopen();
      tick();
    }, 60);
  }
  FakeES.prototype.close = function () {
    clearTimeout(this._t);
  };
  window.EventSource = FakeES;
})();
