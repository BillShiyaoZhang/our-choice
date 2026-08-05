import Cocoa
import CoreServices
import Darwin
import SafariServices
import Security
import UniformTypeIdentifiers
import WebKit

private enum OurChoiceAppError: LocalizedError {
    case missingResource(String)
    case invalidPort(String)
    case invalidReadyMessage
    case healthCheckFailed
    case nativeBootstrapSecretGenerationFailed

    var errorDescription: String? {
        switch self {
        case .missingResource(let path):
            return "应用包缺少运行文件：\(path)"
        case .invalidPort(let value):
            return "OUR_CHOICE_PORT 必须是 0...65535 的十进制整数，实际为“\(value)”。"
        case .invalidReadyMessage:
            return "本地服务返回了无法识别的启动信息。"
        case .healthCheckFailed:
            return "本地服务已启动，但健康检查没有通过。"
        case .nativeBootstrapSecretGenerationFailed:
            return "无法为本地服务建立安全的原生会话。"
        }
    }
}

private struct DesktopReadyMessage: Decodable {
    let host: String
    let port: Int
    let url: String
}

private final class DesktopServerOutputParser {
    private let lock = NSLock()
    private var buffer = Data()

    func consume(_ data: Data) -> [String] {
        lock.lock()
        defer { lock.unlock() }

        buffer.append(data)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if let line = String(data: lineData, encoding: .utf8) {
                lines.append(line)
            }
        }
        return lines
    }
}

@main
private enum OurChoiceApplicationMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = OurChoiceApplicationDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}

final class OurChoiceApplicationDelegate: NSObject, NSApplicationDelegate {
    private let expectedProduct = "our-choice-desktop"
    private let defaultDesktopPort = 3000
    private let lastAutomaticDesktopPort = 3031
    private let startupTimeout: TimeInterval = 20
    private let browserExtensionGuideVersion = 3
    private let browserExtensionGuideDefaultsKey = "OurChoiceBrowserExtensionGuideVersion"

    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: NSView!
    private var statusLabel: NSTextField!
    private var progressIndicator: NSProgressIndicator!
    private var retryButton: NSButton!
    private var dataDirectoryButton: NSButton!

    private var nodeProcess: Process?
    private var stoppingProcess: Process?
    private var stopCompletions: [() -> Void] = []
    private var stopForceWorkItem: DispatchWorkItem?
    private var outputPipe: Pipe?
    private var logHandle: FileHandle?
    private var readyURL: URL?
    private var startupGeneration = 0
    private var applicationIsTerminating = false
    private var terminationReplyPending = false
    private var hasCheckedInitialBrowserExtensionGuide = false
    private var browserExtensionGuideIsPresented = false

    private lazy var applicationSupportURL: URL = {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("Our Choice", isDirectory: true)
    }()

    private var safariExtensionIdentifier: String {
        Bundle.main.object(forInfoDictionaryKey: "OurChoiceSafariExtensionBundleIdentifier") as? String
            ?? "com.ourchoice.app.SafariExtension"
    }

    private func configuredDesktopPort() throws -> Int? {
        guard let value = ProcessInfo.processInfo.environment["OUR_CHOICE_PORT"] else {
            return nil
        }
        guard
            !value.isEmpty,
            value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
            let port = Int(value),
            (0...65_535).contains(port)
        else {
            throw OurChoiceAppError.invalidPort(value)
        }
        return port
    }

