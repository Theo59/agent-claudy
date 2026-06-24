# 👓 agent-claudy

Visualiseur d'agents IA en **pixel art**. Chaque agent est une tête de **Claudy Focan**
(*Dikkenek*) qui :

- **parle** (bouche animée + ses répliques cultes) quand l'agent **travaille** ;
- prend une **tête en attente** (atténuée) quand il a **fini** ;
- **réclame ton attention** (bordure rouge pulsante + sa demande) quand il a besoin de toi.

Tu peux afficher **autant de têtes que d'agents**. Ça tourne en local sur ton Mac, dans
le navigateur (avec ou sans VSCode), **sans aucune dépendance npm**.

## Prérequis

- **Node.js ≥ 18** (`node --version`). Rien d'autre à installer.

## Démarrage

```bash
npm start          # ou : node server/server.js
```

Puis ouvre **http://127.0.0.1:4310**. Les sessions Claude Code en cours **apparaissent
toutes seules** (voir [Découverte automatique](#découverte-automatique-des-sessions)). Sans
session ouverte, ouvre **⚙ Réglages** (en haut à droite) → **Mode démo** pour voir les têtes
s'animer.

Pour changer le port : `CLAUDY_PORT=5000 npm start`. Dans ce cas, **indique aussi
l'URL au CLI et au hook** via `CLAUDY_URL`, sinon ils continuent de viser le port 4310 :

```bash
export CLAUDY_URL=http://127.0.0.1:5000
```

## Configuration (panneau ⚙)

Tous les réglages se pilotent **depuis l'UI** : clique la **roue crantée** en haut à droite.
Le panneau écrit `~/.config/claudy/config.json` (lu par le serveur) — plus besoin d'exporter
des variables d'environnement. La **plupart des réglages s'appliquent à chaud** (découverte,
sous-agents, cadence de scan, notifications…) ; `port`/`host` demandent un redémarrage (signalé).

**Précédence** : `défauts < config.json < variable d'environnement`. Une option forcée par une
variable d'env (launchd, CLI, extension) **gagne** et apparaît **verrouillée** dans le panneau —
l'ops garde la main. Le **mode démo** se pilote aussi depuis ce panneau.

> API : `GET /api/config` (schéma + valeurs + clés verrouillées), `PUT /api/config` (patch).

Le visage est un **pixel art dérivé d'une vraie photo** (fond détouré) pour la ressemblance.
Pour le régénérer ou en essayer un autre, voir l'en-tête de `tools/derive-face.cjs`, puis
remplace `public/face.png`.

## Dans VS Code (extension — recommandé)

Pour ne pas jongler entre un terminal et un onglet de navigateur, agent-claudy est aussi
une **extension VS Code** : les têtes s'affichent dans un panneau de l'éditeur et le serveur
démarre tout seul.

1. Ouvre ce dossier dans VS Code.
2. Appuie sur **F5** (« Lancer agent-claudy (extension) ») : une fenêtre *Extension Development
   Host* s'ouvre.
3. Clique sur l'icône **agent-claudy** (lunettes + moustache) dans la barre d'activité à gauche.

Le serveur local démarre automatiquement (ou réutilise celui déjà lancé via `npm start`).

**Barre d'état** (en bas à gauche) : `📣 Claudy 2▶ 1⏳ 1⁉` — nombre d'agents par état ;
passe en **orange** dès qu'un agent réclame. Un clic ouvre le panneau.

**Commandes** (palette `⇧⌘P`, préfixe « agent-claudy ») :

| Commande | Effet |
| --- | --- |
| Ouvrir le panneau | affiche les têtes dans la barre latérale |
| Ouvrir dans le navigateur | ouvre l'UI dans le navigateur par défaut |
| Démo (démarrer / arrêter) | bascule le mode démo |
| Définir l'état d'un agent… | pousse un état à la main (test rapide) |
| Redémarrer le serveur | relance le serveur local |
| **Installer les hooks Claude Code** | écrit la config des hooks dans `~/.claude/settings.json` (avec sauvegarde `.bak`) |

**Réglages** (`agentClaudy.*`) : `port` (4310), `autoStartServer` (true), `autoStartDemo` (false).

> Pour installer durablement l'extension (hors F5) : `vsce package` puis
> `code --install-extension agent-claudy-*.vsix`.

## App menubar macOS (launcher)

Pour un usage quotidien sans VS Code, une petite **app de barre de menus** (lunettes 👓)
sert de point d'entrée :

```bash
bash mac/build-bar.sh        # compile mac/agent-claudy.app (swiftc, zéro dépendance)
open mac/agent-claudy.app
```

Dans le menu (👓 en haut à droite) : **Démarrer le serveur** s'il est injoignable, la liste
des agents (clic = focus de la fenêtre), **Réglages…** (ouvre le panneau ⚙), **Démo**, et un
**Démarrer au login** (case à cocher : installe/retire le LaunchAgent via `mac/install-login.sh`).
Le badge passe au **rouge** dès qu'un agent réclame.

## États d'un agent

Chaque agent est une **case de BD** : une bulle façon bande dessinée en haut (sur toute la
largeur de la case, queue pointant vers la tête), la **tête** de Claudy en dessous, et le nom.
Le statut est donné par un **contour coloré qui épouse la silhouette** de la tête (pas un
anneau rond). La réplique change lentement (le temps de lire). En `idle`/`offline`, pas de
bulle : la case se réduit à la tête + le nom. Les cases s'adaptent au nombre d'agents et la
barre du haut résume les statuts (`● 3  ◔ 1  ‼ 1`).

Quand une session lance des **sous-agents** (outil Agent/Task) ou un **workflow**, une rangée
de **mini-têtes** apparaît sous la tête parente (essaim) — une par sous-agent actif, avec son
type en infobulle. Un **clic sur une tête** ramène la fenêtre de l'agent (VS Code / terminal)
au premier plan.

| État          | Contour / tête                          | Déclencheur typique            |
| ------------- | --------------------------------------- | ------------------------------ |
| `working`     | contour vert (pulse) + hochement + citations | l'agent exécute une tâche |
| `idle`        | contour gris, tête atténuée             | l'agent a terminé              |
| `needs_input` | contour rouge clignotant + la demande en bulle | l'agent attend une réponse |
| `offline`     | contour sombre, tête atténuée           | session terminée               |

## Découverte automatique des sessions

Par défaut, le serveur lit le **registre des sessions Claude Code** (`~/.claude/sessions/*.json`,
un fichier par session, tenu à jour par Claude Code) toutes les ~2 s et affiche **une tête par
session vivante**, sans aucune configuration :

- `status: busy` → **working**, `status: idle` → **idle** ;
- une session dont le **process est mort** disparaît automatiquement ;
- le nom vient du registre (`name`) ou, à défaut, du dossier de travail (`cwd`).

Seul l'état **`needs_input`** (alerte rouge « l'agent te réclame ») n'est pas dans le registre :
il est fourni par le hook (voir [§ hooks](#3-alerte-rouge-needs_input-avec-les-hooks-de-claude-code)),
qui se pose sur la même tête. C'est le **mode hybride**.

Réglages : tout se pilote depuis le **panneau ⚙** (cf. [Configuration](#configuration-panneau-)),
mais chaque réglage a aussi une **variable d'environnement** (qui l'emporte sur `config.json`) :

| Variable | Effet | Défaut |
| --- | --- | --- |
| `CLAUDY_PORT` / `CLAUDY_HOST` | port / adresse d'écoute (redémarrage requis) | `4310` / `127.0.0.1` |
| `CLAUDY_DISCOVER=0` | désactive la découverte (mode démo/CLI pur) | activée |
| `CLAUDY_SUBAGENTS=0` | masque l'essaim de sous-agents | activé |
| `CLAUDY_POLL_MS` | intervalle de scan (ms) | `2000` |
| `CLAUDY_SUB_FRESH_MS` / `CLAUDY_SUB_MAX` | fraîcheur « actif » d'un sous-agent / max de mini-têtes | `25000` / `16` |
| `CLAUDY_SESSIONS_DIR` / `CLAUDY_PROJECTS_DIR` | dossiers registre / transcripts | `~/.claude/sessions` · `~/.claude/projects` |
| `CLAUDY_HIDE_SESSION` | `sessionId` complet à masquer | aucun |
| `CLAUDY_NOTIFY=0` / `CLAUDY_NOTIFY_SOUND=0` | coupe les notifications macOS / leur son | activées |
| `CLAUDY_MUTE_CC=1` | coupe les notifs natives de Claude Code (anti-doublon) tant que le serveur tourne | désactivé |
| `CLAUDY_OVERRIDE_TTL_MS` | expiration d'une alerte `needs_input` non levée (ms) | `600000` |
| `CLAUDY_CONFIG` | chemin du fichier de config | `~/.config/claudy/config.json` |
| `CLAUDY_CC_SETTINGS` | chemin des réglages Claude Code (pour l'anti-doublon) | `~/.claude/settings.json` |

> Sécurité : le serveur n'accepte que les requêtes **loopback** (Host `127.0.0.1`/`localhost`) et
> refuse toute origine cross-site — un site web visité ne peut pas piloter ton agent-claudy local.

## Brancher tes agents (manuellement)

Pour des agents **hors Claude Code** (scripts, autres outils), trois façons de remonter l'état.

### 1. En ligne de commande (`claudy-report`)

```bash
node bin/claudy-report.js mon-agent working --name "Crawler"
node bin/claudy-report.js mon-agent needs_input --request "Je continue ?"
node bin/claudy-report.js mon-agent idle
node bin/claudy-report.js mon-agent --delete
```

### 2. Via l'API HTTP (depuis n'importe quel langage)

```bash
curl -X POST http://127.0.0.1:4310/api/agents/mon-agent \
  -H 'content-type: application/json' \
  -d '{"name":"Builder","state":"working"}'
```

| Méthode  | Route                  | Effet                                         |
| -------- | ---------------------- | --------------------------------------------- |
| `GET`    | `/api/events`          | flux SSE temps réel (utilisé par l'UI)        |
| `GET`    | `/api/agents`          | liste JSON des agents                         |
| `POST`   | `/api/agents/:id`      | crée/maj `{name?, state?, quote?, request?}`  |
| `DELETE` | `/api/agents/:id`      | retire l'agent                                |
| `POST`   | `/api/notify/:id`      | alerte rouge : `{request?, name?}` (ou `{clear:true}`) |
| `DELETE` | `/api/notify/:id`      | lève l'alerte rouge                           |
| `GET`    | `/api/quotes`          | les citations de Claudy Focan                 |
| `POST`   | `/api/demo`            | `{action:"start"\|"stop", count?}`            |
| `GET`    | `/api/config`          | schéma + valeurs + clés verrouillées par l'env |
| `PUT`    | `/api/config`          | applique un patch de config (écrit `config.json`) |
| `POST`   | `/api/focus/:id`       | ramène la fenêtre de l'agent au premier plan (macOS) |

### 3. Alerte rouge `needs_input` avec les hooks de Claude Code

La [découverte automatique](#découverte-automatique-des-sessions) gère déjà `working` /
`idle` / `offline`. Le hook `bin/claudy-hook.js` ne sert plus qu'à **l'alerte rouge** : il
pose / lève l'état `needs_input` sur la tête de la session (même id que la découverte).

| Événement Claude Code                               | Effet sur l'alerte rouge |
| --------------------------------------------------- | ------------------------ |
| `Notification`                                      | **pose** `needs_input`   |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStop` / `SessionEnd` | **lève** l'alerte |

Le plus simple : dans VS Code, lance la commande **« agent-claudy : Installer les hooks
Claude Code »** (elle écrit la config automatiquement, avec sauvegarde `.bak`). Sinon,
copie `hooks/settings.example.json` dans `~/.claude/settings.json` (en fusionnant) et
remplace `ABSOLUTE_PATH` par le chemin de ce projet. Le hook **ne bloque jamais** Claude :
si le serveur est éteint ou lent, il échoue silencieusement (timeout 1 s + garde-fou).
Sans hook installé, tout marche quand même — il ne manque que l'alerte rouge.

## Structure

```
agent-claudy/
├── extension/extension.cjs  # extension VS Code : serveur + panneau webview + barre d'état
├── media/
│   ├── claudy.svg           # icône de la barre d'activité
│   └── claudy-preview.png   # aperçu du visage
├── tools/derive-face.cjs    # dérive le visage pixel art depuis une photo (détourage → PNG)
├── server/
│   ├── server.js            # serveur HTTP + SSE + API + mode démo (zéro dépendance)
│   ├── config.js            # couche de config (~/.config/claudy/config.json + /api/config)
│   ├── discover.js          # auto-découverte sessions + essaim de sous-agents
│   └── focus.js             # « aller à la fenêtre de l'agent » (VS Code / terminal, macOS)
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── face.png             # avatar (tête recadrée 64×64, dérivée d'une photo, fond détouré)
│   ├── claudy.js            # dessine l'avatar + hochement / atténuation / teinte
│   ├── app.js               # client SSE, réconciliation des cartes, boucle d'animation
│   └── settings.js          # panneau de réglages ⚙ (config + mode démo)
├── mac/                     # app menubar + fenêtre flottante + démarrage au login (Swift/launchd)
├── bin/
│   ├── claudy-report.js     # CLI pour pousser un état
│   └── claudy-hook.js       # pont hooks Claude Code → serveur
├── hooks/settings.example.json
└── data/quotes.json         # les répliques cultes (source unique)
```

## Crédits

Répliques de **Claudy Focan** (*Dikkenek*, 2006), incarné par François Damiens.
Citations : <https://phraseculte.wordpress.com/2017/05/30/claudy-focan-dikkenek/>

> « Éducation minimum ! »
