// agent-claudy — feeds the preview (demo-app.html), DRIVEN BY THE PARENT.
//
// We replace EventSource/fetch with stubs, but this time the snapshots do NOT
// come from a local loop: they arrive via postMessage from the showcase page
// (terminal.js), so that the terminals and the Claudy heads stay IN SYNC.

(function () {
  "use strict";

  // Real Claudy lines (see data/quotes.json) for /api/quotes.
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

  // ── fetch stub: /api/quotes (and no-op for everything else). ────────────────
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

  // ── EventSource stub: emits whatever the parent sends (postMessage). ─────────
  let live = null;
  let last = null; // last snapshot received (replayed on (re)connection)

  function FakeES() {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    live = this;
    const self = this;
    setTimeout(function () {
      if (self.onopen) self.onopen();
      if (last && self.onmessage) self.onmessage({ data: JSON.stringify(last) });
      // Tell the parent we're ready → it (re)pushes the current snapshot.
      try {
        parent.postMessage("claudy-ready", "*");
      } catch (e) {}
    }, 60);
  }
  FakeES.prototype.close = function () {
    if (live === this) live = null;
  };
  window.EventSource = FakeES;

  window.addEventListener("message", function (e) {
    const d = e.data;
    if (d && d.type === "agents") {
      last = d;
      if (live && live.onmessage) live.onmessage({ data: JSON.stringify(d) });
    }
  });
})();
