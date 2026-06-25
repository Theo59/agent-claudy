// Renders Claudy Focan's head onto a <canvas>.
//
// The face is pixel art DERIVED from a real photo of François Damiens in
// Dikkenek (downscaled to pixels + background cut out by tools/derive-face.cjs),
// for a faithful likeness impossible to achieve by hand. Served by the server
// (public/face.png) and loaded only once.
//
// The "he's talking" animation relies on a head bob, more pronounced while
// working, plus the quote bubble — no cartoon mouth, which would look off on a
// photo. Dimmed for "idle", red tint for "needs input".
//
// Exposes a global `Claudy` singleton used by app.js.

(function () {
  "use strict";

  // Native avatar dimensions (cropped head, see tools/derive-face.cjs).
  const NATIVE_W = 64;
  const NATIVE_H = 64;

  const img = new Image();
  let ready = false;
  const readyCbs = [];
  img.onload = () => {
    ready = true;
    // The canvases are now only drawn on state change (no per-frame loop), so we
    // must repaint everything once the face image finishes loading.
    for (const cb of readyCbs) cb();
    readyCbs.length = 0;
  };
  img.src = "face.png";

  // Status outline, BAKED into the canvas pixels (was a CSS `filter: drop-shadow`
  // stack of 8 — many filtered layers wrecked scroll perf, especially in Safari).
  // We tint the face's alpha into a solid silhouette, then stamp it at 8 offsets
  // under the real face → same hugging edge, zero CSS filter.
  const OUTLINE_OFFSETS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1],
  ];
  let silCanvas = null;
  let silColor = null;
  function silhouette(color) {
    if (silCanvas && silColor === color) return silCanvas;
    const c = silCanvas || (silCanvas = document.createElement("canvas"));
    c.width = NATIVE_W;
    c.height = NATIVE_H;
    const cx = c.getContext("2d");
    cx.clearRect(0, 0, NATIVE_W, NATIVE_H);
    cx.drawImage(img, 0, 0);
    cx.globalCompositeOperation = "source-in"; // keep only the alpha, recolor it
    cx.fillStyle = color;
    cx.fillRect(0, 0, NATIVE_W, NATIVE_H);
    cx.globalCompositeOperation = "source-over";
    silColor = color;
    return c;
  }

  const Claudy = {
    GRID_W: NATIVE_W,
    GRID_H: NATIVE_H,

    /** Run `cb` once the face image is ready (immediately if already loaded). */
    onReady(cb) {
      if (ready) cb();
      else readyCbs.push(cb);
    },

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{px:number, dim?:boolean, tint?:string|null, ring?:string|null}} opts
     */
    draw(ctx, opts) {
      const { px, dim = false, tint = null, ring = null } = opts;
      const w = NATIVE_W * px;
      const h = NATIVE_H * px;
      ctx.clearRect(0, 0, w, h);
      if (!ready) return; // image not loaded yet

      ctx.save();
      ctx.imageSmoothingEnabled = false; // keep the pixels crisp
      if (dim) ctx.globalAlpha = 0.6; // "idle": dimmed

      // Baked silhouette outline (replaces the CSS drop-shadow stack).
      if (ring) {
        const sil = silhouette(ring);
        for (const [dx, dy] of OUTLINE_OFFSETS) {
          ctx.drawImage(sil, 0, 0, NATIVE_W, NATIVE_H, dx * px, dy * px, w, h);
        }
      }

      ctx.drawImage(img, 0, 0, NATIVE_W, NATIVE_H, 0, 0, w, h);

      // Ambient tint (light red when he's calling for input).
      if (tint) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.restore();
    },
  };

  window.Claudy = Claudy;
})();