    private func makeNativeBootstrapSecret() throws -> String {
        var randomBytes = [UInt8](repeating: 0, count: 32)
        guard
            SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
                == errSecSuccess
        else {
            throw OurChoiceAppError.nativeBootstrapSecretGenerationFailed
        }
        return Data(randomBytes)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func installNativeBootstrapScript(secret: String) {
        let source = """
        Object.defineProperty(window, "__OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__", {
          value: "\(secret)",
          writable: false,
          configurable: false,
          enumerable: false
        });
        if (document.documentElement) {
          document.documentElement.dataset.ourChoiceNative = "true";
        } else {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.dataset.ourChoiceNative = "true";
          }, { once: true });
        }
        """
        let bootstrapScript = WKUserScript(
            source: source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        )
        let userContentController = webView.configuration.userContentController
        userContentController.removeAllUserScripts()
        userContentController.addUserScript(bootstrapScript)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        registerSafariExtensionHost()
        buildMainMenu()
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startEmbeddedServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        sender.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        applicationIsTerminating = true
        guard !terminationReplyPending else { return .terminateLater }
        terminationReplyPending = true
        stopEmbeddedServer { [weak self] in
            self?.terminationReplyPending = false
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        applicationIsTerminating = true
        stopEmbeddedServer()
    }

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1180, height: 780)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "自选"
        window.minSize = NSSize(width: 760, height: 540)
        window.center()
        window.tabbingMode = .preferred

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true

        statusView = NSView(frame: .zero)
        statusView.translatesAutoresizingMaskIntoConstraints = false

        progressIndicator = NSProgressIndicator()
        progressIndicator.style = .spinning
        progressIndicator.controlSize = .regular
        progressIndicator.translatesAutoresizingMaskIntoConstraints = false
        progressIndicator.startAnimation(nil)

        statusLabel = NSTextField(wrappingLabelWithString: "正在启动本地服务…")
        statusLabel.alignment = .center
        statusLabel.maximumNumberOfLines = 5
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        retryButton = NSButton(title: "重试", target: self, action: #selector(retryStartup(_:)))
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true
        retryButton.translatesAutoresizingMaskIntoConstraints = false

        dataDirectoryButton = NSButton(
            title: "打开数据目录",
            target: self,
            action: #selector(openDataDirectory(_:))
        )
        dataDirectoryButton.bezelStyle = .rounded
        dataDirectoryButton.isHidden = true
        dataDirectoryButton.translatesAutoresizingMaskIntoConstraints = false

        let buttonStack = NSStackView(views: [retryButton, dataDirectoryButton])
        buttonStack.orientation = .horizontal
        buttonStack.spacing = 10
        buttonStack.alignment = .centerY
        buttonStack.translatesAutoresizingMaskIntoConstraints = false

        statusView.addSubview(progressIndicator)
        statusView.addSubview(statusLabel)
        statusView.addSubview(buttonStack)

        let container = NSView(frame: frame)
        container.addSubview(webView)
        container.addSubview(statusView)
        webView.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            statusView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            statusView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            statusView.topAnchor.constraint(equalTo: container.topAnchor),
            statusView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            progressIndicator.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
            progressIndicator.centerYAnchor.constraint(
                equalTo: statusView.centerYAnchor,
                constant: -42
            ),
            statusLabel.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: progressIndicator.bottomAnchor, constant: 18),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: statusView.leadingAnchor, constant: 48),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: statusView.trailingAnchor, constant: -48),
            statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 620),
            buttonStack.centerXAnchor.constraint(equalTo: statusView.centerXAnchor),
            buttonStack.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 20),
        ])

        window.contentView = container
    }

    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(
            withTitle: "关于自选",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "浏览器扩展安装说明…",
            action: #selector(showBrowserExtensionGuide(_:)),
            keyEquivalent: ""
        ).target = self
        applicationMenu.addItem(
            withTitle: "Safari 扩展设置…",
            action: #selector(openSafariExtensionSettings(_:)),
            keyEquivalent: ","
        ).target = self
        applicationMenu.addItem(
            withTitle: "打开 Chrome 扩展目录",
            action: #selector(openChromeExtensionDirectory(_:)),
            keyEquivalent: ""
        ).target = self
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "打开数据目录",
            action: #selector(openDataDirectory(_:)),
            keyEquivalent: ""
        ).target = self
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "退出自选",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        let importItem = fileMenu.addItem(
            withTitle: "导入 JSON…",
            action: #selector(chooseImportFile(_:)),
            keyEquivalent: "o"
        )
        importItem.target = self
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(
            withTitle: "撤销",
            action: Selector(("undo:")),
            keyEquivalent: "z"
        )
        editMenu.addItem(
            withTitle: "重做",
            action: Selector(("redo:")),
            keyEquivalent: "Z"
        )
        editMenu.addItem(.separator())
        editMenu.addItem(
            withTitle: "剪切",
            action: #selector(NSText.cut(_:)),
            keyEquivalent: "x"
        )
        editMenu.addItem(
            withTitle: "复制",
            action: #selector(NSText.copy(_:)),
            keyEquivalent: "c"
        )
        editMenu.addItem(
            withTitle: "粘贴",
            action: #selector(NSText.paste(_:)),
            keyEquivalent: "v"
        )
        editMenu.addItem(.separator())
        editMenu.addItem(
            withTitle: "全选",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let reloadItem = viewMenu.addItem(
            withTitle: "重新加载",
            action: #selector(reloadWebView(_:)),
            keyEquivalent: "r"
        )
        reloadItem.target = self
        viewMenu.addItem(
            withTitle: "实际大小",
            action: #selector(resetWebViewMagnification(_:)),
            keyEquivalent: "0"
        ).target = self
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(
            withTitle: "最小化",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "缩放",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func startEmbeddedServer() {
        startupGeneration += 1
        let generation = startupGeneration
        showStartingState()

        do {
            let configuredPort = try configuredDesktopPort()
            let nativeBootstrapSecret = try makeNativeBootstrapSecret()
            try FileManager.default.createDirectory(
                at: applicationSupportURL,
                withIntermediateDirectories: true
            )
            let logsURL = applicationSupportURL.appendingPathComponent("Logs", isDirectory: true)
            try FileManager.default.createDirectory(at: logsURL, withIntermediateDirectories: true)

            guard let resourcesURL = Bundle.main.resourceURL else {
                throw OurChoiceAppError.missingResource("Contents/Resources")
            }
            let runtimeURL = resourcesURL.appendingPathComponent("runtime", isDirectory: true)
            let nodeURL = runtimeURL.appendingPathComponent("node/bin/node")
            let serverURL = runtimeURL.appendingPathComponent("server.mjs")
            let webRootURL = runtimeURL.appendingPathComponent("web", isDirectory: true)
            let vinextRootURL = runtimeURL.appendingPathComponent("vinext/dist", isDirectory: true)

            for requiredURL in [nodeURL, serverURL, webRootURL, vinextRootURL] {
                guard FileManager.default.fileExists(atPath: requiredURL.path) else {
                    throw OurChoiceAppError.missingResource(requiredURL.path)
                }
            }

            let logURL = logsURL.appendingPathComponent("desktop-server.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()

            let process = Process()
            let pipe = Pipe()
            process.executableURL = nodeURL
            process.arguments = [serverURL.path]
            process.currentDirectoryURL = runtimeURL
            process.standardOutput = pipe
            process.standardError = logHandle

            var environment: [String: String] = [
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                "TMPDIR": NSTemporaryDirectory(),
                "LANG": "en_US.UTF-8",
                "LC_ALL": "en_US.UTF-8",
                "NODE_ENV": "production",
                "OUR_CHOICE_DATA_DIR": applicationSupportURL.path,
                "OUR_CHOICE_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
                "OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET": nativeBootstrapSecret,
                "OUR_CHOICE_WEB_ROOT": webRootURL.path,
                "OUR_CHOICE_VINEXT_ROOT": vinextRootURL.path,
                "OUR_CHOICE_APP_VERSION": Bundle.main.object(
                    forInfoDictionaryKey: "CFBundleShortVersionString"
                ) as? String ?? "0.0.0",
            ]
            if let configuredPort {
                environment["OUR_CHOICE_PORT"] = String(configuredPort)
            }
            for key in ["RSSHUB_BASE_URL", "RSSHUB_ACCESS_KEY"] {
                if let value = ProcessInfo.processInfo.environment[key] {
                    environment[key] = value
                }
            }
            installNativeBootstrapScript(secret: nativeBootstrapSecret)
            process.environment = environment

            let outputParser = DesktopServerOutputParser()
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else {
                    handle.readabilityHandler = nil
                    return
                }
                let lines = outputParser.consume(data)
                guard !lines.isEmpty else { return }
                DispatchQueue.main.async { [weak self] in
                    self?.consumeServerOutput(
                        lines,
                        generation: generation,
                        requestedPort: configuredPort
                    )
                }
            }
            process.terminationHandler = { [weak self] terminated in
                DispatchQueue.main.async {
                    self?.serverDidTerminate(terminated, generation: generation)
                }
            }

            nodeProcess = process
            outputPipe = pipe
            try process.run()

            DispatchQueue.main.asyncAfter(deadline: .now() + startupTimeout) { [weak self] in
                guard let self, self.startupGeneration == generation, self.readyURL == nil else {
                    return
                }
                self.failStartup(
                    OurChoiceAppError.healthCheckFailed,
                    detail: configuredPort == nil
                        ? "自动端口 3000...3031 均不可用，请关闭冲突服务后重试。"
                        : configuredPort == 0
                            ? "系统未能分配临时本地端口，请重试并查看日志。"
                            : "请确认 \(configuredPort!) 端口未被其他程序占用，然后重试。"
                )
            }
        } catch {
            failStartup(error)
        }
    }

    private func consumeServerOutput(
        _ lines: [String],
        generation: Int,
        requestedPort: Int?
    ) {
        guard startupGeneration == generation else { return }
        for line in lines {
            appendToLog(line + "\n")
            guard line.hasPrefix("OUR_CHOICE_READY ") else { continue }
            let payload = String(line.dropFirst("OUR_CHOICE_READY ".count))
            guard
                let payloadData = payload.data(using: .utf8),
                let ready = try? JSONDecoder().decode(DesktopReadyMessage.self, from: payloadData),
                ready.host == "127.0.0.1",
                ready.port > 0,
                ready.port <= 65_535,
                requestedPort == nil
                    ? (defaultDesktopPort...lastAutomaticDesktopPort).contains(ready.port)
                    : requestedPort == 0 || ready.port == requestedPort,
                let url = URL(string: ready.url),
                url.scheme?.lowercased() == "http",
                url.user == nil,
                url.password == nil,
                url.host == "127.0.0.1",
                url.port == ready.port,
                url.query == nil,
                url.fragment == nil,
                url.path.isEmpty || url.path == "/"
            else {
                failStartup(OurChoiceAppError.invalidReadyMessage)
                continue
            }
            checkHealth(at: url, generation: generation, attempt: 0)
        }
    }

    private func checkHealth(at baseURL: URL, generation: Int, attempt: Int) {
        guard startupGeneration == generation else { return }
        let healthURL = baseURL.appendingPathComponent("__our_choice/desktop/health")
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let product = data.flatMap {
                (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
            }?["product"] as? String
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200
                && product == self.expectedProduct

            DispatchQueue.main.async {
                guard self.startupGeneration == generation else { return }
                if healthy {
                    self.loadApplication(at: baseURL)
                } else if attempt < 30, self.nodeProcess?.isRunning == true {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        self.checkHealth(at: baseURL, generation: generation, attempt: attempt + 1)
                    }
                } else {
                    self.failStartup(OurChoiceAppError.healthCheckFailed)
                }
            }
        }.resume()
    }

    private func loadApplication(at url: URL) {
        readyURL = url
        statusLabel.stringValue = "正在加载自选…"
        webView.load(URLRequest(url: url))
    }

    private func serverDidTerminate(_ process: Process, generation: Int) {
        guard !applicationIsTerminating, startupGeneration == generation else { return }
        let detail = "本地服务已退出（状态码 \(process.terminationStatus)）。日志位于 \(applicationSupportURL.path)/Logs。"
        failStartup(OurChoiceAppError.healthCheckFailed, detail: detail)
    }

    private func stopEmbeddedServer(completion: (() -> Void)? = nil) {
        if let completion {
            stopCompletions.append(completion)
        }
        guard stoppingProcess == nil else { return }

        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        let process = nodeProcess
        nodeProcess = nil
        try? logHandle?.close()
        logHandle = nil

        guard let process else {
            DispatchQueue.main.async { [weak self] in
                self?.runStopCompletions()
            }
            return
        }
        stoppingProcess = process
        process.terminationHandler = { [weak self] terminatedProcess in
            DispatchQueue.main.async {
                self?.finishStoppingEmbeddedServer(terminatedProcess)
            }
        }
        if process.isRunning {
            process.terminate()
            let forceWorkItem = DispatchWorkItem { [weak self, weak process] in
                guard
                    let self,
                    let process,
                    self.stoppingProcess === process,
                    process.isRunning
                else {
                    return
                }
                Darwin.kill(process.processIdentifier, SIGKILL)
            }
            stopForceWorkItem = forceWorkItem
            DispatchQueue.main.asyncAfter(
                deadline: .now() + 3,
                execute: forceWorkItem
            )
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.finishStoppingEmbeddedServer(process)
            }
        }
    }

    private func finishStoppingEmbeddedServer(_ process: Process) {
        guard stoppingProcess === process else { return }
        stopForceWorkItem?.cancel()
        stopForceWorkItem = nil
        process.terminationHandler = nil
        stoppingProcess = nil
        runStopCompletions()
    }

    private func runStopCompletions() {
        guard !stopCompletions.isEmpty else { return }
        let completions = stopCompletions
        stopCompletions.removeAll(keepingCapacity: true)
        for completion in completions {
            completion()
        }
    }

    private func appendToLog(_ string: String) {
        guard let data = string.data(using: .utf8) else { return }
        try? logHandle?.write(contentsOf: data)
    }

    private func showStartingState() {
        readyURL = nil
        webView.isHidden = true
        statusView.isHidden = false
        progressIndicator.isHidden = false
        progressIndicator.startAnimation(nil)
        retryButton.isHidden = true
        dataDirectoryButton.isHidden = true
        statusLabel.textColor = .labelColor
        statusLabel.stringValue = "正在启动本地服务…"
    }

    private func failStartup(_ error: Error, detail: String? = nil) {
        readyURL = nil
        webView.isHidden = true
        statusView.isHidden = false
        progressIndicator.stopAnimation(nil)
        progressIndicator.isHidden = true
        retryButton.isHidden = false
        dataDirectoryButton.isHidden = false
        statusLabel.textColor = .systemRed
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        statusLabel.stringValue = [message, detail].compactMap { $0 }.joined(separator: "\n\n")
    }

    @objc private func retryStartup(_ sender: Any?) {
        startupGeneration += 1
        showStartingState()
        statusLabel.stringValue = "正在重新启动本地服务…"
        stopEmbeddedServer { [weak self] in
            guard let self, !self.applicationIsTerminating else { return }
            self.startEmbeddedServer()
        }
    }

    @objc private func reloadWebView(_ sender: Any?) {
        if webView.url != nil {
            webView.reload()
        } else if let readyURL {
            webView.load(URLRequest(url: readyURL))
        } else {
            retryStartup(sender)
        }
    }

    @objc private func resetWebViewMagnification(_ sender: Any?) {
        webView.magnification = 1
    }

    @objc private func openDataDirectory(_ sender: Any?) {
        try? FileManager.default.createDirectory(
            at: applicationSupportURL,
            withIntermediateDirectories: true
        )
        NSWorkspace.shared.activateFileViewerSelecting([applicationSupportURL])
    }

    @discardableResult
    private func registerSafariExtensionHost() -> Bool {
        LSRegisterURL(Bundle.main.bundleURL as CFURL, true) == noErr
    }

    @objc private func openSafariExtensionSettings(_ sender: Any?) {
        let registered = registerSafariExtensionHost()
        waitForSafariExtensionRegistration(attempt: 0, registrationSucceeded: registered)
    }

    private func waitForSafariExtensionRegistration(
        attempt: Int,
        registrationSucceeded: Bool
    ) {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: safariExtensionIdentifier
        ) { [weak self] state, error in
            guard let self else { return }
            if state != nil {
                SFSafariApplication.showPreferencesForExtension(
                    withIdentifier: self.safariExtensionIdentifier
                ) { [weak self] preferenceError in
                    guard let preferenceError else { return }
                    DispatchQueue.main.async {
                        self?.presentSafariExtensionError(
                            preferenceError,
                            registrationSucceeded: registrationSucceeded
                        )
                    }
                }
                return
            }
            if attempt < 8 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    self?.waitForSafariExtensionRegistration(
                        attempt: attempt + 1,
                        registrationSucceeded: registrationSucceeded
                    )
                }
                return
            }
            DispatchQueue.main.async {
                self.presentSafariExtensionError(
                    error,
                    registrationSucceeded: registrationSucceeded
                )
            }
        }
    }

    private func presentSafariExtensionError(
        _ error: Error?,
        registrationSucceeded: Bool
    ) {
        let detail = error?.localizedDescription ?? "系统尚未发现内嵌的 Safari 扩展。"
        let registration = registrationSucceeded
            ? "宿主 App 已重新注册，但 Safari 仍未索引该扩展。"
            : "LaunchServices 无法重新注册宿主 App。请把自选安装到 /Applications 后重新启动。"
        presentAlert(
            title: "Safari 尚未发现自选助手",
            message: """
            \(detail)

            \(registration)

            本机 unsigned 测试包：先打开 Safari → 设置 → 高级，启用“显示开发者功能”；再从菜单栏“开发”选择“允许未签名扩展”，然后回到 Safari → 设置 → 扩展。退出 Safari 后需要重新允许。
            """
        )
    }

    @objc private func openChromeExtensionDirectory(_ sender: Any?) {
        guard let resourcesURL = Bundle.main.resourceURL else {
            presentAlert(
                title: "无法打开 Chrome 扩展目录",
                message: "应用包缺少 Contents/Resources。请重新安装自选。"
            )
            return
        }

        let extensionURL = resourcesURL.appendingPathComponent(
            "browser-extension/chrome",
            isDirectory: true
        )
        var isDirectory: ObjCBool = false
        guard
            FileManager.default.fileExists(
                atPath: extensionURL.path,
                isDirectory: &isDirectory
            ),
            isDirectory.boolValue
        else {
            presentAlert(
                title: "无法打开 Chrome 扩展目录",
                message: "应用包内缺少浏览器扩展资源。请重新安装自选。"
            )
            return
        }
        guard NSWorkspace.shared.open(extensionURL) else {
            presentAlert(
                title: "无法打开 Chrome 扩展目录",
                message: "Finder 无法打开应用内的扩展目录，请重新启动 Finder 后重试。"
            )
            return
        }
    }

    @objc private func showBrowserExtensionGuide(_ sender: Any?) {
        presentBrowserExtensionGuide()
    }

    private func presentInitialBrowserExtensionGuideIfNeeded() {
        guard !applicationIsTerminating else { return }
        guard !hasCheckedInitialBrowserExtensionGuide else { return }
        hasCheckedInitialBrowserExtensionGuide = true
        guard
            UserDefaults.standard.integer(forKey: browserExtensionGuideDefaultsKey)
                < browserExtensionGuideVersion
        else {
            return
        }
        presentBrowserExtensionGuide()
    }

    private func presentBrowserExtensionGuide() {
        guard !browserExtensionGuideIsPresented else { return }
        browserExtensionGuideIsPresented = true

        let alert = NSAlert()
        alert.window.preventsApplicationTerminationWhenModal = false
        alert.messageText = "启用浏览器扩展"
        alert.informativeText = """
        Safari：扩展已经随“自选”安装。请在 Safari → 设置 → 扩展中启用“自选助手”，并为需要使用的网站授权。若当前使用的是本机 unsigned 测试包，请先在 Safari → 设置 → 高级中启用“显示开发者功能”，再从菜单栏“开发”中选择“允许未签名扩展”。每次退出 Safari 后该允许状态会重置，需要重新操作。

        Chrome / Edge：当前默认使用手动安装。请打开扩展管理页面、启用开发者模式，选择“加载已解压的扩展程序”，再选择自选内置的 Chrome 扩展目录。

        浏览器会要求你确认启用和网站访问权限；自选不会绕过这些授权。
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "打开 Safari 扩展设置")
        alert.addButton(withTitle: "打开 Chrome 扩展目录")
        alert.addButton(withTitle: "完成")

        let handleResponse: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            self.browserExtensionGuideIsPresented = false
            UserDefaults.standard.set(
                self.browserExtensionGuideVersion,
                forKey: self.browserExtensionGuideDefaultsKey
            )
            switch response {
            case .alertFirstButtonReturn:
                self.openSafariExtensionSettings(nil)
            case .alertSecondButtonReturn:
                self.openChromeExtensionDirectory(nil)
            default:
                break
            }
        }

        if let window {
            alert.beginSheetModal(for: window, completionHandler: handleResponse)
        } else {
            handleResponse(alert.runModal())
        }
    }

    @objc private func chooseImportFile(_ sender: Any?) {
        let script = "document.querySelector('input[type=file][accept*=json]')?.click()"
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error {
                self?.presentAlert(
                    title: "无法打开导入面板",
                    message: "请等待自选完成加载后重试。\n\n\(error.localizedDescription)"
                )
            }
        }
    }

    private func isApplicationURL(_ url: URL) -> Bool {
        guard
            let applicationPort = readyURL?.port,
            url.scheme?.lowercased() == "http",
            url.user == nil,
            url.password == nil,
            url.host?.lowercased() == "127.0.0.1"
        else {
            return false
        }
        return url.port == applicationPort
    }

    private func isApplicationDownloadURL(_ url: URL) -> Bool {
        if isApplicationURL(url) { return true }
        guard
            url.scheme?.lowercased() == "blob",
            url.absoluteString.hasPrefix("blob:"),
            let sourceURL = URL(string: String(url.absoluteString.dropFirst("blob:".count)))
        else {
            return false
        }
        return isApplicationURL(sourceURL)
    }

    private func isApplicationMainPage(_ webView: WKWebView) -> Bool {
        guard let url = webView.url else { return false }
        return isApplicationURL(url)
    }

    private func isAllowedExternalSubframeURL(_ url: URL) -> Bool {
        guard
            ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
            url.user == nil,
            url.password == nil,
            let host = url.host,
            !host.isEmpty
        else {
            return false
        }
        return true
    }

    private func openExternally(_ url: URL) {
        guard isAllowedExternalSubframeURL(url) else { return }
        NSWorkspace.shared.open(url)
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        if let window {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }
}

extension OurChoiceApplicationDelegate: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            if isApplicationDownloadURL(url) {
                decisionHandler(.download)
            } else {
                decisionHandler(.cancel)
            }
            return
        }
        if navigationAction.targetFrame == nil {
            if isApplicationURL(url) {
                webView.load(navigationAction.request)
            } else {
                openExternally(url)
            }
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == true {
            guard isApplicationURL(url) else {
                openExternally(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == false {
            guard
                isApplicationMainPage(webView),
                isAllowedExternalSubframeURL(url)
            else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard let url = navigationResponse.response.url else {
            decisionHandler(.cancel)
            return
        }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if disposition.contains("attachment") || !navigationResponse.canShowMIMEType {
            decisionHandler(isApplicationDownloadURL(url) ? .download : .cancel)
            return
        }
        if !navigationResponse.isForMainFrame {
            guard
                isApplicationMainPage(webView),
                isAllowedExternalSubframeURL(url)
            else {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if isApplicationURL(url) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isApplicationURL(webView.url ?? URL(string: "about:blank")!) else { return }
        progressIndicator.stopAnimation(nil)
        progressIndicator.isHidden = true
        statusLabel.stringValue = ""
        webView.isHidden = false
        statusView.isHidden = true
        webView.window?.makeFirstResponder(webView)
        DispatchQueue.main.async { [weak self] in
            self?.presentInitialBrowserExtensionGuideIfNeeded()
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        failStartup(error, detail: "本地服务仍在运行；可以重试加载或查看日志。")
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }
}

extension OurChoiceApplicationDelegate: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isApplicationURL(url) {
                webView.load(navigationAction.request)
            } else {
                openExternally(url)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        if !parameters.allowsDirectories {
            panel.allowedContentTypes = [.json]
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

extension OurChoiceApplicationDelegate: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.url : nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        presentAlert(title: "下载失败", message: error.localizedDescription)
    }
}
