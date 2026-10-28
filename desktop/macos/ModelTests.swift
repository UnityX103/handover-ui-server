import Foundation

@main
struct ModelTests {
    static func main() throws {
        let config = try HandoverConfiguration(server: "https://example.invalid/handover/", username: "Xpy")
        assert(config.endpoint("/api/requests", user: false).absoluteString == "https://example.invalid/handover/api/requests")
        assert(config.endpoint("/grill/request-01/").absoluteString == "https://example.invalid/handover/grill/request-01/?username=Xpy")
        assert(config.contains(config.endpoint("/")))
        for url in ["https://example.invalid/handover-other/", "https://evil.invalid/handover/", "http://example.invalid/handover/", "https://example.invalid/admin"] {
            assert(!config.contains(URL(string: url)!))
        }
        for server in ["http://example.invalid", "https://user:secret@example.invalid", "https://example.invalid/?secret=value", "https://example.invalid/#fragment", "https://example.invalid/a/../b", "https://example.invalid/a%2fb"] {
            assert((try? HandoverConfiguration(server: server, username: "Xpy")) == nil)
        }
        assert((try? HandoverConfiguration(server: "http://127.0.0.1:12345/handover", username: "Test")) != nil)
        assert((try? HandoverConfiguration(server: "https://example.invalid", username: "../other")) == nil)

        func request(_ id: String, version: Int = 1, waiting: String = "user", status: String = "waiting", username: String = "Xpy") -> HandoverRequest {
            HandoverRequest(id: id, username: username, accessMode: "username", status: status, waitingFor: waiting, userAttentionVersion: version)
        }
        var tracker = AttentionTracker()
        let old = request("request-01")
        assert(tracker.ingest([old], config: config).isEmpty, "首次启动只建立基线，不弹出历史请求")
        assert(tracker.ingest([old, request("request-02")], config: config).map(\.id) == ["request-02"])
        assert(tracker.ingest([old, request("request-02")], config: config).isEmpty, "相同版本不重复唤起")
        assert(tracker.ingest([request("request-01", waiting: "agent")], config: config).isEmpty, "提交或 ack 不能伪装成新消息")
        assert(tracker.ingest([request("request-01", version: 2)], config: config).map(\.id) == ["request-01"], "追加或重开题目需要唤起")
        assert(tracker.ingest([request("request-03", status: "cancelled"), request("request-04", status: "completed"), request("request-05", username: "Other")], config: config).isEmpty)
        let persisted = try JSONEncoder().encode(tracker)
        var restored = try JSONDecoder().decode(AttentionTracker.self, from: persisted)
        assert(restored.ingest([request("request-01", version: 2)], config: config).isEmpty, "重启不重复弹出")
        assert(restored.ingest([request("request-06")], config: config).map(\.id) == ["request-06"], "离线期间的新请求恢复后提醒")
        let other = try HandoverConfiguration(server: "https://example.invalid/other", username: "Xpy")
        assert(restored.ingest([old], config: other).isEmpty, "服务器路径之间隔离")
        let otherUser = try HandoverConfiguration(server: "https://example.invalid/handover/", username: "Other")
        assert(restored.ingest([request("request-07", username: "Other")], config: otherUser).isEmpty, "用户名之间隔离")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("state.json")
        try privateWrite(persisted, to: file)
        try privateWrite(Data("replacement".utf8), to: file)
        let replacement = try String(contentsOf: file, encoding: .utf8)
        assert(replacement == "replacement")
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
        assert(permissions.intValue & 0o777 == 0o600)
        print("macOS App：地址边界、首次基线、提醒去重、追加问题、取消、用户名隔离、重启恢复、原子写入与权限验证通过。")
    }
}
