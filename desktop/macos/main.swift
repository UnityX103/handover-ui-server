import AppKit
import WebKit

final class HandoverApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, URLSessionTaskDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var statusLabel: NSTextField!
    private var newButton: NSButton!
    private var wakeItem: NSMenuItem!
    private var timer: Timer?
    private var configuration: HandoverConfiguration?
    private var polling = false
    private var generation = 0
    private var newCount = 0
    private var downloads: [WKDownload] = []
    private var tracker = AttentionTracker()
    private let cacheURL = (ProcessInfo.processInfo.environment["HANDOVER_APP_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Handover")).appendingPathComponent("attention.json")
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 10
        config.urlCache = nil
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    private var wakeEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "wakeOnNewRequests") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "wakeOnNewRequests") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let data = try? Data(contentsOf: cacheURL), let saved = try? JSONDecoder().decode(AttentionTracker.self, from: data) { tracker = saved }
        createMenu()
        createWindow()
        reloadConfiguration()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer!, forMode: .common)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil)
        if !CommandLine.arguments.contains("--background") { showWindow() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return false }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); session.invalidateAndCancel() }

    private func createMenu() {
        let bar = NSMenu()
        let appItem = NSMenuItem()
        let menu = NSMenu(title: "远程交接")
        menu.addItem(withTitle: "显示远程交接", action: #selector(showWindow), keyEquivalent: "0").target = self
        menu.addItem(withTitle: "设置…", action: #selector(settings), keyEquivalent: ",").target = self
        wakeItem = NSMenuItem(title: "新消息自动唤起 App", action: #selector(toggleWake), keyEquivalent: "")
        wakeItem.target = self; wakeItem.state = wakeEnabled ? .on : .off
        menu.addItem(wakeItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "隐藏远程交接", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        menu.addItem(withTitle: "退出远程交接", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = menu; bar.addItem(appItem)
        let edit = NSMenuItem(); edit.submenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        bar.addItem(edit)
        let view = NSMenuItem(); view.submenu = NSMenu(title: "窗口")
        view.submenu?.addItem(withTitle: "收件箱", action: #selector(inbox), keyEquivalent: "1").target = self
        view.submenu?.addItem(withTitle: "刷新页面", action: #selector(refresh), keyEquivalent: "r").target = self
        view.submenu?.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        bar.addItem(view); NSApp.mainMenu = bar
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "tray", accessibilityDescription: "远程交接")
        statusItem.menu = menu.copy() as? NSMenu
    }

    private func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "远程交接"; window.minSize = NSSize(width: 430, height: 480)
        window.setFrameAutosaveName("HandoverMainWindow"); window.center()
        window.isReleasedWhenClosed = false; window.delegate = self
        let root = NSView(); window.contentView = root
        let inboxButton = NSButton(title: "收件箱", target: self, action: #selector(inbox))
        let refreshButton = NSButton(title: "刷新", target: self, action: #selector(refresh))
        let settingsButton = NSButton(title: "设置", target: self, action: #selector(settings))
        statusLabel = NSTextField(labelWithString: "正在连接…"); statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        newButton = NSButton(title: "新消息", target: self, action: #selector(inbox)); newButton.isHidden = true
        let toolbar = NSStackView(views: [inboxButton, refreshButton, statusLabel, newButton, settingsButton])
        toolbar.spacing = 10; toolbar.edgeInsets = NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12)
        let webConfig = WKWebViewConfiguration()
        webConfig.websiteDataStore = ProcessInfo.processInfo.environment["HANDOVER_APP_EPHEMERAL"] == "1" ? .nonPersistent() : .default()
        webView = WKWebView(frame: .zero, configuration: webConfig)
        webView.navigationDelegate = self; webView.uiDelegate = self; webView.allowsBackForwardNavigationGestures = true
        for view in [toolbar, webView!] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: root.topAnchor), toolbar.leadingAnchor.constraint(equalTo: root.leadingAnchor), toolbar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: toolbar.bottomAnchor), webView.leadingAnchor.constraint(equalTo: root.leadingAnchor), webView.trailingAnchor.constraint(equalTo: root.trailingAnchor), webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])
    }

    @objc private func showWindow() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func inbox() {
        guard let config = configuration else { settings(); return }
        newCount = 0; updateNewButton()
        webView.load(URLRequest(url: config.endpoint("/")))
        showWindow()
    }

    @objc private func refresh() { webView.reload(); poll() }
    @objc private func woke() { poll() }
    @objc private func toggleWake() {
        wakeEnabled.toggle(); wakeItem.state = wakeEnabled ? .on : .off
        statusItem.menu?.items.first(where: { $0.action == #selector(toggleWake) })?.state = wakeItem.state
    }

    private func updateNewButton() {
        newButton.isHidden = newCount == 0
        newButton.title = "新消息 \(newCount)"
        statusItem.button?.title = newCount == 0 ? "" : " \(newCount)"
    }

    private func reloadConfiguration() {
        do {
            let next = try HandoverConfiguration.load()
            guard next != configuration else { return }
            configuration = next; generation += 1; newCount = 0; updateNewButton()
            window.title = "远程交接 · \(next.username)"
            webView.load(URLRequest(url: next.endpoint("/")))
        } catch {
            statusLabel.stringValue = "尚未配置服务器，请点击设置"
            if configuration != nil { configuration = nil; generation += 1; webView.loadHTMLString("<meta charset='utf-8'><p>配置不可用，请点击窗口上方的设置。</p>", baseURL: nil) }
        }
    }

    @objc private func settings() {
        showWindow()
        let panel = NSAlert(); panel.messageText = "远程交接设置"
        panel.informativeText = "沿用本机 Skill 配置。用户名是公开分类；在 App 内主动登录后接收同名新消息。"
        let server = NSTextField(string: configuration?.serverURL.absoluteString ?? ""); server.placeholderString = "HTTPS 服务器地址，可包含 /handover/"
        let username = NSTextField(string: configuration?.username ?? "Xpy")
        let form = NSStackView(views: [NSTextField(labelWithString: "服务器地址"), server, NSTextField(labelWithString: "用户名"), username])
        form.orientation = .vertical; form.alignment = .leading; form.spacing = 8
        form.frame = NSRect(x: 0, y: 0, width: 390, height: 116)
        server.widthAnchor.constraint(equalToConstant: 390).isActive = true; username.widthAnchor.constraint(equalTo: server.widthAnchor).isActive = true
        panel.accessoryView = form; panel.addButton(withTitle: "保存"); panel.addButton(withTitle: "取消")
        if panel.runModal() == .alertFirstButtonReturn {
            do {
                let next = try HandoverConfiguration(server: server.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), username: username.stringValue)
                try next.save(); reloadConfiguration()
            } catch { alert(error.localizedDescription) }
        }
    }

    private func alert(_ text: String) { let panel = NSAlert(); panel.messageText = text; panel.addButton(withTitle: "好"); panel.runModal() }

    private func poll() {
        reloadConfiguration()
        guard !polling, let config = configuration, let pageURL = webView.url, config.contains(pageURL) else { return }
        polling = true
        let epoch = generation
        // Read the current App browser identity; links/config never silently log in or switch it.
        webView.evaluateJavaScript("localStorage.getItem('handover:username')") { [weak self] selected, error in
            guard let self = self else { return }
            guard self.generation == epoch, error == nil, selected as? String == config.username else {
                self.polling = false
                if self.generation == epoch { self.newCount = 0; self.updateNewButton(); self.statusLabel.stringValue = "在 App 内登录 \(config.username) 后接收新消息" }
                return
            }
            var request = URLRequest(url: config.endpoint("/api/requests", user: false))
            request.setValue(config.username, forHTTPHeaderField: "X-Handover-Username")
            self.session.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.polling = false
                    guard self.generation == epoch else { return }
                    guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                          let inbox = try? JSONDecoder().decode(HandoverInbox.self, from: data) else {
                        self.statusLabel.stringValue = "连接中断，正在重试；草稿保留"; return
                    }
                    // Logout may have happened while the network request was in flight.
                    self.webView.evaluateJavaScript("localStorage.getItem('handover:username')") { [weak self] selected, error in
                        guard let self = self, self.generation == epoch, error == nil, selected as? String == config.username,
                              let url = self.webView.url, config.contains(url) else { return }
                        let records = inbox.requests.filter { $0.belongs(to: config.username) }
                        let pending = records.filter(\.waiting).count
                        self.statusLabel.stringValue = "\(config.username) · \(pending) 个待回答 · 每 5 秒检查"
                        var next = self.tracker
                        let notices = next.ingest(records, config: config)
                        do { if next != self.tracker { try privateWrite(JSONEncoder().encode(next), to: self.cacheURL); self.tracker = next } }
                        catch { self.statusLabel.stringValue = "无法保存本机提醒状态，请检查文件权限"; return }
                        guard !notices.isEmpty else { return }
                        self.newCount += notices.count; self.updateNewButton()
                        if self.wakeEnabled {
                            // Keep the current question and its draft intact; only navigate from the inbox.
                            if url.path == config.endpoint("/").path {
                                self.webView.load(URLRequest(url: config.endpoint("/grill/\(notices[0].id)/")))
                                self.newCount = max(0, self.newCount - 1); self.updateNewButton()
                            }
                            self.showWindow()
                        }
                    }
                }
            }.resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { poll() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { statusLabel.stringValue = "页面连接失败，可点击刷新重试" }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if action.shouldPerformDownload, configuration?.contains(webView.url ?? url) == true,
           ["blob", "data"].contains(url.scheme ?? "") || configuration?.contains(url) == true {
            decisionHandler(.download); return
        }
        if configuration?.contains(url) == true {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) { decisionHandler(response.canShowMIMEType ? .allow : .download) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self; downloads.append(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self; downloads.append(download) }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        completionHandler(panel.runModal() == .OK ? panel.url : nil)
    }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeAll { $0 === download } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloads.removeAll { $0 === download }; if (error as NSError).code != NSURLErrorCancelled { alert("文件下载未完成，可在原页面重试。") } }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { alert(message); completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let panel = NSAlert(); panel.messageText = message; panel.addButton(withTitle: "确定"); panel.addButton(withTitle: "取消"); completionHandler(panel.runModal() == .alertFirstButtonReturn)
    }
}

let app = NSApplication.shared
let delegate = HandoverApp()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
