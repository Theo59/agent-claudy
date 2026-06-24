// agent-claudy — app menubar macOS (un seul fichier, compilé via swiftc).
//
// Affiche dans la barre de menus un badge live de l'état des agents (rouge dès
// qu'un agent réclame), et un menu pour ouvrir le panneau / piloter la démo.
// Ne fait que LIRE le serveur local (http://127.0.0.1:PORT) ; tout l'état vient
// de lui (auto-découverte + hook). Aucune dépendance externe.
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

// Racine du projet déduite de l'emplacement du .app (…/mac/agent-claudy.app → projet).
func projectRoot() -> String {
    let bundle = Bundle.main.bundlePath as NSString
    return (bundle.deletingLastPathComponent as NSString).deletingLastPathComponent
}

// node n'est pas dans le PATH minimal d'une app lancée par Finder/launchd : on le cherche.
// Renvoie nil si aucun node exécutable n'est trouvé (on prévient alors l'utilisateur
// au lieu de retomber sur un « /usr/bin/env node » qui échouerait silencieusement).
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
    var prevStates: [String: String] = [:] // état précédent par agent (détection de bascule)
    var seeded = false // 1er scan : on enregistre sans notifier (pas d'alerte pour l'existant)

    func applicationDidFinishLaunching(_ note: Notification) {
        menu.delegate = self
        statusItem.menu = menu
        // Icône compacte (lunettes de Claudy) en image template → s'adapte au thème
        // et reste étroite (occupe la place d'une seule icône système).
        if let button = statusItem.button {
            let img = NSImage(systemSymbolName: "eyeglasses", accessibilityDescription: "agent-claudy")
            img?.isTemplate = true
            button.image = img
            button.imagePosition = .imageLeft
        }
        // Notifications natives : c'est CETTE app (vrai bundle + icône) qui les émet, pour
        // pouvoir router le clic vers la session et afficher le logo de Claudy.
        let nc = UNUserNotificationCenter.current()
        nc.delegate = self
        nc.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // ── Lecture du serveur ────────────────────────────────────────────────
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
                if ok { self.notifyTransitions(list) } // alerte sur passage → needs_input
                self.agents = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                self.renderBadge()
            }
        }.resume()
    }

    // Détecte les bascules vers `needs_input` et poste une notification native (une fois).
    func notifyTransitions(_ list: [Agent]) {
        for a in list where a.state == "needs_input" {
            if seeded && prevStates[a.id] != "needs_input" { maybeNotify(a) }
        }
        prevStates = Dictionary(list.map { ($0.id, $0.state) }, uniquingKeysWith: { a, _ in a })
        seeded = true
    }

    // Poste la notif si les réglages serveur l'autorisent (notify + notifySound).
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
            // identifiant stable par agent → pas d'empilement de doublons pour la même tête.
            let req = UNNotificationRequest(identifier: "claudy-\(a.id)", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }.resume()
    }

    // ── Notifications : présentation + clic ───────────────────────────────────
    // Afficher même quand l'app est au premier plan.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    // Clic sur la notif → ramène la fenêtre de la bonne session au premier plan.
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

    // ── Badge dans la barre de menus ──────────────────────────────────────
    // Icône (image) fixe + un petit chiffre uniquement quand un agent réclame :
    // on garde le badge le plus étroit possible (barre de menus souvent saturée).
    func renderBadge() {
        guard let button = statusItem.button else { return }
        button.alphaValue = connected ? 1.0 : 0.45 // grisé si serveur injoignable
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

    // ── Menu reconstruit juste avant affichage (données fraîches, zéro churn) ──
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let header = NSMenuItem(
            title: connected ? "agent-claudy" : "agent-claudy — serveur injoignable",
            action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if !connected {
            addAction(menu, "Démarrer le serveur", #selector(startServerAction), key: "")
        } else if agents.isEmpty {
            let empty = NSMenuItem(title: "Aucun agent actif", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for a in agents {
                // Cliquer une ligne ramène la fenêtre de l'agent au premier plan.
                let item = NSMenuItem(title: "\(glyph(a.state))  \(a.name) — \(label(a.state))", action: #selector(focusAgent(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = a.id
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        addAction(menu, "Ouvrir le panneau", #selector(openPanel), key: "o")
        addAction(menu, "Fenêtre flottante", #selector(openFloat), key: "f")
        addAction(menu, "Réglages…", #selector(openSettings), key: ",")
        menu.addItem(.separator())
        // Démarrage au login (launchd) : la coche reflète la présence du LaunchAgent.
        let login = NSMenuItem(title: "Démarrer au login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = FileManager.default.fileExists(atPath: loginPlist) ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        // target nil → l'action remonte au NSApp (qui sait répondre à terminate:).
        menu.addItem(NSMenuItem(title: "Quitter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    func addAction(_ menu: NSMenu, _ title: String, _ sel: Selector, key: String) {
        let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    // ── Actions ───────────────────────────────────────────────────────────
    @objc func openPanel() {
        if let u = URL(string: baseURL) { NSWorkspace.shared.open(u) }
    }
    // Clic sur une ligne d'agent → demande au serveur d'activer sa fenêtre.
    @objc func focusAgent(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let url = URL(string: "\(baseURL)/api/focus/\(id)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }
    // Démarre le serveur Node si injoignable (l'app devient un vrai launcher).
    // Affiche une alerte (app menubar → on active l'app pour que la fenêtre passe devant).
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
            refresh() // serveur déjà joignable → on ne lance pas un 2e process sur le même port
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
            try p.run() // détaché : on n'attend pas
        } catch {
            notifyError("Démarrage du serveur impossible", error.localizedDescription)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in self?.refresh() }
    }

    // Ouvre le panneau directement sur les réglages (#settings déplie le panneau ⚙).
    @objc func openSettings() {
        if let u = URL(string: "\(baseURL)/#settings") { NSWorkspace.shared.open(u) }
    }

    // Active/désactive le démarrage au login (scripts launchd du dossier mac/).
    @objc func toggleLogin() {
        let root = projectRoot()
        let installed = FileManager.default.fileExists(atPath: loginPlist)
        let script = installed ? "uninstall-login.sh" : "install-login.sh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = installed ? ["\(root)/mac/\(script)"] : ["\(root)/mac/\(script)", "--port", port]
        try? p.run()
        p.waitUntilExit() // rapide ; l'état est relu au prochain affichage du menu
    }

    // Ouvre la fenêtre flottante (app séparée, toujours au-dessus de l'écran).
    @objc func openFloat() {
        let appPath = "\(projectRoot())/mac/agent-claudy-float.app"
        NSWorkspace.shared.open(URL(fileURLWithPath: appPath))
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // pas d'icône dans le Dock : app purement menubar
let controller = AppController()
app.delegate = controller
app.run()
