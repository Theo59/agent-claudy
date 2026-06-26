// agent-claudy — macOS menubar app (single file, compiled via swiftc).
//
// Shows a live badge of the agents' state in the menu bar (turns red as soon
// as an agent needs attention), plus a menu to open the panel / drive the demo.
// It only READS the local server (http://127.0.0.1:PORT); all state comes from
// it (auto-discovery + hook). No external dependencies.
//
// Build :  mac/build-bar.sh   →   mac/agent-claudy.app

import Cocoa
import UserNotifications

let port = ProcessInfo.processInfo.environment["CLAUDY_PORT"] ?? "4310"
let baseURL = "http://127.0.0.1:\(port)"

struct Agent {
    let id: String
    let name: String
    let state: String
    let request: String
}

func glyph(_ state: String) -> String {
    switch state {
    case "working": return "🟢"
    case "needs_input": return "🔴"
    case "idle": return "🟡"
    default: return "⚪️"
    }
}

func label(_ state: String) -> String {
    switch state {
    case "working": return "travaille"
    case "needs_input": return "te réclame !"
    case "idle": return "en attente"
    default: return "hors ligne"
    }
}

// Where the Node runtime (server/, public/, data/, bin/) lives. Resolved so the app
// works whether it's a self-contained bundle (DMG → /Applications) or sitting in the repo.
func projectRoot() -> String {
    let fm = FileManager.default
    let bundle = Bundle.main.bundlePath as NSString
    // 1. Self-contained: runtime embedded in the bundle (DMG / dragged to Applications).
    let embedded = bundle.appendingPathComponent("Contents/Resources")
    if fm.fileExists(atPath: (embedded as NSString).appendingPathComponent("server/server.js")) {
        return embedded
    }
    // 2. In-repo build (…/mac/agent-claudy.app): project root is two levels up.
    let repo = (bundle.deletingLastPathComponent as NSString).deletingLastPathComponent
    if fm.fileExists(atPath: (repo as NSString).appendingPathComponent("server/server.js")) {
        return repo
    }
    // 3. Fallback: the curl installer's default clone location (~/.agent-claudy).
    return NSString(string: "~/.agent-claudy").expandingTildeInPath
}

// node isn't on the minimal PATH of an app launched by Finder/launchd: we look it up.
// Returns nil if no node executable is found (we then warn the user instead of
// falling back on a "/usr/bin/env node" that would fail silently).
func findNode() -> String? {
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    where FileManager.default.isExecutableFile(atPath: c) {
        return c
    }
    return nil
}

let loginPlist = NSString(string: "~/Library/LaunchAgents/com.claudy.agent-claudy.plist").expandingTildeInPath

