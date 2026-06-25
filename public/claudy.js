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
  img.onload = () => {
    ready = true;
  };
  img.src = "face.png";

  const Claudy = {
    GRID_W: NATIVE_W,
    GRID_H: NATIVE_H,

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{px:number, dim?:boolean, bob?:number, tint?:string|null}} opts
     */
    draw(ctx, opts) {
      const { px, dim = false, bob = 0, tint = null } = opts;
      const w = NATIVE_W * px;
      const h = NATIVE_H * px;
      ctx.clearRect(0, 0, w, h);
      if (!ready) return; // image not loaded yet

      ctx.save();
      ctx.imageSmoothingEnabled = false; // keep the pixels crisp
      ctx.translate(0, bob); // head bob
      if (dim) ctx.globalAlpha = 0.6; // "idle": dimmed

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
