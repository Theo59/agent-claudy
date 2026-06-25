// agent-claudy — donation panel (❤).
//
// Self-custody crypto donations: reads the wallet addresses from /donations.json
// (single source of truth, also used by tools/gen-donations.cjs) and renders, per
// wallet, a click-to-copy address + a QR code generated client-side via the vendored
// MIT encoder (public/vendor/qrcode.js → global `qrcode`). No third party, works offline.
//
// Opened by the ❤ button (#donate-open). Vanilla, zero npm dependency.

(function () {
  "use strict";

  const openBtn = document.getElementById("donate-open");
  let dialog = null;
  let data = null; // { title, blurb, wallets: [...] }
  let built = false;

  const GLASSES = '<svg aria-hidden="true"><use href="#claudy-mark"/></svg>';

  // An address still left as a placeholder isn't shown as a real address (no QR, no URI),
  // so a misconfigured wallet can never mislead a donor into sending funds nowhere.
  function isConfigured(addr) {
    return !!addr && !/^REMPLACER_/.test(addr);
  }

  // Standard payment URI per chain (BIP-21 / EIP-681 / Solana Pay): lets a scanning
  // wallet pre-fill the right network.
  function paymentUri(w) {
    return `${w.uriScheme}:${w.address}`;
  }

  // QR as an inline SVG string (scales crisply, no raster). Dark-on-light so it stays
  // scannable on the panel's light card. typeNumber 0 = auto-pick the smallest version.
  function qrSvg(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts / older browsers.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = "Copié ✓";
    btn.classList.add("ok");
    clearTimeout(copy._t);
    copy._t = setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove("ok");
    }, 1400);
  }

  // One wallet card: name, accepted tokens, network, address (copyable) + QR.
  function walletCard(w) {
    const card = document.createElement("div");
    card.className = "don-wallet";

    const head = document.createElement("div");
    head.className = "don-w-head";
    const name = document.createElement("span");
    name.className = "don-w-name";
    name.textContent = w.name;
    const accepts = document.createElement("span");
    accepts.className = "don-w-accepts";
    accepts.textContent = (w.accepts || []).join(" · ");
    head.append(name, accepts);
    card.appendChild(head);

    if (w.network) {
      const net = document.createElement("div");
      net.className = "don-w-net";
      net.textContent = w.network;
      card.appendChild(net);
    }

    if (!isConfigured(w.address)) {
      const todo = document.createElement("div");
      todo.className = "don-w-todo";
      todo.textContent = "Adresse non encore configurée.";
      card.appendChild(todo);
      return card;
    }

    // QR (client-side). Guarded: if the encoder failed to load, we still show the address.
    if (window.qrcode) {
      const qr = document.createElement("div");
      qr.className = "don-w-qr";
      try {
        qr.innerHTML = qrSvg(paymentUri(w)); // trusted: SVG built locally from our own data
        const img = qr.querySelector("svg");
        if (img) img.setAttribute("role", "img");
        if (img) img.setAttribute("aria-label", `QR ${w.name}`);
      } catch {
        qr.remove();
      }
      if (qr.firstChild) card.appendChild(qr);
    }

    const addrRow = document.createElement("div");
    addrRow.className = "don-w-addr";
    const code = document.createElement("code");
    code.textContent = w.address; // textContent → no HTML injection
    code.title = w.address;
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "don-copy";
    copyBtn.textContent = "Copier";
    copyBtn.setAttribute("aria-label", `Copier l'adresse ${w.name}`);
    copyBtn.addEventListener("click", () => copy(w.address, copyBtn));
    addrRow.append(code, copyBtn);
    card.appendChild(addrRow);

    return card;
  }

  function render() {
    const body = dialog.querySelector(".don-body");
    body.textContent = "";

    if (data.blurb) {
      const blurb = document.createElement("p");
      blurb.className = "don-blurb";
      blurb.textContent = data.blurb;
      body.appendChild(blurb);
    }

    const wallets = (data.wallets || []).filter(Boolean);
    if (!wallets.length) {
      const none = document.createElement("p");
      none.className = "don-blurb";
      none.textContent = "Aucun moyen de don configuré pour l'instant.";
      body.appendChild(none);
      return;
    }
    for (const w of wallets) body.appendChild(walletCard(w));
  }

  function build() {
    dialog = document.createElement("dialog");
    dialog.className = "settings donate"; // reuse the settings dialog skin
    const title = (data && data.title) || "Soutenir le créateur";
    dialog.innerHTML =
      '<form method="dialog" class="settings-head">' +
      `<span class="settings-title"><span class="brand-mark">${GLASSES}</span>${title}</span>` +
      '<button class="icon-btn" value="close" aria-label="Fermer">✕</button>' +
      "</form>" +
      '<div class="settings-body don-body"></div>';
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close(); // click on the backdrop
    });
    built = true;
  }

  async function load() {
    if (data) return;
    const res = await fetch("/donations.json");
    data = await res.json();
  }

  async function open() {
    try {
      await load();
    } catch {
      data = { title: "Soutenir le créateur", blurb: "Impossible de charger les coordonnées de don.", wallets: [] };
    }
    if (!built) build();
    render();
    if (!dialog.open) dialog.showModal();
  }

  if (openBtn) openBtn.addEventListener("click", open);
})();
