import AppKit

/// What the host is actually doing. A live process alone can be a host
/// sleeping in crash backoff or stopped by a startup gate, serving nothing.
enum Health: Equatable {
    case stopped
    case starting
    case running
    case crashLoop
    case blocked(String)

    var processAlive: Bool { self != .stopped }

    var needsAttention: Bool {
        switch self {
        case .crashLoop, .blocked: return true
        default: return false
        }
    }

    var label: String {
        switch self {
        case .stopped: return "NanoClaw is stopped"
        case .starting: return "NanoClaw is starting…"
        case .running: return "NanoClaw is running"
        case .crashLoop: return "NanoClaw keeps crashing — retrying"
        case .blocked(let reason): return "NanoClaw stopped by the \(reason)"
        }
    }

    var color: NSColor {
        switch self {
        case .running: return .systemGreen
        case .stopped: return .systemRed
        default: return .systemOrange
        }
    }
}

class StatusBarController: NSObject {
    private var statusItem: NSStatusItem!
    private var health = Health.stopped
    private var timer: Timer?

    private let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/com.nanoclaw-v2-43655158.plist"

    /// Derive the NanoClaw project root from the binary location.
    /// The binary is compiled to {project}/dist/statusbar, so the parent of
    /// the parent directory is the project root.
    private static let projectRoot: String = {
        let binary = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return binary.deletingLastPathComponent().deletingLastPathComponent().path
    }()

    override init() {
        super.init()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        health = checkHealth()
        updateMenu()
        // Poll every 5 seconds to reflect external state changes
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let current = self.checkHealth()
            if current != self.health {
                self.health = current
                self.updateMenu()
            }
        }
    }

    /// The bolt itself carries a warning badge when the host needs attention,
    /// so a stop is visible without opening the menu.
    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let symbol = health.needsAttention ? "bolt.trianglebadge.exclamationmark.fill" : "bolt.fill"
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: health.label) {
            image.isTemplate = true
            button.image = image
            button.title = ""
        } else {
            button.image = nil
            button.title = health.needsAttention ? "⚠️" : "⚡"
        }
        button.toolTip = health.label
    }

    /// Combines launchd's view (is there a process?) with what the host
    /// writes about itself: data/host-status.json (blocked / starting /
    /// running, with its pid) and data/circuit-breaker.json (consecutive
    /// start attempts).
    private func checkHealth() -> Health {
        guard let pid = launchdPid() else { return .stopped }
        let status = readJSON("data/host-status.json")
        let state = status?["state"] as? String
        if state == "blocked" {
            return .blocked(status?["reason"] as? String ?? "startup check")
        }
        if state == "running", status?["pid"] as? Int == pid { return .running }
        // Attempt 3 is the breaker's first delayed restart.
        if let attempt = readJSON("data/circuit-breaker.json")?["attempt"] as? Int, attempt >= 3 {
            return .crashLoop
        }
        return .starting
    }

    private func readJSON(_ relativePath: String) -> [String: Any]? {
        let url = URL(fileURLWithPath: StatusBarController.projectRoot).appendingPathComponent(relativePath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func launchdPid() -> Int? {
        let task = Process()
        task.launchPath = "/bin/launchctl"
        task.arguments = ["list", "com.nanoclaw-v2-43655158"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        guard (try? task.run()) != nil else { return nil }
        task.waitUntilExit()
        if task.terminationStatus != 0 { return nil }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        // launchctl list output: "PID\tExitCode\tLabel" — "-" means not running
        let pid = output.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\t").first ?? "-"
        return Int(pid)
    }

    private func updateMenu() {
        updateIcon()
        let menu = NSMenu()

        // Status row with colored dot
        let statusItem = NSMenuItem()
        let dot = "● "
        let attr = NSMutableAttributedString(string: dot, attributes: [.foregroundColor: health.color])
        attr.append(NSAttributedString(string: health.label, attributes: [.foregroundColor: NSColor.labelColor]))
        statusItem.attributedTitle = attr
        statusItem.isEnabled = false
        menu.addItem(statusItem)

        menu.addItem(NSMenuItem.separator())

        if health.processAlive {
            let stop = NSMenuItem(title: "Stop", action: #selector(stopService), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)

            let restart = NSMenuItem(title: "Restart", action: #selector(restartService), keyEquivalent: "r")
            restart.target = self
            menu.addItem(restart)
        } else {
            let start = NSMenuItem(title: "Start", action: #selector(startService), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }

        menu.addItem(NSMenuItem.separator())

        let logs = NSMenuItem(title: "View Logs", action: #selector(viewLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        self.statusItem.menu = menu
    }

    @objc private func startService() {
        run("/bin/launchctl", ["load", plistPath])
        refresh(after: 2)
    }

    @objc private func stopService() {
        run("/bin/launchctl", ["unload", plistPath])
        refresh(after: 2)
    }

    @objc private func restartService() {
        let uid = getuid()
        run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/com.nanoclaw-v2-43655158"])
        refresh(after: 3)
    }

    @objc private func viewLogs() {
        let logPath = "\(StatusBarController.projectRoot)/logs/nanoclaw.log"
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    private func refresh(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self else { return }
            self.health = self.checkHealth()
            self.updateMenu()
        }
    }

    @discardableResult
    private func run(_ path: String, _ args: [String]) -> Int32 {
        let task = Process()
        task.launchPath = path
        task.arguments = args
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        try? task.run()
        task.waitUntilExit()
        return task.terminationStatus
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = StatusBarController()
app.run()
