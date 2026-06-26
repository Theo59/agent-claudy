// agent-claudy — macOS floating window (thumbnail always on top).
//
// Small window with no Dock icon, at the "floating" level (stays above other
// windows and across all desktops / above full-screen apps). It displays the
// server UI directly (real pixel-art heads) through a WKWebView, so everything
// works just like in the browser (auto-discovery, speech bubbles, red alert).
//
// - DRAGGING: the WKWebView swallows clicks, so we add a small GRAB STRIP at the
//   top (DragStrip, mouseDownCanMoveWindow) to grab the window.
// - GLOBAL SHORTCUT: ⌃⌥C shows/hides the window even when nothing is visible
//   (handy when the menu bar icon is hidden behind the notch).
//
// Build:  mac/build-float.sh   →   mac/agent-claudy-float.app

import Cocoa
import WebKit
import Carbon.HIToolbox

let port = ProcessInfo.processInfo.environment["CLAUDY_PORT"] ?? "4310"
let urlString = "http://127.0.0.1:\(port)"

// A 28 px strip at the top used solely to MOVE the window (the WKWebView below keeps
// all clicks). mouseDownCanMoveWindow = true → dragging it moves the window.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.114, green: 0.094, blue: 0.071, alpha: 1).setFill()
        dirtyRect.fill()
    }
}

// Global reference so the hotkey's C callback (which captures nothing) can reach the app.
var floatController: AppController?

final class AppController: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
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
        window.titlebarAppearsTransparent = true // blended title bar → thumbnail look
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.level = .floating // always above normal windows
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.backgroundColor = NSColor(calibratedRed: 0.078, green: 0.067, blue: 0.051, alpha: 1)
        window.delegate = self
        window.setFrameAutosaveName("ClaudyFloat") // remembers position/size

        let content = window.contentView!

        // Grab strip at the top (below the close/zoom buttons) + WKWebView underneath.
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(strip)

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self // retry if the server isn't up yet
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

    // Shows / hides the window (without quitting the app). Called by the global shortcut.
    @objc func toggle() {
        if window.isVisible && window.isKeyWindow {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // Closing the window (red button) = quit the app.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return true
    }

    // The server may still be starting (launched by the menubar just before us):
    // retry the load on failure instead of showing a dead "can't connect" page.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryLoad()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retryLoad()
    }
    private func retryLoad() {
        guard let u = URL(string: urlString) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.web.load(URLRequest(url: u))
        }
    }
}

// ── Global shortcut ⌃⌥C ────────────────────────────────────────────────────────
// The handler is a C function pointer: it captures nothing and goes through the
// global `floatController` reference.
private let hotKeyHandler: EventHandlerUPP = { (_, _, _) -> OSStatus in
    DispatchQueue.main.async { floatController?.toggle() }
    return noErr
}

func installGlobalHotKey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), hotKeyHandler, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x434C4459), id: 1) // 'CLDY'
    var ref: EventHotKeyRef?
    // ⌃⌥C: Control + Option + C.
    RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon
let controller = AppController()
app.delegate = controller
app.run()