final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var timer: Timer?
    var agents: [Agent] = []
    var connected = false
    var serverProcess: Process? // the node server WE spawned (so we can stop it on quit)
    var prevStates: [String: String] = [:] // previous state per agent (transition detection)
    var seeded = false // 1st scan: record without notifying (no alert for what already exists)

    func applicationDidFinishLaunching(_ note: Notification) {
        menu.delegate = self
        statusItem.menu = menu
        // Compact icon (Claudy's glasses) as a template image → adapts to the theme
        // and stays narrow (takes up the space of a single system icon).
        if let button = statusItem.button {
            let img = NSImage(systemSymbolName: "eyeglasses", accessibilityDescription: "agent-claudy")
            img?.isTemplate = true
            button.image = img
            button.imagePosition = .imageLeft
        }
        // Native notifications: THIS app (real bundle + icon) is the one emitting them, so
        // we can route the click to the session and show Claudy's logo.
        let nc = UNUserNotificationCenter.current()
        nc.delegate = self
        nc.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        bootstrap()
    }

    // First-launch onboarding so the user isn't left with a bare menu-bar icon:
    // always auto-start the server (the app is useless without it), and on the VERY first
    // run show a welcome window explaining where the app lives + offering to support it.
    func bootstrap() {
        // Wait ~1.8 s so the initial /api/agents probe has set `connected` → we don't
        // spawn a second server if one is already running (npm start, login agent…).
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self = self else { return }
            if !self.connected { self.startServerAction() }
            if !UserDefaults.standard.bool(forKey: "claudy.didOnboard") {
                UserDefaults.standard.set(true, forKey: "claudy.didOnboard")
                self.showWelcomeWindow()
            }
        }
    }

    // ── First-run welcome window (à la Shottr) ─────────────────────────────────
    var welcomeWindow: NSWindow?

    private func wLabel(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                        color: NSColor = .labelColor, align: NSTextAlignment = .center,
                        width: CGFloat? = nil) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.alignment = align
        l.lineBreakMode = .byWordWrapping
        l.maximumNumberOfLines = 0
        l.translatesAutoresizingMaskIntoConstraints = false
        if let w = width { l.widthAnchor.constraint(equalToConstant: w).isActive = true }
        return l
    }

    // A small welcome popup (logo + what-to-do + a "support the project" button).
    // @objc so the "Revoir la bienvenue" menu item can call it.
    @objc func showWelcomeWindow() {
        if let w = welcomeWindow {
            w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return
        }
        let logo = NSImageView()
        if let p = Bundle.main.path(forResource: "claudy", ofType: "icns") {
            logo.image = NSImage(contentsOfFile: p)
        }
        logo.imageScaling = .scaleProportionallyUpOrDown
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.widthAnchor.constraint(equalToConstant: 84).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 84).isActive = true

        let title = wLabel("Bienvenue dans agent-claudy", size: 20, weight: .bold)
        let desc = wLabel("Tes sessions Claude Code, en têtes de Claudy Focan — qui parlent, bossent et te réclament quand elles ont besoin de toi.",
                          size: 13, color: .secondaryLabelColor, width: 380)
        let bullets = wLabel("👓   L'app vit dans la barre de menus (en haut à droite).\n🪟   Fenêtre flottante toujours au‑dessus — raccourci ⌃⌥C.\n🖱️   Clique une tête → sa fenêtre revient au premier plan.\n🔔   Notification quand un agent te réclame.",
                             size: 13, align: .left, width: 380)

        let donate = NSButton(title: "Soutenir le projet 🙏", target: self, action: #selector(welcomeDonate))
        donate.bezelStyle = .rounded
        let go = NSButton(title: "C'est parti !", target: self, action: #selector(welcomeDismiss))
        go.bezelStyle = .rounded
        go.keyEquivalent = "\r" // default button (Return)
        let buttons = NSStackView(views: [donate, go])
        buttons.orientation = .horizontal
        buttons.spacing = 12

        let stack = NSStackView(views: [logo, title, desc, bullets, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 26, left: 30, bottom: 24, right: 30)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 460),
                         styleMask: [.titled, .closable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = true
        w.isReleasedWhenClosed = false
        w.contentView = content
        content.layoutSubtreeIfNeeded()
        w.setContentSize(content.fittingSize)
        w.center()
        welcomeWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // "Soutenir le projet" → deep-links to the in-app donation panel (#donate).
    @objc func welcomeDonate() {
        if let u = URL(string: "\(baseURL)/#donate") { NSWorkspace.shared.open(u) }
    }
    // "C'est parti" → close the welcome and show the floating window.
    @objc func welcomeDismiss() {
        welcomeWindow?.close()
        welcomeWindow = nil
        openFloat()
    }

    // Quitting the menubar app cleans up what it launched: the floating-window app,
    // and the server — but only the server WE spawned (a login-agent server is left alone).
    func applicationWillTerminate(_ note: Notification) {
        for app in NSWorkspace.shared.runningApplications
        where app.bundleIdentifier == "com.claudy.agent-claudy.float" {
            app.terminate()
        }
        if let p = serverProcess, p.isRunning {
            p.terminate()
        }
    }

    // ── Reading from the server ───────────────────────────────────────────
    func refresh() {
        guard let url = URL(string: "\(baseURL)/api/agents") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            guard let self = self else { return }
            var list: [Agent] = []
            var ok = false
            if err == nil, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["agents"] as? [[String: Any]] {
                ok = true
                for a in arr {
                    list.append(Agent(
                        id: a["id"] as? String ?? "",
                        name: a["name"] as? String ?? "?",
                        state: a["state"] as? String ?? "idle",
                        request: a["request"] as? String ?? ""))
                }
            }
            DispatchQueue.main.async {
                self.connected = ok
                if ok { self.notifyTransitions(list) } // alert on transition → needs_input
                self.agents = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                self.renderBadge()
            }
        }.resume()
    }

    // Detects transitions into `needs_input` and posts a native notification (once).
    func notifyTransitions(_ list: [Agent]) {
        for a in list where a.state == "needs_input" {
            if seeded && prevStates[a.id] != "needs_input" { maybeNotify(a) }
        }
        prevStates = Dictionary(list.map { ($0.id, $0.state) }, uniquingKeysWith: { a, _ in a })
        seeded = true
    }

    // Posts the notification if the server settings allow it (notify + notifySound).
    func maybeNotify(_ a: Agent) {
        guard let url = URL(string: "\(baseURL)/api/config") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            var notify = true
            var sound = true
            if let data = data,
               let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let v = j["values"] as? [String: Any] {
                notify = (v["notify"] as? Bool) ?? true
                sound = (v["notifySound"] as? Bool) ?? true
            }
            guard notify else { return }
            let content = UNMutableNotificationContent()
            content.title = a.name
            content.body = a.request.isEmpty ? "te réclame ton attention." : a.request
            if sound { content.sound = .default }
            content.userInfo = ["id": a.id]
            // stable identifier per agent → no stacking of duplicates for the same head.
            let req = UNNotificationRequest(identifier: "claudy-\(a.id)", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }.resume()
    }

    // ── Notifications: presentation + click ───────────────────────────────────
    // Show even when the app is in the foreground.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    // Click on the notification → brings the right session's window to the foreground.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["id"] as? String,
           let url = URL(string: "\(baseURL)/api/focus/\(id)") {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            URLSession.shared.dataTask(with: req).resume()
        }
        completionHandler()
    }

    // ── Badge in the menu bar ─────────────────────────────────────────────
    // Fixed (image) icon + a small number only when an agent needs attention:
    // we keep the badge as narrow as possible (the menu bar is often crowded).
    func renderBadge() {
        guard let button = statusItem.button else { return }
        button.alphaValue = connected ? 1.0 : 0.45 // greyed out if the server is unreachable
        let needs = connected ? agents.filter { $0.state == "needs_input" }.count : 0
        if needs > 0 {
            button.attributedTitle = NSAttributedString(
                string: " \(needs)",
                attributes: [
                    .foregroundColor: NSColor.systemRed,
                    .font: NSFont.menuBarFont(ofSize: 0),
                ])
        } else {
            button.title = ""
        }
    }

    // ── Menu rebuilt right before display (fresh data, zero churn) ─────────────
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let header = NSMenuItem(
            title: connected ? "agent-claudy" : "agent-claudy — serveur injoignable",
            action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if !connected {
            addAction(menu, "Démarrer le serveur", #selector(startServerAction))
        } else if agents.isEmpty {
            let empty = NSMenuItem(title: "Aucun agent actif", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for a in agents {
                // Clicking a row brings the agent's window to the foreground.
                let item = NSMenuItem(title: "\(glyph(a.state))  \(a.name) — \(label(a.state))", action: #selector(focusAgent(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = a.id
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        // No key equivalents: a status-item menu is not a regular app menu, so a shown
        // shortcut (⌘O…) would only fire while the menu is already open — misleading. The
        // items are click-only.
        addAction(menu, "Ouvrir le panneau", #selector(openPanel))
        addAction(menu, "Fenêtre flottante", #selector(openFloat))
        addAction(menu, "Réglages…", #selector(openSettings))
        addAction(menu, "Revoir la bienvenue", #selector(showWelcomeWindow))
        menu.addItem(.separator())
        // Start at login (launchd): the checkmark reflects whether the LaunchAgent is present.
        let login = NSMenuItem(title: "Démarrer au login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = FileManager.default.fileExists(atPath: loginPlist) ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        // target nil → the action bubbles up to NSApp (which knows how to respond to terminate:).
        menu.addItem(NSMenuItem(title: "Quitter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    }

    func addAction(_ menu: NSMenu, _ title: String, _ sel: Selector) {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
    }

    // ── Actions ───────────────────────────────────────────────────────────
    @objc func openPanel() {
        if let u = URL(string: baseURL) { NSWorkspace.shared.open(u) }
    }
    // Click on an agent row → asks the server to activate its window.
    @objc func focusAgent(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let url = URL(string: "\(baseURL)/api/focus/\(id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }
    // Starts the Node server if unreachable (the app becomes a real launcher).
    // Shows an alert (menubar app → we activate the app so the window comes to the front).
    func notifyError(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }

    @objc func startServerAction() {
        if connected {
            refresh() // server already reachable → we don't spawn a 2nd process on the same port
            return
        }
        guard let node = findNode() else {
            notifyError("node introuvable", "Installe Node ≥ 18 (par ex. « brew install node ») puis réessaie.")
            return
        }
        let root = projectRoot()
        let server = "\(root)/server/server.js"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [server]
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        p.environment = [
            "CLAUDY_PORT": port,
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ]
        do {
            try p.run() // detached: we don't wait
        } catch {
            notifyError("Démarrage du serveur impossible", error.localizedDescription)
            return
        }
        serverProcess = p // kept so we can stop it on quit (only the one WE spawned)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in self?.refresh() }
    }

    // Opens the panel straight on the settings (#settings unfolds the ⚙ panel).
    @objc func openSettings() {
        if let u = URL(string: "\(baseURL)/#settings") { NSWorkspace.shared.open(u) }
    }

    // Enables/disables start at login (launchd scripts in the mac/ folder).
    @objc func toggleLogin() {
        let root = projectRoot()
        let installed = FileManager.default.fileExists(atPath: loginPlist)
        let script = installed ? "uninstall-login.sh" : "install-login.sh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = installed ? ["\(root)/mac/\(script)"] : ["\(root)/mac/\(script)", "--port", port]
        try? p.run()
        p.waitUntilExit() // fast; the state is re-read the next time the menu is shown
    }

    // Opens the floating window (separate app, always on top of the screen).
    @objc func openFloat() {
        // Make sure the server is up (the float window loads the UI over HTTP).
        if !connected { startServerAction() }

        let fm = FileManager.default
        let bundleDir = (Bundle.main.bundlePath as NSString).deletingLastPathComponent // …/Applications
        let candidates = [
            "\(projectRoot())/mac/agent-claudy-float.app",                          // embedded (DMG) or repo (dev/curl)
            (bundleDir as NSString).appendingPathComponent("agent-claudy-float.app"), // sibling (both apps in /Applications)
            "/Applications/agent-claudy-float.app",
        ]
        if let path = candidates.first(where: { fm.fileExists(atPath: $0) }) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else {
            notifyError("Fenêtre flottante introuvable",
                        "Réinstalle agent-claudy depuis le DMG (l'app flottante y est incluse).")
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon: purely a menubar app
let controller = AppController()
app.delegate = controller
app.run()
