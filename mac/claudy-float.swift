// agent-claudy — fenêtre flottante macOS (vignette toujours au-dessus).
//
// Petite fenêtre sans icône dans le Dock, niveau "floating" (reste au-dessus des
// autres fenêtres et sur tous les bureaux / au-dessus du plein écran). Elle affiche
// directement l'UI du serveur (vraies têtes pixel-art) via WKWebView, donc tout
// fonctionne comme dans le navigateur (auto-découverte, bulles, alerte rouge).
//
// - DÉPLACEMENT : la WKWebView capte les clics, donc on ajoute une petite BARRE DE
//   PRÉHENSION en haut (DragStrip, mouseDownCanMoveWindow) pour attraper la fenêtre.
// - RACCOURCI GLOBAL : ⌃⌥C affiche/masque la fenêtre même si rien n'est visible
//   (utile quand l'icône de la barre de menus est cachée derrière l'encoche).
//
// Build :  mac/build-float.sh   →   mac/agent-claudy-float.app

import Cocoa
import WebKit
import Carbon.HIToolbox

let port = ProcessInfo.processInfo.environment["CLAUDY_PORT"] ?? "4310"
let urlString = "http://127.0.0.1:\(port)"

// Bande de 28 px en haut servant uniquement à DÉPLACER la fenêtre (la WKWebView en
// dessous garde tous les clics). mouseDownCanMoveWindow = true → glisser la déplace.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.114, green: 0.094, blue: 0.071, alpha: 1).setFill()
        dirtyRect.fill()
    }
}

// Référence globale pour que le callback C du hotkey (sans capture) atteigne l'app.
var floatController: AppController?

final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        floatController = self

        let rect = NSRect(x: 0, y: 0, width: 280, height: 360)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "agent-claudy"
        window.titlebarAppearsTransparent = true // barre de titre fondue → look vignette
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.level = .floating // toujours au-dessus des fenêtres normales
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.backgroundColor = NSColor(calibratedRed: 0.078, green: 0.067, blue: 0.051, alpha: 1)
        window.delegate = self
        window.setFrameAutosaveName("ClaudyFloat") // mémorise position/taille

        let content = window.contentView!

        // Barre de préhension en haut (sous les pastilles fermer/zoomer) + WKWebView dessous.
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(strip)

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(web)

        NSLayoutConstraint.activate([
            strip.topAnchor.constraint(equalTo: content.topAnchor),
            strip.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            strip.heightAnchor.constraint(equalToConstant: 28),
            web.topAnchor.constraint(equalTo: strip.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])

        if let u = URL(string: urlString) {
            web.load(URLRequest(url: u))
        }

        if window.frame.origin == .zero { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        installGlobalHotKey()
    }

    // Affiche / masque la fenêtre (sans quitter l'app). Appelé par le raccourci global.
    @objc func toggle() {
        if window.isVisible && window.isKeyWindow {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // Fermer la fenêtre (pastille rouge) = quitter l'app.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return true
    }
}

// ── Raccourci global ⌃⌥C ───────────────────────────────────────────────────────
// Le handler est un pointeur de fonction C : il ne capture rien et passe par la
// référence globale `floatController`.
private let hotKeyHandler: EventHandlerUPP = { (_, _, _) -> OSStatus in
    DispatchQueue.main.async { floatController?.toggle() }
    return noErr
}

func installGlobalHotKey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), hotKeyHandler, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x434C4459), id: 1) // 'CLDY'
    var ref: EventHotKeyRef?
    // ⌃⌥C : Control + Option + C.
    RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // pas d'icône dans le Dock
let controller = AppController()
app.delegate = controller
app.run()
