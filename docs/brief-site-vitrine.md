# Brief — Site vitrine `agent-claudy`

> But du document : cadrer le site vitrine **avant** de coder. Ton fun, à l'image de
> **Claudy Focan** (*Dikkenek*), centré sur une **démo terminal animée** et un **téléchargement
> de l'installer**. Réutilise au maximum l'existant du repo (avatars, palette, logo, citations).

## 1. Objectif

- **Convertir** : faire télécharger l'installer en < 30 s, sans lire un pavé.
- **Faire sourire** : le site doit être aussi marrant que l'outil (citations Claudy, GIFs, pixel art).
- **Montrer, pas raconter** : une **démo terminal jouée en boucle** au centre du site vaut tous
  les paragraphes — on voit Claude bosser et les têtes de Claudy s'animer en direct.

## 2. Cible & ton

- **Cible** : devs qui utilisent Claude Code (souvent plusieurs sessions en parallèle), sur macOS.
- **Ton** : décalé, gouailleur, **répliques de Claudy** partout (source unique : `data/quotes.json`).
  Français, tutoiement, vanne assumée. Jamais corporate.
- **Identité visuelle** : reprise **stricte** de l'app (cohérence de marque) :
  - Palette `public/styles.css` (`--bg #14110d`, `--accent #d8a657`, `--green`, `--red`, crème `#efe6cf`).
  - **Logo aviateur** `media/claudy.svg` (+ favicon, repris du `<symbol id="claudy-mark">`).
  - **Vrais avatars** : `public/claudy.js` + `public/face.png` (canvas pixelisé, hochement, contour
    silhouette) → on embarque le moteur réel, pas des images mortes.
  - Vibe **CRT/rétro** : léger grain, scanlines discrètes, typo mono (`SF Mono`/`JetBrains Mono`).

## 3. Le clou du spectacle — le terminal simulé (centre du site)

Une **fausse session Claude Code** jouée en boucle (timeline scriptée, **aucun backend** : ça doit
tourner en hébergement statique). Trois couches superposées :

1. **Le terminal** (cadre type fenêtre macOS, pastilles rouge/jaune/vert) où des lignes **se tapent
   et défilent** (effet machine à écrire + auto-scroll).
2. **Les têtes de Claudy** qui apparaissent au-dessus / à côté (essaim) en réutilisant `claudy.js` :
   une tête `working` (verte, hoche, bulle de citation), puis des **mini-têtes** (sous-agents), une
   qui passe **`needs_input`** (alerte rouge) puis **`done`** (verte).
3. **Des GIFs fun** qui s'incrustent dans le terminal aux punchlines (cf. §4).

### Timeline jouée (exemple concret à affiner)

```
$ claude
  👓  agent-claudy — Éducation minimum.
> Construis-moi un site vitrine, vite fait bien fait.
  ⠋ Réflexion…                              ← spinner
  ▸ Claudy se met au travail               ← une tête VERTE apparaît + bulle « Y a moyen de tout »
  ▸ Lancement de 3 sous-agents…            ← 3 mini-têtes (essaim) qui hochent
  ✱ Explore  ✱ design  ✱ code             ← compteur « 0✓ / 3 »
  [GIF: chat qui tape frénétiquement au clavier]
  ⚑ design — « Chef, rouge ou crème ? »    ← une mini-tête passe ROUGE (needs_input) + alerte
> Crème évidemment. T'es tendue comme une crampe.
  ✓ design terminé                          ← repasse VERTE, compteur « 1✓ / 3 »
  ✓ Explore terminé    ✓ code terminé      ← « 3✓ / 3 »
  ✓ Build prêt en 4,2 s.
  [GIF: Obama drop the mic]                 ← punchline finale
  « Remets la petite sœur. »
```

Puis **fondu** et **reboucle**. Bouton CTA **« Télécharger »** qui pulse en fin de cycle.

