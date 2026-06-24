// Rendu de la tête de Claudy Focan sur un <canvas>.
//
// Le visage est un pixel art DÉRIVÉ d'une vraie photo de François Damiens dans
// Dikkenek (réduite en pixels + fond détouré par tools/derive-face.cjs), pour une
// ressemblance fidèle impossible à obtenir à la main. Servi par le serveur
// (public/face.png) et chargé une seule fois.
//
// L'animation « il parle » passe par un hochement de tête (bob) plus marqué en
// travail + la bulle de citations — pas de bouche cartoon, qui jurerait sur une
// photo. Atténuation pour « en attente », teinte rouge pour « demande ».
//
// Expose un singleton global `Claudy` utilisé par app.js.

(function () {
  "use strict";

  // Dimensions natives de l'avatar (tête recadrée, cf. tools/derive-face.cjs).
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
      if (!ready) return; // image pas encore chargée

      ctx.save();
      ctx.imageSmoothingEnabled = false; // garde le rendu pixel net
      ctx.translate(0, bob); // hochement de tête
      if (dim) ctx.globalAlpha = 0.6; // « en attente » : atténué

      ctx.drawImage(img, 0, 0, NATIVE_W, NATIVE_H, 0, 0, w, h);

      // Teinte d'ambiance (rouge léger quand il réclame).
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
