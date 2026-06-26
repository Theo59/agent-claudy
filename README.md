# 👓 Agent Claudy

A **pixel art** visualizer for AI agents. Each agent is a head of **Claudy Focan**
(*Dikkenek*) who:

- **talks** (animated mouth + his cult one-liners) when the agent is **working**;
- puts on a **waiting face** (dimmed) when it's **done**;
- **demands your attention** (pulsing red border + his request) when it needs you.

You can display **as many heads as you have agents**. It runs locally on your Mac, in
the browser (with or without VSCode), **with zero npm dependencies**.

## Requirements

- **Node.js ≥ 18** (`node --version`). Nothing else to install.

## Getting started

```bash
npm start          # ou : node server/server.js
```

Then open **http://127.0.0.1:4310**. Running Claude Code sessions **show up on their
own** (see [Automatic discovery](#automatic-session-discovery)). With no session open,
open **⚙ Settings** (top right) → **Demo mode** to watch the heads come to life.

To change the port: `CLAUDY_PORT=5000 npm start`. In that case, **also point the CLI and
the hook to the URL** via `CLAUDY_URL`, otherwise they keep targeting port 4310:

```bash
export CLAUDY_URL=http://127.0.0.1:5000
```

## Configuration (panel ⚙)

Every setting is driven **from the UI**: click the **gear icon** in the top right. The
panel writes `~/.config/claudy/config.json` (read by the server) — no need to export
environment variables anymore. **Most settings apply on the fly** (discovery, sub-agents,
scan cadence, notifications…); `port`/`host` require a restart (flagged as such).

**Precedence**: `defaults < config.json < environment variable`. An option forced by an
env variable (launchd, CLI, extension) **wins** and shows up **locked** in the panel —
ops stays in control. **Demo mode** is also driven from this panel.

> API: `GET /api/config` (schema + values + locked keys), `PUT /api/config` (patch).

The face is **pixel art derived from a real photo** (background cut out) for the
resemblance. To regenerate it or try another one, see the header of `tools/derive-face.cjs`,
then replace `public/face.png`.

## In VS Code (extension — recommended)

So you don't have to juggle a terminal and a browser tab, agent-claudy is also a
**VS Code extension**: the heads show up in an editor panel and the server starts on its
own.

1. Open this folder in VS Code.
2. Press **F5** ("Launch agent-claudy (extension)"): an *Extension Development Host*
   window opens.
3. Click the **agent-claudy** icon (glasses + mustache) in the activity bar on the left.

The local server starts automatically (or reuses the one already running via `npm start`).

**Status bar** (bottom left): `📣 Claudy 2▶ 1⏳ 1⁉` — number of agents per state;
turns **orange** as soon as an agent calls for you. A click opens the panel.

**Commands** (palette `⇧⌘P`, prefix "agent-claudy"):

| Command | Effect |
| --- | --- |
| Open the panel | shows the heads in the side bar |
| Open in the browser | opens the UI in the default browser |
| Demo (start / stop) | toggles demo mode |
| Set an agent's state… | pushes a state by hand (quick test) |
| Restart the server | restarts the local server |
| **Install the Claude Code hooks** | writes the hook config into `~/.claude/settings.json` (with a `.bak` backup) |

**Settings** (`agentClaudy.*`): `port` (4310), `autoStartServer` (true), `autoStartDemo` (false).

> To install the extension for good (outside F5): `vsce package` then
> `code --install-extension agent-claudy-*.vsix`.

## macOS menubar app (launcher)

For daily use without VS Code, a small **menu bar app** (glasses 👓) serves as the entry
point:

```bash
bash mac/build-bar.sh        # compile mac/agent-claudy.app (swiftc, zéro dépendance)
open mac/agent-claudy.app
```

From the menu (👓 in the top right): **Start the server** if it's unreachable, the list
of agents (click = focus the window), **Settings…** (opens the ⚙ panel), **Demo**, and a
**Start at login** (checkbox: installs/removes the LaunchAgent via `mac/install-login.sh`).
The badge turns **red** as soon as an agent calls for you.

## Agent states

Each agent is a **comic-strip panel**: a comic-book-style speech bubble at the top (spanning
the full width of the panel, with a tail pointing toward the head), Claudy's **head** below,
and the name. Status is shown by a **colored outline that hugs the silhouette** of the head
(not a round ring). The line changes slowly (long enough to read). In `idle`/`offline`, no
bubble: the panel shrinks to the head + the name. Panels adapt to the number of agents and
the top bar summarizes the statuses (`● 3  ◔ 1  ‼ 1`).

When a session launches **sub-agents** (the Agent/Task tool) or a **workflow**, a row of
**mini-heads** appears below the parent head (a swarm) — one per active sub-agent, with its
type in a tooltip. A **click on a head** brings the agent's window (VS Code / terminal) to
the foreground.

| State         | Outline / head                          | Typical trigger                |
| ------------- | --------------------------------------- | ------------------------------ |
| `working`     | green outline (pulsing) + nodding + quotes | the agent is running a task |
| `idle`        | gray outline, dimmed head               | the agent has finished         |
| `needs_input` | blinking red outline + the request in a bubble | the agent is waiting for an answer |
| `offline`     | dark outline, dimmed head               | session ended                  |

## Automatic session discovery

By default, the server reads the **Claude Code session registry** (`~/.claude/sessions/*.json`,
one file per session, kept up to date by Claude Code) every ~2 s and displays **one head per
live session**, with zero configuration:

- `status: busy` → **working**, `status: idle` → **idle**;
- a session whose **process is dead** disappears automatically;
- the name comes from the registry (`name`) or, failing that, from the working directory (`cwd`).

Only the **`needs_input`** state (red alert "the agent is calling for you") isn't in the
registry: it's provided by the hook (see [§ hooks](#3-red-alert-needs_input-with-claude-code-hooks)),
which lands on the same head. This is the **hybrid mode**.

Settings: everything is driven from the **⚙ panel** (see [Configuration](#configuration-panel-)),
but each setting also has an **environment variable** (which takes precedence over `config.json`):

| Variable | Effect | Default |
| --- | --- | --- |
| `CLAUDY_PORT` / `CLAUDY_HOST` | listening port / address (restart required) | `4310` / `127.0.0.1` |
| `CLAUDY_DISCOVER=0` | disables discovery (demo/pure-CLI mode) | enabled |
| `CLAUDY_SUBAGENTS=0` | hides the sub-agent swarm | enabled |
| `CLAUDY_POLL_MS` | scan interval (ms) | `2000` |
| `CLAUDY_SUB_FRESH_MS` / `CLAUDY_SUB_MAX` | "active" freshness window for a sub-agent / max mini-heads | `25000` / `16` |
| `CLAUDY_SESSIONS_DIR` / `CLAUDY_PROJECTS_DIR` | registry / transcripts folders | `~/.claude/sessions` · `~/.claude/projects` |
| `CLAUDY_HIDE_SESSION` | full `sessionId` to hide | none |
| `CLAUDY_NOTIFY=0` / `CLAUDY_NOTIFY_SOUND=0` | turns off macOS notifications / their sound | enabled |
| `CLAUDY_MUTE_CC=1` | mutes Claude Code's native notifications (anti-duplicate) while the server is running | disabled |
| `CLAUDY_OVERRIDE_TTL_MS` | expiry of an uncleared `needs_input` alert (ms) | `600000` |
| `CLAUDY_CONFIG` | path to the config file | `~/.config/claudy/config.json` |
| `CLAUDY_CC_SETTINGS` | path to the Claude Code settings (for anti-duplicate) | `~/.claude/settings.json` |

> Security: the server only accepts **loopback** requests (Host `127.0.0.1`/`localhost`) and
> rejects any cross-site origin — a website you visit can't drive your local agent-claudy.

## Wiring up your agents (manually)

For agents **outside Claude Code** (scripts, other tools), three ways to report state.

### 1. From the command line (`claudy-report`)

```bash
node bin/claudy-report.js mon-agent working --name "Crawler"
node bin/claudy-report.js mon-agent needs_input --request "Je continue ?"
node bin/claudy-report.js mon-agent idle
node bin/claudy-report.js mon-agent --delete
```

### 2. Via the HTTP API (from any language)

```bash
curl -X POST http://127.0.0.1:4310/api/agents/mon-agent \
  -H 'content-type: application/json' \
  -d '{"name":"Builder","state":"working"}'
```

| Method   | Route                  | Effect                                        |
| -------- | ---------------------- | --------------------------------------------- |
| `GET`    | `/api/events`          | real-time SSE stream (used by the UI)         |
| `GET`    | `/api/agents`          | JSON list of agents                           |
| `POST`   | `/api/agents/:id`      | create/update `{name?, state?, quote?, request?}` |
| `DELETE` | `/api/agents/:id`      | removes the agent                             |
| `POST`   | `/api/notify/:id`      | red alert: `{request?, name?}` (or `{clear:true}`) |
| `DELETE` | `/api/notify/:id`      | clears the red alert                          |
| `GET`    | `/api/quotes`          | Claudy Focan's quotes                         |
| `POST`   | `/api/demo`            | `{action:"start"\|"stop", count?}`            |
| `GET`    | `/api/config`          | schema + values + keys locked by the env      |
| `PUT`    | `/api/config`          | applies a config patch (writes `config.json`) |
| `POST`   | `/api/focus/:id`       | brings the agent's window to the foreground (macOS) |

### 3. Red alert `needs_input` with Claude Code hooks

[Automatic discovery](#automatic-session-discovery) already handles `working` / `idle` /
`offline`. The `bin/claudy-hook.js` hook is now only used for **the red alert**: it sets /
clears the `needs_input` state on the session's head (same id as discovery).

| Claude Code event                                   | Effect on the red alert  |
| --------------------------------------------------- | ------------------------ |
| `Notification`                                      | **sets** `needs_input`   |
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStop` / `SessionEnd` | **clears** the alert |

The simplest way: in VS Code, run the command **"agent-claudy: Install the Claude Code
hooks"** (it writes the config automatically, with a `.bak` backup). Otherwise, copy
`hooks/settings.example.json` into `~/.claude/settings.json` (merging) and replace
`ABSOLUTE_PATH` with the path to this project. The hook **never blocks** Claude: if the
server is down or slow, it fails silently (1 s timeout + safeguard). Without the hook
installed, everything still works — you just lose the red alert.

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

## Credits

Lines from **Claudy Focan** (*Dikkenek*, 2006), played by François Damiens.
Quotes: <https://phraseculte.wordpress.com/2017/05/30/claudy-focan-dikkenek/>

> « Éducation minimum ! »