### Réglages d'animation
- **Rythme lisible** (pas de course) ; pause sur les punchlines.
- `prefers-reduced-motion` → version statique (terminal figé sur l'état final, GIFs en pause).
- Boucle infinie, mais **pas de clignotement agressif** (cf. choix déjà faits dans l'app).

## 4. GIFs (le côté « drop the mic »)

- **Moments** : 1 GIF “effort” au lancement (chat qui tape / “this is fine”), 1 GIF **punchline**
  à la fin (**Obama drop the mic**, ou “boom”, ou “mind blown”).
- **Sourcing / droits** ⚠️ (à acter) : le clip Obama est *rights-managed*. Options :
  1. **Embed Giphy/Tenor** (ils gèrent les droits) — simple, mais dépendance externe + tracking.
  2. **GIFs libres** (Giphy “GIPHY Originals”, ou créer nos propres GIFs maison avec Claudy).
  3. **Pixel art maison** animé (le plus “à notre image”, zéro souci de droits) — recommandé à terme.
- **Perf** : lazy-load, `loading="lazy"`, formats légers (préférer **WebP/MP4 muet en boucle**
  plutôt que GIF lourd), poids cible < 1–2 Mo par anim.

## 5. Structure de la page (one-page)

1. **Hero** : logo aviateur + `agent-claudy` + tagline (« Tes agents Claude Code, en têtes de
   Claudy. ») + **CTA Télécharger** + sous-CTA GitHub. Le **terminal** est le héros visuel (au centre).
2. **Démo terminal** (§3) — peut être fusionnée au hero ou juste en dessous, plein cadre.
3. **« Comment ça marche »** — 3 étapes illustrées : ① Lance → ② Tes sessions apparaissent toutes
   seules → ③ Clique une tête = focus de la fenêtre. (Réutiliser de vraies têtes.)
4. **Features** (grille de cartes, 1 citation Claudy par carte) :
   - Essaim de sous-agents (statut par tête : vert/rouge/ambre + compteur)
   - Notifs natives **cliquables** (clic → la bonne session)
   - App **menubar** + **fenêtre flottante** (raccourci `⌃⌥C`)
   - **Focus** de la fenêtre (VS Code / terminal) au clic
   - Panneau de **réglages** intégré (zéro variable d'env à éditer)
   - **Zéro dépendance npm** / local / rapide
5. **Téléchargement** (§6) — gros bloc, prérequis clairs.
6. **Footer** : crédits *Dikkenek* / François Damiens, lien GitHub, citation, mention licence MIT.

## 6. Téléchargement de l'installer — à acter

Aujourd'hui le projet se lance via `npm start` / F5 / scripts `mac/build-*.sh`. Il n'existe **pas
encore d'artefact “installer” unique**. Décider la (ou les) voie(s) :

- **A. Script one-liner** (dev-friendly, recommandé en primaire) :
  `curl -fsSL https://<domaine>/install.sh | bash` → clone/télécharge le repo, build les apps mac,
  propose le démarrage au login. Fun, transparent, multiplateforme pour la partie serveur.
- **B. Téléchargement `.app`/`.dmg`** (grand public macOS) : `agent-claudy.app` zippé.
  ⚠️ **Signature/notarisation** : aujourd'hui ad-hoc → Gatekeeper affichera un avertissement.
  Décision : notariser (compte développeur Apple) **ou** documenter le « clic droit → Ouvrir ».
- **C. `npx agent-claudy`** : publier le serveur sur npm (zéro-dép → trivial). Pratique mais ne
  couvre pas les apps natives mac.
- **Prérequis affichés** : macOS, **Node ≥ 18**. Bouton intelligent (détecte macOS).

> ✅ À décider : artefact(s) retenu(s), hébergement des binaires, domaine, et politique de signature.

## 7. Stack technique recommandée

- **Statique pur** (HTML/CSS/JS vanilla), **zéro dépendance** (cohérent avec le repo).
  Hébergeable sur GitHub Pages / Netlify / Vercel.
- **Réutilise** `public/claudy.js`, `public/face.png`, `media/claudy.svg`, la palette et des bouts
  de `public/styles.css`. La timeline du terminal = un petit moteur JS scripté (tableau d'événements
  + horloge), **pas** de SSE/serveur.
- **Perf/SEO/access** : 1 page légère, images lazy, `prefers-reduced-motion`, balises OG/Twitter
  (aperçu = logo aviateur sur fond sombre), `alt` partout, contraste OK, CTA accessible clavier.

## 8. Contenu à préparer (assets)

- [ ] Tagline + micro-copy des sections (réservoir de répliques : `data/quotes.json`).
- [ ] Script définitif de la timeline terminal (§3) — punchlines validées.
- [ ] 2–3 GIFs/animations (effort + punchline) + décision droits (§4).
- [ ] Image OG/Twitter (1200×630, logo aviateur).
- [ ] Lien dépôt + URL de l'installer (§6).

## 9. Décisions actées ✅

1. **Installer** : **A en primaire** (le plus simple → `install.sh`, `curl … | bash`) **ET**
   **B en parallèle** (`.dmg` macOS via `mac/build-dmg.sh`, contient les 2 apps + lien Applications).
   Signature : ad-hoc pour l'instant → la page documente le « clic droit → Ouvrir » (notarisation = plus tard).
2. **GIFs** : **embeds Giphy/Tenor** pour les memes (droits gérés, rapide) **+** slot pour des
   **anims pixel-Claudy maison** (signature, zéro souci de droits) — montées progressivement.
3. **Hébergement / domaine** : à préciser (statique → GitHub Pages / Netlify / Vercel).
4. **Périmètre v1** : hero + terminal animé + download d'abord ; features/étapes ensuite.

---

### Prochaine étape proposée
Valide §6 (installer) et §4 (GIFs) — ce sont les deux seuls points bloquants. Dès que c'est tranché,
je peux **prototyper le hero + le terminal animé** (statique, réutilisant `claudy.js`) en une passe.
