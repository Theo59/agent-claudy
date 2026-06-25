// Dérive un pixel art fidèle à partir d'une photo :
//   1. lit un BMP (produit par sips) — format trivial, pas de zlib/filtres
//   2. détoure le fond (flood-fill depuis les bords)
//   3. posterise légèrement (rendu pixel-art)
//   4. exporte un PNG natif (pour l'app) + un PNG agrandi (pour inspection)
//
// Préparer le BMP (recadrage + réduction) avec sips, puis lancer ce script :
//   sips -c 250 225 -z 80 72 -s format bmp photo.png --out face.bmp
//   node tools/derive-face.cjs face.bmp public/face.png /tmp/preview.png 110
// Le 4e argument est le seuil de détourage du fond (def. 60). Ouvre le PNG d'aperçu
// pour juger ; ajuste le recadrage sips et le seuil au besoin.

const zlib = require("zlib");
const fs = require("fs");

// ── Encodeur PNG (RGBA) ─────────────────────────────────────────────────────
function crcTable() {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRCT = crcTable();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function writePNG(p, w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  fs.writeFileSync(p, Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]));
}

// ── Lecteur BMP (24 ou 32 bits, non compressé) ────────────────────────────────
function readBMP(path) {
  const b = fs.readFileSync(path);
  if (b[0] !== 0x42 || b[1] !== 0x4d) throw new Error("pas un BMP");
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  let h = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const bottomUp = h > 0;
  h = Math.abs(h);
  const bytesPP = bpp / 8;
  const rowSize = Math.floor((bpp * w + 31) / 32) * 4; // padding 4 octets
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const si = off + srcY * rowSize + x * bytesPP;
      const di = (y * w + x) * 4;
      out[di] = b[si + 2]; // R (BMP = BGR)
      out[di + 1] = b[si + 1]; // G
      out[di + 2] = b[si]; // B
      out[di + 3] = bytesPP === 4 ? b[si + 3] : 255;
    }
  }
  return { w, h, rgba: out };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
const [, , inPath, outNative, outPreview, thArg] = process.argv;
const TH = Number(thArg) || 60; // tolérance de couleur pour le fond
const { w, h, rgba } = readBMP(inPath);
const idx = (x, y) => (y * w + x) * 4;
const dist = (i, r, g, bl) =>
  Math.abs(rgba[i] - r) + Math.abs(rgba[i + 1] - g) + Math.abs(rgba[i + 2] - bl);

// Couleur de fond de référence = moyenne des 2 coins du HAUT (le ciel / mur).
// (Les coins du bas sont souvent le sujet : chemise, épaules.)
let rr = 0,
  gg = 0,
  bb = 0;
for (const [x, y] of [[0, 0], [w - 1, 0]]) {
  const i = idx(x, y);
  rr += rgba[i];
  gg += rgba[i + 1];
  bb += rgba[i + 2];
}
rr /= 2;
gg /= 2;
bb /= 2;

// Flood-fill connexe depuis les bords : un pixel est « fond » s'il est relié au
// bord par des pixels TOUS proches (globalement) de la couleur du ciel/mur.
// Pas de similarité locale (qui ferait fuir le détourage dans le visage lisse).
// Le fond ciel est FROID (bleu) : on refuse comme « fond » tout pixel chaud
// (peau, cheveux), ce qui empêche le détourage de mordre dans un reflet du front.
const coolBg = bb >= rr - 5;
const isBg = (i) => {
  if (dist(i, rr, gg, bb) > TH) return false;
  if (coolBg && rgba[i + 2] + 12 < rgba[i]) return false; // bleu < rouge → chaud → pas le fond
  return true;
};

const bg = new Uint8Array(w * h);
const stack = [];
const consider = (x, y) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const p = y * w + x;
  if (bg[p]) return;
  if (isBg(idx(x, y))) {
    bg[p] = 1;
    stack.push(p);
  }
};
for (let x = 0; x < w; x++) {
  consider(x, 0);
  consider(x, h - 1);
}
for (let y = 0; y < h; y++) {
  consider(0, y);
  consider(w - 1, y);
}
while (stack.length) {
  const p = stack.pop();
  const x = p % w,
    y = (p / w) | 0;
  consider(x + 1, y);
  consider(x - 1, y);
  consider(x, y + 1);
  consider(x, y - 1);
}

// Posterisation douce (marches de 18) pour un rendu pixel-art
const step = 18;
const post = (v) => Math.min(255, Math.round(v / step) * step);
const outRgba = Buffer.alloc(w * h * 4);
let kept = 0;
for (let p = 0; p < w * h; p++) {
  const i = p * 4;
  if (bg[p]) {
    outRgba[i + 3] = 0; // transparent
  } else {
    outRgba[i] = post(rgba[i]);
    outRgba[i + 1] = post(rgba[i + 1]);
    outRgba[i + 2] = post(rgba[i + 2]);
    outRgba[i + 3] = 255;
    kept++;
  }
}

// Recadrage automatique sur la boîte englobante du contenu (pixels opaques)
let minX = w,
  minY = h,
  maxX = -1,
  maxY = -1;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++)
    if (outRgba[(y * w + x) * 4 + 3]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
const pad = 2;
minX = Math.max(0, minX - pad);
minY = Math.max(0, minY - pad);
maxX = Math.min(w - 1, maxX + pad);
maxY = Math.min(h - 1, maxY + pad);
const cw = maxX - minX + 1;
const ch = maxY - minY + 1;
const crop = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y++)
  for (let x = 0; x < cw; x++) {
    const s = ((y + minY) * w + (x + minX)) * 4;
    const d = (y * cw + x) * 4;
    crop[d] = outRgba[s];
    crop[d + 1] = outRgba[s + 1];
    crop[d + 2] = outRgba[s + 2];
    crop[d + 3] = outRgba[s + 3];
  }

writePNG(outNative, cw, ch, crop);

// Repère de bouche (placement de l'animation) : MX,MY,MRX,MRY normalisés [0..1]
if (process.env.MTEST === "1") {
  const mx = 0.62 * cw,
    my = 0.8 * ch,
    mrx = 0.13 * cw,
    mry = 0.05 * ch;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (((x - mx) / mrx) ** 2 + ((y - my) / mry) ** 2 <= 1) {
        const i = (y * cw + x) * 4;
        crop[i] = 20;
        crop[i + 1] = 8;
        crop[i + 2] = 8;
        crop[i + 3] = 255;
      }
}

// Aperçu agrandi ×6
const S = 6;
const pv = Buffer.alloc(cw * S * ch * S * 4);
for (let y = 0; y < ch; y++)
  for (let x = 0; x < cw; x++) {
    const i = (y * cw + x) * 4;
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const o = ((y * S + sy) * cw * S + (x * S + sx)) * 4;
        pv[o] = crop[i];
        pv[o + 1] = crop[i + 1];
        pv[o + 2] = crop[i + 2];
        pv[o + 3] = crop[i + 3];
      }
  }
writePNG(outPreview, cw * S, ch * S, pv);
console.log(`${inPath} → ${w}×${h} → recadré ${cw}×${ch} | fond: ${w * h - kept}px, gardé: ${kept}px (seuil ${TH})`);
