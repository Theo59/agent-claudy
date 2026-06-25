# agent-claudy

> Fichier d'instructions projet lu par Claude Code à chaque session.
> Il définit **comment on travaille ici** : conventions, bonnes pratiques et journal de bord.

## Vue d'ensemble

- **Objectif** : visualiseur local d'agents IA. Chaque agent = une tête de **Claudy Focan**
  (*Dikkenek*) en pixel art qui parle + cite Claudy quand il travaille, attend quand il a
  fini, et réclame (alerte rouge) quand il a besoin d'une réponse. Autant de têtes que d'agents.
- **Cible** : tourne en local sur macOS, dans le navigateur (avec ou sans VSCode).
- **Parti pris** : **zéro dépendance npm** (Node natif `http` + SSE) pour un lancement immédiat.
- Voir le `README.md` pour l'usage complet (API, CLI, hooks Claude Code).

## Stack & commandes

- **Backend** : Node.js ≥ 18, ESM, serveur `http` natif + Server-Sent Events. Aucune dépendance.
  Config centralisée (`server/config.js` → `~/.config/claudy/config.json`, pilotée par le
  panneau ⚙ via `/api/config`, application à chaud ; précédence défauts < fichier < env).
- **Frontend** : HTML/CSS + `<canvas>` (scripts classiques, pas de bundler). Avatar = pixel art
  **dérivé d'une photo** (`public/face.png`, tête 64×64, fond détouré) dessiné sur canvas.
  UI en **tuiles compactes** responsives (taille décroît avec le nombre d'agents) ; statut =
  **contour coloré épousant la silhouette** (drop-shadow sur l'alpha, pas un anneau rond) ;
  **case de BD** = bulle en haut (pleine largeur, queue vers la tête, réplique qui change ~6,5 s),
  tête dessous, nom ; hochement de tête. **Essaim de sous-agents** : chaque session affiche en
  dessous une rangée de **mini-têtes** (une par sous-agent/workflow actif).
- **Extension VS Code** : `extension/extension.cjs` (**CommonJS**, car la racine est `type:module`).
  Manifeste fusionné dans `package.json` (`main`, `engines.vscode`, `contributes`). Embarque le
  serveur (spawn via `process.execPath` + `ELECTRON_RUN_AS_NODE`) et affiche l'UI dans une webview
  (iframe → `asExternalUri(http://127.0.0.1:port)`). F5 via `.vscode/launch.json`.
- **Intégration** : CLI `bin/claudy-report.js` + hook Claude Code `bin/claudy-hook.js`
  (installable via la commande VS Code « Installer les hooks Claude Code »).

| Action | Commande |
| --- | --- |
| Lancer le serveur seul | `npm start` (ou `node server/server.js`) |
| Lancer en dev (reload) | `npm run dev` |
| Lancer l'extension | **F5** dans VS Code (Extension Development Host) |
| Ouvrir l'UI (navigateur) | http://127.0.0.1:4310 (port via `CLAUDY_PORT` ; pour un port non standard, exporter aussi `CLAUDY_URL` pour le CLI/hook) |
| Pousser un état | `node bin/claudy-report.js <id> <état>` |
| Vérif syntaxe | `node --check <fichier>.js` (`.cjs` inclus) |
| Tests | _aucun framework pour l'instant — validation manuelle via curl + mode démo_ |

> États d'agent : `working`, `idle`, `needs_input`, `offline`.

## Bonnes pratiques de code

Ces règles s'appliquent quelle que soit la stack retenue.

### Lisibilité d'abord
- Le code est lu bien plus souvent qu'il n'est écrit : privilégier la clarté à l'astuce.
- Noms explicites (variables, fonctions, fichiers). Pas d'abréviations obscures.
- Fonctions courtes, à responsabilité unique. Si une fonction fait « X **et** Y », la scinder.
- Suivre le style du code environnant (indentation, conventions de nommage, idiomes).

### Robustesse
- Gérer les erreurs explicitement ; ne pas avaler les exceptions en silence.
- Valider les entrées aux frontières (I/O, réseau, arguments CLI, données externes).
- Éviter les états globaux mutables ; préférer des données immuables quand c'est raisonnable.

### Simplicité
- YAGNI : ne pas coder pour des besoins hypothétiques.
- DRY avec discernement : factoriser la duplication réelle, pas créer d'abstractions prématurées.
- Supprimer le code mort plutôt que le commenter.

### Sécurité
- **Jamais** de secret en dur (clés API, tokens, mots de passe). Utiliser variables d'env / `.env` non commité.
- Ne jamais logger de données sensibles.
- Vérifier `.gitignore` avant le premier commit (secrets, `node_modules/`, artefacts de build, etc.).

### Tests
- Tout comportement non trivial doit avoir un test.
- Lancer la suite de tests avant de considérer une tâche terminée.
- Préférer des tests rapides et déterministes.

### Documentation
- Commenter le **pourquoi**, pas le **quoi** (le code dit déjà le quoi).
- Tenir ce `CLAUDE.md` et le `README` à jour quand l'architecture ou les commandes changent.

## Workflow Git

- **Une nouvelle branche par feature / modification.** Ne jamais empiler plusieurs
  changements sans rapport sur une même branche, ni travailler directement sur `main` :
  tirer une branche dédiée (`feat/…`, `fix/…`, `docs/…`) au début de chaque tâche.
- Commits **atomiques** au format [Conventional Commits](https://www.conventionalcommits.org/) :
  `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`…
- Ne commiter / pusher que sur demande explicite.

## Journal de bord

> Convention : à chaque session de travail significative, ajouter une entrée datée
> (la plus récente en haut). Format : `### AAAA-MM-JJ — Titre court` puis des puces
> décrivant ce qui a été fait et pourquoi.

### 2026-06-25 — Donations crypto (panneau in-app self-custody + bouton Sponsor)
- Demande : permettre de **faire un don crypto** au créateur. Choix retenus : **panneau
  in-app self-custody** (zéro tiers, offline, fidèle au design rétro) **+** bouton **Sponsor**
  du repo via `.github/FUNDING.yml`. Cryptos : **BTC, ETH/EVM (USDC/USDT ERC-20), SOL
  (USDC/USDT SPL)**. URIs standard **BIP-21 / EIP-681 / Solana Pay**.
- **Source unique** : `public/donations.json` (3 wallets + placeholders `REMPLACER_*`). Lue
  **en direct** par le panneau navigateur ET par le générateur node → une seule place à éditer.
  Une adresse encore en placeholder est affichée « non configurée » et ne génère **aucun QR/URI**
  (un wallet mal configuré ne peut pas tromper un donateur).
- **QR sans dépendance npm** : encodeur **MIT vendorisé** `public/vendor/qrcode.js`
  (qrcode-generator 1.4.4, copie verbatim pour la licence). Marche en **navigateur** (script
  classique → global `qrcode`) ET en **node** : le repo étant `type:module`, un `.js` est traité
  en ESM, donc le générateur le charge via `new Function(src+';return qrcode;')()` (évite tout
  souci d'extension ESM/CJS). QR généré **côté client** dans le panneau (swap d'adresse =
  QR auto-régénéré, aucun asset à refaire).
- **Panneau** (`public/donate.js`) : bouton ❤ `#donate-open` dans la topbar → `<dialog>` réutilisant
  le skin `.settings`. Par wallet : nom + tokens acceptés + réseau + **adresse clic-pour-copier**
  (clipboard API + fallback execCommand) + **QR**. `index.html` : bouton ❤ + `<script>` vendor avant
  `donate.js`. CSS : cartes claires (QR sombre-sur-clair scannable), bouton copier doré → vert au succès.
- **DONATIONS.md + QR statiques** : `tools/gen-donations.cjs` (CJS, repo type:module) régénère
  `DONATIONS.md` (rendu GitHub, ne peut pas exécuter de JS → QR commités en `media/qr/<id>.svg`)
  depuis le même JSON. `.github/FUNDING.yml` : `custom:` → DONATIONS.md (bouton Sponsor crypto-natif).
- **À FAIRE par le créateur** : remplacer les 3 `address` dans `public/donations.json` par tes vraies
  adresses (dédiées aux dons), `node tools/gen-donations.cjs`, puis **transaction test** avant publication.
- Validé : `node --check` (donate.js), accolades CSS 172/172, JSON valide, générateur OK (placeholders →
  0 QR ; test fausse adresse BTC → QR SVG + bloc adresse, puis restauré), serveur sert les 3 nouveaux
  fichiers (HTTP 200). **Rendu navigateur du panneau/QR à valider au reload** (+ adresses réelles à poser).

### 2026-06-25 — Réordonnancement des cartes par glisser-déposer (persisté)
- Demande : pouvoir **déplacer les cartes** pour s'organiser (pendant : le renommage par
  double-clic existe déjà ; même esprit de personnalisation locale).
- **Frontend only** (`public/app.js`, `public/styles.css`), zéro changement serveur. Ordre
  manuel persisté en **localStorage** (`claudy:order` = tableau d'ids), exactement comme les
  surnoms (`claudy:name:*`). `applyManualOrder(list)` re-trie la liste serveur (triée par nom)
  selon l'ordre sauvé ; les ids non encore placés gardent l'ordre serveur, en fin. `reconcile`
  utilise désormais `applyManualOrder(list)` pour le réalignement DOM **et saute** ce
  réalignement tant qu'un drag est en cours (`dragging`) → un message SSE entrant ne combat plus
  le repositionnement live.
- **DnD HTML5** : `.card` passe `draggable=true` + `dataset.agentId` ; `dragstart`/`dragend` par
  carte (classe `.dragging`, persistance de l'ordre DOM au drop via `persistDomOrder`), et
  `dragover`/`drop` posés **une fois** sur la grille (`setupDnd`). `dragAfterElement(x,y)` gère la
  grille **2D** (centre le plus proche, avant/après selon le côté du curseur). `persistDomOrder`
  ne sauve que les cartes présentes → purge auto des ids périmés.
- **Cohabitation** : le renommage **désactive** `draggable` pendant l'édition (sinon sélectionner
  du texte démarrerait un déplacement), réactivé au commit. La tête garde son clic « focus
  fenêtre » (curseur pointer), le nom son curseur texte ; le **corps de carte** = `cursor: grab`
  (→ `grabbing` à l'`:active`/`.dragging`, carte estompée à 0,45 pendant le drag).
- Validé : `node --check`, accolades CSS 155/155, `Content-Length` du `/app.js` servi == local.
  **Rendu/ergonomie du drag à valider au reload** (le glisser n'est pas vérifiable côté serveur).
- Retours : (1) la **hauteur fixe clippait l'essaim de mini-Claudy** (workflows dynamiques) —
  c'est l'effet wahou, à garder ; (2) compacter encore la carte.
- **Hauteur fixe retirée** : `.card` n'a plus `height: var(--card-h)` et `.children` n'est plus
  une zone scrollable → la carte **regrandit** pour afficher TOUTES les mini-têtes (grille déjà en
  `align-items:start`, donc rangées en hauteurs libres facon planche). `applyDensity` ne pose plus
  `--card-h` (revert ; ne garde que `--tile`/`--avatar`).
- **Compaction** : `.card` gap 8→6, padding-bottom 9→6 ; queue de bulle `margin-bottom` 20→15.
  Cartes sans essaim = compactes ; cartes avec workflow = grandissent pour l'effet wahou.
- Validé : `node --check`, accolades CSS 153/153, essaim/mini/syncChildren intacts, zéro `--card-h`.
  **À valider au reload** (notamment un workflow en cours pour revoir l'essaim).

### 2026-06-25 — Pictos → étiquettes texte mono, dans les coins hauts (design system)
- Retours : (1) les emoji (💬 ⚙️ ★) sortent du design system (mono / crème / rétro) ; (2) les
  placer plus haut, dans les coins de la carte (croquis utilisateur : ovales aux coins).
- Pictos refaits en **étiquettes-pilules texte mono** (`plan`/`edit`/`auto`/`bypass`/`normal` ;
  `high`/`xhigh`/`max`/`ultra`), bordure fine + fond sombre translucide, **uppercase** 8px →
  langage visuel du projet. Placées **top: -13px** (creux bulle↔tête) contre les bords (offset
  `calc((--avatar−--tile)/2)` qui suit la densité). `ULTRA` = texte violet **multicolore animé**
  (`ultra-rainbow` sur `color`) + lueur `currentColor` + bordure violette ; halo violet sur la
  tête conservé. Emoji aussi retirés de la ligne d'activité (`prettyTool` → nom brut, MCP =
  « serveur/action »). Validé : `node --check`, accolades CSS 155/155. **À valider au reload.**

### 2026-06-25 — Révision pictos : tout rendre visible (mode/modèle/action) + étoile lisible
- Retour : « je ne vois ni le mode, ni le modèle, ni l'action ». Le design *minimal* cachait trop
  (mode `auto` masqué, modèle/outil passés en infobulle), et l'étoile ultracode était quasi
  invisible (`background-clip:text` + `text-fill: transparent` → glyphe transparent).
- Corrigé : **mode TOUJOURS affiché** (picto TL : ⚙️ auto, 💬 default, 📋 plan, ✏️ edit, ⛔ bypass) ;
  **ligne action + modèle réaffichée** sous le nom (« ❯_ Bash · Opus 4.8 ») — réglable via
  `showActivity` ; **étoile ultracode lisible** : violet vif #a78bfa, 16px, cyclant dans
  l'arc-en-ciel (`@keyframes ultra-rainbow` sur `color`, glow en `currentColor`) → visible + multicolore.
- Hauteurs un poil relevées pour la ligne (150→166 / 140→156 / 128→144 / 118→132), toujours bien
  en deçà des 214 d'origine. Validé : `node --check`, accolades CSS 155/155 ; API live →
  `cc-b24cd8db` = mode auto + effort ultracode + activity (Bash, Opus 4.8). **À valider au reload.**

### 2026-06-25 — Petites cartes : pictos en coins de tête + ultracode violet/multicolore
- Retour utilisateur : cartes trop grandes ; exploiter l'espace **autour de la tête** (coins
  haut-gauche / haut-droit) en **pictos** ; **ultracode** distingué en **violet** ou multicolore.
- **Design choisi par workflow** (4 directions × 3 juges, gagnant *two-corner-minimal* 72/75 ;
  greffes intégrées) : 2 pictos absolus sur `.avatar` — **mode** en haut-gauche (📋 plan / ✏️ edit /
  ⚠️ bypass ; `auto`/`default` masqués), **effort** en haut-droit (▲ high / ⏫ xhigh / ⚡ max ;
  **★ ultracode**). Offsets négatifs → **zéro hauteur ajoutée**. `:empty` → cachés. Outil + modèle
  basculés en **infobulle de la tête** (plus de ligne d'activité dans le flux).
- **Ultracode** (double signal) : l'étoile ★ = **dégradé conique multicolore** (`background-clip:text`)
  + **shimmer** animé (`hue-rotate` 0→360) + lueur violette ; ET un **halo violet sur la silhouette**
  de la tête (on AJOUTE 2 `drop-shadow` violets à `--outline` pour `.card[data-ultra]`, en gardant
  la couleur d'état et le même nombre de fonctions filter que les keyframes → interpolation fluide).
  `prefers-reduced-motion` coupe l'animation.
- **Cartes plus petites** : hauteurs `--card-h` 214/200/186/174 → **150/140/128/118** ; l'essaim
  reste la zone scrollable interne (taille fixe préservée).
- Nettoyage : suppression du CSS/JS des anciens « badges » (chips sous le nom) devenus morts ;
  `showBadges` pilote désormais les pictos (`.grid.hide-badges .picto`), `showActivity` l'infobulle ;
  libellés config mis à jour. `data-ultra` posé en JS quand `effort==="ultracode"`.
- Validé : `node --check` (3 fichiers) ; accolades CSS équilibrées (149/149), zéro réf morte ;
  API live → `cc-b24cd8db` (cette session) repérée `effort=ultracode` (étoile + halo). Édité via
  scripts atomiques (course continue avec la session de traduction des commentaires). **Rendu visuel
  des pictos / de l'ultracode à valider au reload** ; hauteurs faciles à réajuster.

### 2026-06-25 — Cartes à taille fixe + éléments d'affichage configurables
- Demande : les cartes ne doivent **plus grandir** avec le contenu (taille **fixe**, on pave
  l'espace dispo), et les **éléments visibles** doivent être paramétrables.
- **Taille fixe** : `applyDensity` (app.js) pose désormais aussi `--card-h` par palier de densité
  (214 / 200 / 186 / 174 px). `styles.css` : `.card { height: var(--card-h) }` ; l'**essaim**
  (`.children`) devient la zone flexible **scrollable** (`flex:1; min-height:0; overflow-y:auto`)
  → il défile À L'INTÉRIEUR de la carte au lieu de l'agrandir. Grille `align-items:start` +
  hauteur fixe = rangées uniformes.
- **Visibilité configurable** : 4 bascules (`showBubble`, `showBadges`, `showActivity`,
  `showSwarm`, défaut on) ajoutées au `SCHEMA` (`server/config.js`, groupe **Affichage**, env
  `CLAUDY_SHOW_*`). `snapshot()` (server.js) joint un bloc `display` à CHAQUE snapshot ; comme
  `config.onChange` déclenche `broadcast()`, une bascule s'applique **en live** via SSE. Frontend :
  `applyDisplay()` pose des classes sur `.grid` (`hide-bubble/-badges/-activity/-swarm`) → CSS
  masque ; clé absente = visible (compat ancien serveur). Le panneau ⚙ (settings.js, rendu par
  groupe) affiche le groupe Affichage automatiquement.
- Validé : `node --check` (3 fichiers) ; `/api/config` expose le groupe Affichage ; `display`
  présent dans le snapshot ; `PUT {showActivity:false}` → `display.activity=false` instantané.
  Édité via script atomique (course persistante avec la session de traduction des commentaires).
  **Rendu visuel (hauteur fixe, scroll de l'essaim, bascules) à valider au reload.**

### 2026-06-25 — Mode de session (plan/edit) + niveau d'effort (ultracode visible)
- Suite de la remontée d'infos : on affiche désormais le **mode** de la session
  (`permissionMode` : plan / acceptEdits / auto / default) et le **niveau d'effort**, avec
  l'**ultracode** mis en avant (la demande explicite de l'utilisateur : « voir si on est en
  ultracode »).
- `server/discover.js` : le **mode** est lu dans la queue du transcript en même temps que
  l'activité (`latestActivity` renvoie `{tool, model, mode}`, dernier `permissionMode`). L'**effort**
  est posé par `/effort` et PERSISTE (souvent défini très tôt, hors queue) → `sessionEffort` suit
  le transcript de façon **incrémentale** : 1re lecture complète une fois, puis seulement le delta
  ajouté (le JSONL n'ajoute que des lignes complètes), mémoïsé par taille (`effortCache`). Marqueur
  **structuré** insensible à la pollution : message dont le `content` est la CHAÎNE
  `<local-command-stdout>Set effort level to <X>…` (un résultat d'outil a un content tableau →
  écarté). Calculés pour les sessions **actives** uniquement. Champs ajoutés à la signature de pub.
- `server/server.js` : `snapshot`/`upsertAgent` propagent `mode`/`effort` ; démo enrichie
  (demo-1 en `acceptEdits` + `ultracode` ; une tête en `plan`/`high`).
- Frontend : rangée **`.badges`** sous le nom — puce **mode** (📋 Plan / ✏️ Edit / ⚙️ Auto, `default`
  masqué) et puce **effort** (high/xhigh/max, et **⚡ ULTRACODE** en puce pleine dorée + lueur).
  `prettyMode`/`prettyEffort`/`setBadges` ; masquage `:empty`. Édité via script atomique car une
  AUTRE session Claude traduisait les commentaires FR→EN en continu (course avec l'outil Edit).
- Validé : `node --check` (3 fichiers) ; scan réel → `cc-8f746ae7` = `mode:auto, effort:ultracode,
  activity:Workflow` (vraie session en ultracode lançant un workflow), sessions idle → `null`
  (I/O évitée) ; API live confirme après redémarrage. **Rendu navigateur des badges à valider.**

### 2026-06-25 — Audit (sécu + code) avant publication + durcissement
- Audit multi-agents (workflow, 6 dimensions, vérif adversariale → 52 trouvailles ; détail dans
  le scratchpad `AUDIT.md`). Bonne base : aucun secret fuité, XSS frontend maîtrisé (`textContent`),
  SSE robuste, pas de fuite DOM, a11y/reduced-motion OK.
- **Sécu serveur (P0)** : `server.js` rejette tout Host non-loopback (anti DNS-rebinding) et toute
  Origin cross-site (anti-CSRF, y c. « simple requests ») ; CORS restreint à l'origine loopback (plus
  de `*`). Neutralise le cluster `/api/focus`(spawn)/CSRF/rebinding. `serveStatic` durci (`resolve`+`sep`).
- **Robustesse** : `sessionId` validé contre la traversée de chemin (`discover.js`) ; Maps/caches bornés
  (`overrides`/`agents`, `activityCache`/`labelCache`) ; `ping` SSE `unref()`.
- **Écriture atomique** de `settings.json` (`claudy-mute-claude.js`, temp+`rename`). **Hook** : `CLAUDY_URL`
  restreint au localhost. **Extension** : CSP `frame-src` au port configuré + garde de type sur settings.
- **Mac/shell** : LaunchAgent résout `node` au runtime (survit aux switches nvm), valide `--port`, échappe
  `--hide-session` en XML ; menubar Swift `findNode`→alerte si absent, pas de double-lancement.
- **Repo public** : chemins absolus personnels retirés des sources ; `.gitignore` complété ; `LICENSE` MIT.
- Différé (noté) : CSP serveur (risque sur le `mask` data:), refacto `settings.js` (sûr), contraste WCAG offline.

### 2026-06-25 — Activité courante (outil + modèle) + raison d'attente sur les têtes
- Nouvelles infos remontées des sessions, à coût d'I/O maîtrisé : **dernier outil utilisé**
  + **modèle** par session, et **`waitingFor`** (pourquoi la tête réclame).
- `server/discover.js` : `readTail` lit la **queue** (~64 Ko) du transcript
  `…/<sessionId>.jsonl` ; `latestActivity` en extrait `{tool, model}` en parcourant les
  dernières lignes à l'envers (1er `tool_use` = le plus récent), **mémoïsé par mtime**
  (`activityCache`, borné par `capCache`) → quasi gratuit au repos, re-parse seulement si le
  fichier a bougé. Calculé **uniquement pour les sessions actives** (`isActive`). `waitingFor`
  lu directement du registre de session (présent quand `status==="waiting"`). Garde anti
  traversée via `isSafeId` sur le sessionId. Champs ajoutés à la signature de publication
  (broadcast SSE quand l'outil change).
- `server/server.js` : `snapshot()` et `upsertAgent` propagent `activity`/`waitingFor`. Démo
  enrichie (outils cyclés `DEMO_TOOLS`, `waitingFor:"dialog open"` sur la tête needs_input).
- Frontend (`public/app.js`, `styles.css`) : ligne **`.activity`** sous le nom (« ✏️ Edit ·
  Opus 4.8 »), masquée si vide (`:empty`) ; `prettyTool` (emoji + nom, MCP réduit à
  `serveur/action`), `prettyModel` (`claude-opus-4-8`→« Opus 4.8 »), `prettyWaiting` (raison
  lisible). Le détail d'attente s'affiche au survol de la bulle rouge + annonce lecteur d'écran.
- Validé : `node --check` (3 fichiers) ; scan réel → `activity={Bash/Read, Opus 4.8}` sur les
  sessions actives, `null` au repos (I/O évitée) ; fixture `waiting` → `waitingFor:"dialog open"`
  + activité ensemble ; API live confirme l'exposition après redémarrage. **Rendu navigateur de
  la ligne d'activité à valider au reload.**

### 2026-06-25 — Statut `waiting` de Claude Code : workflows redevenus visibles
- **Bug** : « j'ai des workflows en cours que je ne vois pas ». Claude Code ≥ 2.1.187 a
  introduit un nouveau statut de session **`waiting`** (`waitingFor:"dialog open"`) : le main
  loop est bloqué sur un dialog **pendant qu'un workflow tourne en tâche de fond**.
- Deux bugs en cascade dans `server/discover.js` : (1) `mapStatus` ne connaissait que
  `busy→working`, **tout le reste → idle**, donc `waiting` → tête grise ; (2) `gatherSwarm`
  n'était scanné **que si `state === "working"`** → l'essaim d'un workflow lancé en arrière-plan
  d'une session `waiting` restait **invisible**.
- **Fix** : `mapStatus` mappe désormais `waiting → needs_input` (l'agent réclame une réponse =
  tête rouge). Nouveau prédicat `isActive(status)` (= `busy || waiting`) ; le scan de l'essaim
  est conditionné à `isActive(meta.status)` au lieu de `state === "working"` → un workflow en
  tâche de fond reste découvert même quand le parent attend un dialog. I/O toujours évitée pour
  les sessions `idle`. Découplé de l'overlay `needs_input` du hook (aucune I/O parasite).
- Validé : `node --check` ; **rejeu contrôlé** d'un vrai workflow (76 fichiers, journal
  rafraîchi) sous une session `waiting` → `state=needs_input`, `swarm={done:74,failed:0,
  working:1,total:75}`, 16 mini-têtes (childExtra 60), **0 faux rouge** ; avant le fix la même
  session ressortait `idle/swarm:null/children:[]`. Serveur redémarré → `cc-8f746ae7` passe en
  `needs_input` en live.

### 2026-06-24 — Essaim de workflow : statut par tête (done/fail/en cours) + compteur
- L'essaim ne montrait que les sous-agents **actifs** (ils disparaissaient une fois finis).
  Désormais, pour un **workflow**, on affiche **toutes les têtes du run** colorées par statut
  et un **compteur de progression** « X✓ Y✗ Z◔ / total ».
- Source : chaque workflow écrit `…/subagents/workflows/wf_<id>/journal.jsonl` (événements
  `started` + `result` par `agentId`) + un `<agent>.meta.json` (type d'agent, voie rapide pour
  le libellé). `server/discover.js` : `readWorkflowJournal` + `gatherSwarm` croisent journal et
  fraîcheur des fichiers → statut par tête : **done** (a un `result`), **working** (pas encore
  de result tant que le journal vit), **failed** (pas de result ET workflow terminé).
- **Garde-fou anti-faux-rouge** : on n'accuse l'échec qu'une fois le **journal figé** (run
  fini) — un agent qui « réfléchit » longtemps reste *working*, pas *failed*. Un workflow fini
  reste affiché ~30 s puis s'efface (LIVE_WINDOW). **Le total prévu n'existe pas sur disque**
  (agents créés dynamiquement) → pas de têtes « grisées à venir » ; on compte le *lancé*.
- Modèle : la session porte `children[]` (`{id,name,status,workflowId}`) + `swarm`
  `{done,failed,working,total}`. Frontend (`app.js`/`styles.css`) : mini-têtes colorées par
  `data-status` (working=ambre pulsant + hochement, done=vert, failed=rouge atténué fixe),
  compteur de progression. Démo enrichie (essaim factice avec statuts).
- Validé : `node --check` ; **50 vrais journaux** de workflow rejoués (terminés → tout vert,
  0 faux rouge ; interrompus → échecs corrects) ; démo `4✓ 1✗ 2◔ / 7`. **Rendu navigateur à
  valider au reload** ; un vrai workflow lancé montrera l'évolution live.

### 2026-06-24 — Logo aviateur + notifications natives cliquables (app menubar)
- **Nouveau logo** : lunettes **aviateur Ray-Ban** de Claudy (verres en goutte, double pont,
  barre de front) + **moustache en fer à cheval**, bien plus reconnaissable que les lunettes
  rectangulaires. Conçu en SVG, vérifié par rendu PNG (`qlmanage`). Marque **centralisée** :
  `<symbol id="claudy-mark">` défini une fois dans `index.html`, réutilisé via `<use>` (topbar,
  état vide, footer, panneau, settings.js) + favicon (data-URI) + `media/claudy.svg` →
  **un seul endroit à modifier**. Icône d'app carrée : `media/claudy-icon.svg` (squircle sombre
  + aviateurs dorés).
- **Notifications natives refondues** : avant, le serveur notifiait via `osascript`
  (`display notification`) → macOS l'attribuait à **« Éditeur de script »** (clic = ouvre Script
  Editor, pas d'icône custom, clic non routable). Désormais c'est **l'app menubar** qui émet via
  `UserNotifications` : elle détecte les bascules → `needs_input` (poll 2 s, anti-doublon par
  `prevStates`/`seeded`), poste une notif avec **le logo** (icône du bundle) et **route le clic**
  vers `/api/focus/:id` (ramène la fenêtre de la session). `server.js` : `macNotify` supprimé.
- **Build app** (`mac/build-bar.sh`) : génère le `.icns` (qlmanage→sips→iconutil), lie
  `-framework UserNotifications`, **signe en ad-hoc** (`codesign -s -`, sinon
  `requestAuthorization` échoue en silence sur macOS récent). Menubar : retrait de la démo,
  ajout « Fenêtre flottante ».
- **Configurable** : `notify` (on/off) + nouveau `notifySound` (son) dans la config (⚙ Réglages) ;
  l'app menubar lit `/api/config` avant de notifier. À la 1re notif, macOS demande l'autorisation.
- Validé : `node --check` ; build menubar (icône + signature OK) ; bascule `needs_input`
  détectée. **Rendu visuel de la notif/permission à valider** (nécessite l'accord macOS).

### 2026-06-24 — Passage « en pro » : config UI + topbar sobre + menubar launcher
- **Couche de config** (`server/config.js`, nouveau) : source de vérité unique éditable
  depuis l'UI, écrite dans `~/.config/claudy/config.json`. `SCHEMA` couvre toutes les
  anciennes `CLAUDY_*`. Précédence **défauts < fichier < env** ; une clé forcée par l'env est
  `overridden` (verrouillée dans l'UI). Lecture sync au boot (PORT/HOST), écriture atomique
  (tmp+rename), `onChange` pour l'application à chaud. Routes `GET`/`PUT /api/config`.
- **Refactor backend** : `server.js` et `discover.js` lisent `config.get()` **au point d'usage**
  au lieu de `const` figés → la plupart des réglages s'appliquent **sans redémarrage**. La
  découverte passe d'un `setInterval(POLL_MS)` à une **boucle `setTimeout` auto-replanifiée**
  qui relit `pollMs` à chaque tour ; `scanOnce` se coupe seul si `discover` est off. `muteClaude`
  ne s'auto-gère plus (l'appelant décide on/off, y compris à la bascule UI).
- **UI pro** (`public/index.html`, `styles.css`) : topbar refondue = **marque lunettes** +
  cluster de statut + **un seul bouton ⚙** (les 2 gros boutons démo supprimés). Nouveau
  **panneau de réglages** `public/settings.js` (`<dialog>` natif, vanilla) : toggles/champs
  groupés depuis `/api/config`, `PUT` au changement, badges « redémarrage requis » / cadenas
  « défini par CLAUDY_X », **mode démo déplacé ici**, options avancées repliées. `app.js` :
  retrait du câblage des boutons démo.
- **Branding 👓 partout** : logo lunettes+moustache (repris de `media/claudy.svg`) en favicon,
  topbar, état vide, footer, titre du panneau ; `🎬`→`👓` dans le log serveur et le README.
- **Menubar launcher** (`mac/claudy-bar.swift`) : devient un vrai point d'entrée — **Démarrer
  le serveur** (spawn `node` détaché, résolution du binaire hors PATH minimal), **Réglages…**
  (ouvre `#settings`), **Démarrer au login** (case à cocher = présence du LaunchAgent, bascule
  `install-login.sh`/`uninstall-login.sh`). Recompile via `mac/build-bar.sh`.
- Validé : `node --check` tous fichiers ; `GET/PUT /api/config` (valeurs/overridden/restart) ;
  **hot-apply** `discover` off→0 agents / on→5 sans redémarrage ; `config.json` écrit puis
  nettoyé ; app menubar **compile**. **Rendu navigateur du panneau non vérifiable ici** → à
  valider au reload (⚙ ouvre, démo pilotable, favicon lunettes).

### 2026-06-24 — Contour silhouette + essaim de sous-agents
- **Style** : l'anneau rond de statut devient un **contour qui épouse la silhouette** de
  Claudy. Technique : `filter: drop-shadow()` empilé (8 directions) sur le `<canvas>` →
  suit le canal alpha de la tête détourée. Couleur via `--ring` posée par `data-state` ;
  pulsation/alerte = lueur (`drop-shadow` flou) animée, même nb de fonctions filter aux 2
  étapes pour une interpolation fluide. `.avatar` perd le rognage rond + le fond dégradé.
  Épaisseur réglée fine (1px / 0,7px en diagonale). Validé visuellement par l'utilisateur.
- **Sous-agents (essaim)** : découverte de la granularité par sous-agent. Claude Code écrit
  un transcript par sous-agent dans `~/.claude/projects/<cwd encodé>/<sessionId>/subagents/
  agent-<id>.jsonl` (workflows groupés sous `…/subagents/workflows/wf_<id>/`). `discover.js`
  scanne ces fichiers pour chaque session **en travail** : mtime frais (< `CLAUDY_SUB_FRESH_MS`,
  défaut 25 s) = actif, figé = terminé. Le **type d'agent** (libellé) se lit via
  `"attributionAgent"` dans le fichier (lecture de l'en-tête seulement, mémoïsée), sans
  relire le gros transcript parent. Encodage cwd = `/`→`-` (vérifié).
- Modèle de données : chaque session porte `children[]` (`{id,name,state,workflowId}`) +
  `childExtra` (débordement au-delà de `CLAUDY_SUB_MAX`=16). Propagé par `snapshot()` ;
  `upsertAgent` préserve les `children` (pour la démo). Signature de publication étendue aux
  ids enfants → broadcast seulement quand l'essaim change (pas à chaque tick de mtime).
- Frontend : `app.js` réconcilie une **rangée de mini-têtes** par session (`syncChildren`),
  animées (hochement déphasé) dans la boucle rAF ; `styles.css` `.children`/`.mini` (contour
  vert fin, `--ring` propre au sous-agent). Démo : la 1ère tête reçoit 3 sous-agents factices.
- Validé de bout en bout : sous-agent réel lancé en arrière-plan → détecté `working` avec
  libellé « Explore », id `cc-<sess8>-sub-<id8>` ; vieux fichiers (~1 h) correctement
  ignorés ; `node --check` OK partout. **Rendu navigateur non vérifiable ici** → à valider.
- Limite : les *background* lancés via `Bash run_in_background` (commandes shell, pas des
  sous-agents) n'ont pas de fichier → comptés seulement par `pendingBackgroundAgentCount`,
  sans tête individuelle. Activable/désactivable via `CLAUDY_SUBAGENTS` (défaut on).

### 2026-06-24 — Auto-découverte des sessions Claude Code (mode hybride)
- Objectif : voir **toutes** les sessions Claude Code de la machine sans config manuelle.
- Découverte : Claude Code tient un registre `~/.claude/sessions/<PID>.json`
  (`{pid, sessionId, cwd, status:"busy"|"idle", name?}`, MAJ en continu). Nouveau module
  `server/discover.js` le scanne toutes les ~2 s, **filtre les PID vivants** (`process.kill(pid,0)`),
  mappe `busy→working` / `idle→idle`, `id = cc-<sessionId[:8]>` (identique au hook). Ne diffuse
  que sur changement réel (signature). Robuste si le dossier manque (no-op + avertissement unique).
- Serveur (`server/server.js`) : `snapshot()` **fusionne 3 sources** — découverte (working/idle)
  + agents manuels (démo/CLI, inchangés) + overlay `overrides` (needs_input). Nouvel endpoint
  `POST/DELETE /api/notify/:id` pour poser/lever l'alerte rouge ; overlay à **TTL 10 min**
  (filet de sécurité). Découverte activable via `CLAUDY_DISCOVER` (défaut on), `CLAUDY_POLL_MS`,
  `CLAUDY_SESSIONS_DIR`, `CLAUDY_HIDE_SESSION`.
- Hook (`bin/claudy-hook.js`) : **rôle réduit** au mode hybride — ne gère plus que `needs_input`
  (`Notification` pose, `UserPromptSubmit`/`PreToolUse`/`Stop`/`SessionEnd` lèvent), via
  `/api/notify`. `working`/`idle`/`offline` viennent désormais de la découverte. `hooks/settings.example.json`
  et la liste `HOOK_EVENTS` de l'extension VS Code réduits en conséquence.
- Validé : 5 sessions vivantes détectées (dont celle-ci), pose/lève d'alerte via curl ET via
  hook réel (stdin Notification → needs_input, UserPromptSubmit → levée), coexistence démo +
  découverte (2 démo + 5 cc-). `node --check` OK sur tous les fichiers.
- Reste possible : afficher les sessions mortes en `offline` (grâce), filtrer par `kind`,
  masquer la session courante par défaut (option dispo via `CLAUDY_HIDE_SESSION`).

### 2026-06-24 — Queue de bulle en virgule (coup de pinceau) + police responsive
- Queue de bulle refaite façon BD : `.bubble::after` n'est plus un triangle plat mais une
  **virgule courbe** (masque SVG, couleur via `var(--frame)` → suit crème/rosé) qui s'effile
  et pointe vers la bouche. Forme choisie après rendu de variantes en PNG (QuickLook).
- Bug corrigé : la queue (et l'ancien triangle) était **rognée par `overflow:hidden`** de la
  bulle. Le texte tronqué (4 lignes) a été déplacé dans un `<span.bubble-text>` interne ; `.bubble`
  peut désormais déborder (`app.js` crée le span, `setBubble` écrit dedans).
- Débordement de texte sur petites tuiles : police de la bulle passée en
  `clamp(8px, 6.2cqi, 12px)` avec `container-type: inline-size` sur `.card` (+ `overflow-wrap`).

### 2026-06-24 — Case sans fond + bulle fondue dans la bordure
- `.card` : **plus de fond** (`background: transparent`), **bordure épaisse crème** (`--frame`,
  3px) = couleur de la bulle. La bulle (même `--frame`, sans bordure propre, haut plat collé au
  cadre via `padding-top:0` + `overflow:hidden`) **se fond dans la bordure**. Queue = un seul
  triangle crème.
- `--frame` vire au rosé en `needs_input` (bordure + bulle). Tête au repos : `:has()` rajoute un
  padding-top pour ne pas coller au cadre.
- **Validé par l'utilisateur** : fusion bulle↔cadre parfaite, épaisseur 3px OK, teinte crème
  `#efe6cf` conservée. Design des cases figé en l'état.

### 2026-06-23 — Cases de BD (bulle en haut, pleine largeur)
- La bulle flottante par-dessus le visage ne marchait pas (écrasait la tête, tronquée). Refonte
  d'après des planches de BD fournies : chaque agent = une **case encadrée** (border + fond),
  **bulle en haut sur toute la largeur** (queue vers la tête), **tête en dessous**, nom en bas.
- Ordre DOM : `bubble, avatar, name`. Bulle **en flux** (plus de chevauchement) ; `.show` pilote
  l'affichage (working/needs_input) ; `display:-webkit-box` + clamp 4 lignes ; queue en triangles
  centrée. Grille `align-items:start` (hauteurs variables façon planche), pleine largeur.
- Rythme **sans clignotement** : la bulle reste affichée, la réplique change toutes les ~6,5 s.
- Planchers de densité relevés (≥146 px) pour que la bulle pleine largeur reste lisible. Retiré
  l'infobulle `title` (parasite) → `aria-label` à la place. Retiré `SHOW_MS`/`PAUSE_MS`/`speaking`.

### 2026-06-23 — Bulle BD + rythme parler/pause
- Remplacé le bloc de texte sous l'avatar (gâchait de la place) par une **bulle façon BD** en
  surimpression (`position:absolute`, queue en triangles pointant vers la bouche, fond crème /
  contour sombre ; rouge pour `needs_input`). Ne consomme aucune place en flux → tuiles plus serrées.
- **Rythme parler/pause** dans `app.js` : `working` → bulle visible `SHOW_MS` (5,2 s) puis cachée
  `PAUSE_MS` (2,4 s) avant la réplique suivante (volontairement lent, plus lisible que l'ancien 3 s).
  `needs_input` → bulle persistante. `idle`/`offline` → pas de bulle.
- Hochement de tête conservé (demandé). Retiré `IDLE_LINES`/`pickIdleLine`/`lastQuoteAt`.
- Non vérifiable ici (pas de capture navigateur) : position exacte de la queue / chevauchement
  des bulles flottantes en grille dense → à valider au rechargement.

### 2026-06-23 — UI compacte en tuiles + anneau de statut
- Objectif : voir tous les agents à la fois. Cartes refondues en **tuiles compactes** (grille
  `auto-fill` + variables `--tile`/`--avatar` recalculées selon le nombre d'agents → tuiles plus
  petites quand il y en a plus).
- **Tête découpée** en avatar rond : `public/face.png` recadré sur la tête (64×64), `claudy.js`
  le dessine dans un cercle (`.avatar` overflow:hidden + border-radius).
- **Statut = anneau coloré** autour de la tête (box-shadow piloté par `data-state`) : vert pulse
  (travaille), gris (attente), rouge clignotant (demande), sombre (offline). Plus de gros badge
  ni de bordure de carte clignotante.
- Citations/demandes en **bulle tronquée 2 lignes** (texte complet en `title`). Résumé de statut
  `● ◔ ‼` dans la barre du haut. Démo passée à 6 agents pour montrer la densité. `PX`=3.
- Non vérifiable ici (pas de capture navigateur) : rendu exact de la grille/anneaux → à valider
  au rechargement.

### 2026-06-23 — Visage dérivé d'une photo (vraie ressemblance)
- Le pixel art dessiné à la main n'était pas reconnaissable. Nouvelle approche : **réduire en
  pixels une vraie photo** de François Damiens (image #2, lunettes claires) → ressemblance fidèle.
- Pipeline `tools/derive-face.cjs` : `sips` recadre+réduit la photo en BMP, le script lit le BMP,
  **détoure le fond** (flood-fill depuis les bords + garde « fond froid/bleu » pour ne pas mordre
  le front), posterise légèrement, recadre sur le contenu, exporte `public/face.png` (67×78, fond
  transparent). Vérifié visuellement par rendu PNG.
- `public/claudy.js` réécrit en **rendu image** (charge `face.png`, dessine sur canvas, pixelisé) ;
  animation = hochement de tête (marqué en travail) + bulle de citations ; plus de bouche dessinée
  (jurerait sur une photo). `dim` pour `idle`, teinte rouge pour `needs_input`.
- Retiré la bascule 👓/🕶 et les grilles dessinées : la variante soleil (image #3, fond brique
  chaud) ne se détoure pas proprement — mise de côté. `PX`=4, affichage CSS 150×175.
- À faire si besoin : variante lunettes de soleil (détourage manuel ou shades dessinées par-dessus).

### 2026-06-23 — Pixel art v2 d'après photos (32×38, 2 variantes)
- Retravaillé le visage d'après deux photos de référence fournies : lunettes **fines à
  monture dorée** (verres clairs → yeux visibles, ou teintés), front dégarni + cheveux en
  arrière, pattes, moustache fer à cheval modérée, peau plus claire, col crème ouvert.
- Deux variantes embarquées dans `public/claudy.js` (`clear` / `sun`) + bascule 👓/🕶 dans la
  barre du haut (`app.js`, mémorisée via localStorage), passée à `Claudy.draw({variant})`.
- Grille 16×20 → 28×32 → **32×38** ; `PX`=8, affichage CSS 160×190 ; bouche repositionnée
  (cols 13–18, ~lignes 23–25), état fermé = léger sourire.
- Générateur `tools/render-claudy.cjs` mis à jour (32×38, `SUN=1` pour la variante) ; aperçus
  versionnés `media/claudy-preview.png` et `…-sun.png`.
- Vérifié : les DEUX grilles de `claudy.js` identiques au pixel près aux PNG validés, palette
  complète, placement bouche OK, syntaxe OK, serveur sert bien la nouvelle version.

### 2026-06-23 — Refonte du pixel art (visage reconnaissable)
- Remplacé la grille 16×20 schématique par un visage 28×32 bien plus reconnaissable :
  aviateurs teintées à montures dorées + reflets, **moustache en fer à cheval** (signature
  de Claudy), cheveux bruns + pattes, col de chemise rayé, contour sombre pour le relief.
- Méthode : `tools/render-claudy.cjs` compose le visage par primitives, l'exporte en **PNG**
  (encodeur zéro dépendance via `zlib`) pour inspection visuelle, puis dump la grille collée
  dans `public/claudy.js`. Aperçu versionné : `media/claudy-preview.png`.
- Bouche animée repositionnée sous la moustache (cols 11–16, lignes ~21–23) ; `PX` 9→8,
  taille d'affichage CSS 154×176 (ratio 7:8).
- Vérifié : grille de `claudy.js` **identique au pixel près** au rendu validé, palette
  complète, bouche ouverte/fermée correctement placée, syntaxe OK.
- Pour retoucher le visage : éditer `tools/render-claudy.cjs`, `node tools/render-claudy.cjs`,
  ouvrir le PNG, puis recopier `claudy-grid.json` dans `public/claudy.js`.

### 2026-06-23 — Extension VS Code (v0.2.0)
- Empaquetage en extension VS Code pour un usage pratique (inspiration : outils de
  visualisation d'agents intégrés à l'éditeur), sans réécrire le serveur/UI.
- `extension/extension.cjs` : démarrage auto du serveur (réutilise un serveur déjà actif sur
  le port, sinon spawn via `process.execPath`+`ELECTRON_RUN_AS_NODE`), panneau webview (iframe
  vers l'UI via `asExternalUri`), barre d'état (résumé par état, orange si `needs_input`),
  commandes (ouvrir, navigateur, redémarrer, démo, définir un état, installer les hooks).
- Manifeste ajouté à `package.json` ; icône `media/claudy.svg` ; `.vscode/launch.json` pour F5.
- Validé : `node --check` sur le `.cjs`, cohérence du manifeste (commandes/menus/vue),
  et surtout le cycle spawn-serveur/probe/kill reproduit hors VS Code → OK.
- À confirmer à l'exécution dans un vrai VS Code : chargement de l'iframe localhost dans la
  webview (pattern standard mais non testable ici).

### 2026-06-23 — Revue multi-agents + durcissement
- Revue adversariale du code (3 dimensions : frontend, serveur, intégration), chaque
  trouvaille re-vérifiée par un second agent : 10 confirmées, 1 écartée (faux positif
  path-traversal, non atteignable).
- **Serveur (HIGH)** : coercition des champs texte (`asText`) pour ne plus empoisonner la
  Map / le tri ; parsing d'URL défensif (Host vide ne crashe plus) ; `broadcast()` et le
  timer de démo enveloppés en try/catch ; handlers `unhandledRejection`/`uncaughtException`.
- **Frontend** : citation affichée immédiatement au chargement (plus de bulle vide ~3 s) ;
  ordre des cartes réaligné sur le tri serveur ; `aria-live` retiré de la grille animée au
  profit d'une région dédiée annonçant uniquement les `needs_input` (accessibilité).
- **CLI/hook** : `--help`/`help` propres (exit 0) ; option sans valeur signalée ;
  `fetch` du hook avec timeout 1 s + garde-fou `setTimeout(exit, 2000)`.
- **Doc** : `CLAUDY_URL` documenté pour les ports non standard.
- Re-testé : noms non-string, Host vide, démo, codes de sortie CLI → serveur stable, exit OK.

### 2026-06-23 — Construction du visualiseur (v0.1.0)
- Objectif et stack fixés (cf. sections ci-dessus) : Node natif + SSE, zéro dépendance.
- Récupéré les 14 répliques de Claudy Focan → `data/quotes.json` (source unique).
- Serveur `server/server.js` : API REST agents, flux SSE, mode démo intégré, fichiers statiques.
- UI `public/` : pixel art de Claudy (grille 16×20) sur canvas, bouche animée, bulles de
  citations, bordure rouge pulsante pour `needs_input`, grille responsive d'une carte par agent.
- Intégration : CLI `bin/claudy-report.js` + hook Claude Code `bin/claudy-hook.js`
  (`hooks/settings.example.json`).
- Validé de bout en bout : `node --check` sur tous les JS, tests curl (CRUD agents, SSE,
  démo, statique, path-traversal bloqué), hooks (mapping événement→état, exit 0 si serveur off),
  rendu ASCII du pixel art (lignes = 16 colonnes).
- Reste à faire : tester le rendu visuel dans un vrai navigateur ; granularité par sous-agent
  (actuellement une tête par session Claude Code).

### 2026-06-23 — Initialisation du projet
- Création de ce `CLAUDE.md` : conventions de code, workflow Git et convention de journal de bord.
