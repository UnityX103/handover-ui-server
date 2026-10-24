# 远程交接服务

基于 [jasonku09/grill-with-ui](https://github.com/jasonku09/grill-with-ui) 扩展的个人远程交接服务。保留 Grill 的问卷、多选、每题讨论、暂缓、重新打开、深入分析与图解协议，增加反馈、求助、多会话隔离、手机桌面安装及 Web Push。

Agent 发起请求，自动打开默认浏览器，并在当前回合分段等待属于自己的真实答复。手机和电脑访问同一服务器；答复被持久保存，Agent 处理后明确确认消费，再继续原会话。手机不主动创建业务请求。

## 当前部署

- 私有仓库：`UnityX103/handover-ui-server`，发布分支 `main`。
- 公网入口：**https://server.nanzhaigame.cn:8024/**。
- 内部应用：`127.0.0.1:8025`；内部 GitHub 接收器：`127.0.0.1:8032`。
- GitHub 原生 push webhook → 签名验证 → 持久队列 → 服务器只读拉取 → 独立 release → 测试 → 原子切换 → 健康检查。失败回滚，不使用定时拉取。

部署、查看版本、日志和回滚方法见 [部署交接](docs/DEPLOYMENT.md)。原始来源和许可证见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。

## 手机使用

1. 电脑由客户端 `home` 自动打开并登录。在“设备与通知”点击“生成手机登录码”。
2. 手机打开同一公网入口，输入一次性登录码；有效期 10 分钟。iPhone 用 Safari 分享菜单“添加到主屏幕”，Android 用浏览器“安装应用 / 添加到主屏幕”。
3. 从桌面图标打开，在“设备与通知”点击“开启通知”并授予权限。iPhone Web Push 需要 iOS/iPadOS 16.4 或更新版本的桌面 Web App。

安装和通知权限必须由用户在手机上操作。通知只提醒有新请求，不负责唤醒来源 Agent。关闭网页后，订阅过的设备仍可由浏览器推送服务接收提醒。断网时不提交答复；已暂存内容和草稿保留在该设备，恢复连接后手动发送。Service Worker 只缓存公开静态界面，不缓存请求列表、题目或答复。

## 安装两个 Skill

```sh
npm run install:skills
```

安装 `skills/grill-with-ui` 与 `skills/remote-handover` 到用户 Codex Skill 目录。旧版移到 `~/.local/share/handover-ui/skill-backups/<时间>/`，不再被发现为活动 Skill。已有 `grill-with-docs-ui` 会更新为组合调用新的远程入口，保留领域词汇表与 ADR 工作流。

两份 Skill 共用 `~/.config/handover-ui/config.json`（0600）：

```json
{"serverUrl":"https://your-server.example:8024","agentToken":"由受限本地配置保存"}
```

本地变量 `HANDOVER_SERVER_URL` 可覆盖目标服务器；`HANDOVER_AGENT_TOKEN` 覆盖本地 Agent 凭据。`HANDOVER_CONFIG` 可指定其他配置文件。不要把凭据放进 Skill 或命令行参数。

```sh
node cli.mjs config --show
node cli.mjs config --server https://your-server.example:8024 --token-stdin
node cli.mjs home
```

## 客户端协议

Node.js 22.11+，客户端不需要第三方依赖。`CODEX_THREAD_ID` 或 `CLAUDE_SESSION_ID` 标识真实来源；其他客户端经核实后传 `--source-session`，不根据最近会话猜测。

```sh
node cli.mjs new --kind questionnaire --file /absolute/path/questions.json
node cli.mjs new --kind feedback --topic '请反馈当前结果' --context '说明结果、待反馈事项和限制'
node cli.mjs new --kind help --topic '需要帮助' --context '说明阻塞、证据、已尝试方法和所需信息'
node cli.mjs wait --handle /absolute/path/handle.json --timeout 25
node cli.mjs state --handle /absolute/path/handle.json
node cli.mjs patch --handle /absolute/path/handle.json --file /absolute/path/patch.json
node cli.mjs ack --handle /absolute/path/handle.json --seq 1
node cli.mjs finish --handle /absolute/path/handle.json
```

创建返回绝对 handle 路径、请求 ID 和普通 URL，自动打开的登录链接只在浏览器片段携带一次性票据。handle 以 0600 保存，含每请求凭据和创建载荷；网络故障后 `resume --handle` 继续相同请求，不能重复创建。

`wait` 最长 30 秒，退出 3 只表示本段没有答复，继续同一请求的下一段。每个请求只允许一个前台等待者。返回事件含 `requestId`、`sourceSession` 和连续 `seq`；读取不自动消费。先落实收到的真实答案、写回状态，再 `ack` 已处理的最高连续序号。中断后检查 `state` 与 `pending`，避免重复落实；`ack` 成功但响应丢失时，以服务端已确认游标为准。

问题文件示例：

```json
{
  "topic":"方案确认",
  "context":"当前事实、目标及仍需决定的内容",
  "questions":[{
    "id":"q1","round":1,"title":"使用哪种方案？","body":"说明差异",
    "options":[{"k":"A","text":"方案甲"},{"k":"B","text":"方案乙"}],
    "rec":{"option":"A","why":"说明推荐理由与取舍"}
  }]
}
```

支持增量 `patch` 追加新题与讨论，沿用上游状态模型；同一访谈后续轮次不复用题目 ID。选项推荐没有预选，不会自动提交。`thread` 是讨论，`finish` 是结束问答，均不自动授权实施。仅真实用户答复才能解除依赖该答复的工作。

## 本地开发与验证

服务端使用 Node.js 22.11+、Python 3.12+；仅依赖 `web-push`，锁文件固定版本。

```sh
npm ci --ignore-scripts
# 在受限环境文件中设置 .env.example 的变量，再运行：
npm start
npm test
# 另行提供已安装的 Playwright 与 Chromium：
PLAYWRIGHT_PKG=/absolute/path/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/chromium npm run test:browser
```

测试使用隔离临时目录和虚构来源，不向真实会话伪造答复。测试涵盖上游兼容、认证、来源隔离、幂等、恢复、前台等待、推送调度、Webhook 与回滚；浏览器检查手机/平板布局、多选、草稿、重复提交及缓存边界。真实手机安装与系统通知许可需在设备上验收。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 远端 HTTP 服务、原子持久化、身份与事件隔离 |
| `web/` | 手机收件箱、PWA、推送与上游页面的适配层 |
| `skills/` | 两份 Skill 与通用客户端 |
| `deploy/` | 首装、Webhook、systemd、独立版本发布和回滚 |
| `page.html`、`server.mjs` | 保留的上游界面、校验和原始回归服务 |
| `docs/upstream-*` | 原始 Skill 与 README 的来源存档，不用于本机安装 |
