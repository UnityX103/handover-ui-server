import Foundation

struct HandoverConfiguration: Equatable {
    let serverURL: URL
    let username: String

    static var fileURL: URL {
        if let override = ProcessInfo.processInfo.environment["HANDOVER_CONFIG"], !override.isEmpty {
            return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/handover-ui/config.json")
    }

    init(server: String, username: String) throws {
        guard username.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
            throw HandoverError.message("用户名应为 1–64 个英文字母、数字、下划线或短横线。")
        }
        guard let parts = URLComponents(string: server), let host = parts.host,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
              parts.percentEncodedPath.range(of: "^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*$", options: .regularExpression) != nil || parts.percentEncodedPath.isEmpty,
              let url = parts.url else {
            throw HandoverError.message("服务器需为 HTTPS 地址，可保留 /handover/ 部署路径；HTTP 仅允许本机回环地址。")
        }
        self.serverURL = url
        self.username = username
    }

    static func load() throws -> HandoverConfiguration {
        let saved = (try? Data(contentsOf: fileURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let env = ProcessInfo.processInfo.environment
        guard let server = env["HANDOVER_SERVER_URL"] ?? saved["serverUrl"] as? String, !server.isEmpty else {
            throw HandoverError.message("请先设置远程交接服务器地址。")
        }
        return try HandoverConfiguration(server: server, username: env["HANDOVER_USERNAME"] ?? saved["username"] as? String ?? "Xpy")
    }

    func save() throws {
        let url = Self.fileURL
        var saved: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: url.path) {
            saved = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
        }
        saved["serverUrl"] = serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        saved["username"] = username
        try privateWrite(JSONSerialization.data(withJSONObject: saved, options: [.prettyPrinted, .sortedKeys]), to: url)
    }

    var basePath: String { serverURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    var scope: String { endpoint("/").absoluteString }

    func endpoint(_ route: String, user: Bool = true) -> URL {
        var parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        parts.path = (basePath.isEmpty ? "" : "/" + basePath) + route
        parts.queryItems = user ? [URLQueryItem(name: "username", value: username)] : nil
        return parts.url!
    }

    func contains(_ url: URL) -> Bool {
        let mount = basePath.isEmpty ? "/" : "/" + basePath + "/"
        return url.scheme == serverURL.scheme && url.host == serverURL.host && url.port == serverURL.port &&
            (url.path == String(mount.dropLast()) || url.path.hasPrefix(mount))
    }
}

enum HandoverError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

func privateWrite(_ data: Data, to url: URL) throws {
    let manager = FileManager.default
    try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
    guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
        throw HandoverError.message("无法保存本机配置。")
    }
    defer { try? manager.removeItem(at: temporary) }
    // POSIX rename replaces the target atomically and retains the temporary file's 0600 mode.
    guard rename(temporary.path, url.path) == 0 else { throw HandoverError.message("无法原子保存本机配置。") }
}

struct HandoverRequest: Decodable {
    let id: String
    let username: String?
    let accessMode: String?
    let status: String
    let waitingFor: String?
    let userAttentionVersion: Int?

    var version: Int { max(1, userAttentionVersion ?? 1) }
    var waiting: Bool { !["completed", "cancelled"].contains(status) && (waitingFor ?? (status == "submitted" ? "agent" : "user")) == "user" }
    func belongs(to username: String) -> Bool {
        self.username == username && accessMode == "username" && id.range(of: "^[A-Za-z0-9_-]{8,100}$", options: .regularExpression) != nil
    }
}

struct HandoverInbox: Decodable { let requests: [HandoverRequest] }

struct AttentionTracker: Codable, Equatable {
    private(set) var scopes: [String: [String: Int]] = [:]

    mutating func ingest(_ requests: [HandoverRequest], config: HandoverConfiguration) -> [HandoverRequest] {
        let records = requests.filter { $0.belongs(to: config.username) }
        let previous = scopes[config.scope]
        var versions = previous ?? [:]
        let new = previous == nil ? [] : records.filter { $0.waiting && $0.version > (versions[$0.id] ?? 0) }
        for request in records { versions[request.id] = max(versions[request.id] ?? 0, request.version) }
        scopes[config.scope] = versions
        return new
    }
}
