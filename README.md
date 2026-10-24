# 远程交接服务

基于 `jasonku09/grill-with-ui` 扩展的个人远程交接服务。保留 Grill 的问卷、多选、每题讨论、暂缓、重新打开、深入分析与图解协议，增加反馈、求助、多会话隔离、手机桌面安装及 Web Push。

Agent 发起请求，自动打开默认浏览器，并在当前回合分段等待属于自己的真实答复。手机和电脑访问同一服务器；答复被持久保存，Agent 处理后明确确认消费，再继续原会话。手机不主动创建业务请求。

## 部署配置

- 仓库：`UnityX103/handover-ui-server`，发布分支 `main`。
- 公网入口由服务器环境变量 `HANDOVER_PUBLIC_URL` 设置；文档不记录实际部署地址。
- 内部应用：`127.0.0.1:8025`；内部 GitHub 接收器：`127.0.0.1:8032`。
- GitHub 原生 push webhook → 签名验证 → 持久队列 → 服务器只读拉取 → 独立 release → 测试 → 原子切换 → 健康检查。失败回滚，不使用定时拉取。

部署、查看版本、日志和回滚方法见 [部署交接](docs/DEPLOYMENT.md)。原始来源和许可证见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。

## 手机使用

默认首页为留空的用户名登录界面。手动填写并连接成功后，本标签页记住所选用户名，刷新不再显示输入框；点击右上角“退出”后回到空白登录界面，才能切换用户名。带 `?username=Xpy` 的链接只标记目标，不会自动登录或切换当前用户；未登录先填写用户名，目标不匹配时先退出再进入。

这里的“登录”只是公开用户名选择，不是身份认证。旧私有请求登录位于 `/?mode=legacy`；下列登录码与通知管理属于受保护的旧 owner 功能，不会仅凭用户名开放。

1. 旧模式电脑由客户端 `home` 自动打开并登录。在“设备与通知”点击“查看登录码”。
2. 手机打开同一公网入口，输入固定登录码；长期有效、可重复使用，服务更新和重启后不变，由服务器环境变量维护。iPhone 用 Safari 分享菜单“添加到主屏幕”，Android 用浏览器“安装应用 / 添加到主屏幕”。
3. 从桌面图标打开，在“设备与通知”点击“开启通知”并授予权限。iPhone Web Push 需要 iOS/iPadOS 16.4 或更新版本的桌面 Web App。

安装和通知权限必须由用户在手机上操作。通知只提醒有新请求，不负责唤醒来源 Agent。关闭网页后，订阅过的设备仍可由浏览器推送服务接收提醒。断网时不提交答复；已暂存内容和草稿保留在该设备，恢复连接后手动发送。Service Worker 只缓存公开静态界面，不缓存请求列表、题目或答复。

点击通知直接进入对应问题；登录失效时先登录，再自动回到同一题。网页提交答复后，等来源 Agent 明确确认收到该次答复，再自动返回主界面。提交失败或尚未确认时留在原题；等待期间新写入的草稿也会保留。

## 安装两个 Skill

```sh
npm run install:skills
```

安装 `skills/grill-with-ui` 与 `skills/remote-handover` 到用户 Codex Skill 目录。旧版移到 `~/.local/share/handover-ui/skill-backups/<时间>/`，不再被发现为活动 Skill。已有 `grill-with-docs-ui` 会更新为组合调用新的远程入口，保留领域词汇表与 ADR 工作流。

每次使用客户端 `new`、`resume` 或 `home` 时，先通过本机已登录的 `gh` 请求仓库 `main` 最新 SHA。有更新就从同一个确定提交下载 `skills/manifest.json` 列出的文件，备份并更新两份 Skill 和已有组合入口，再以新版客户端继续原操作；现有凭据、请求 handle 与游标保留。没有更新只发一次版本检查；当前交接的分段等待和答复确认不重复检查。检查或下载失败时保留现有版本并报告；可单独运行 `node cli.mjs update`。隔离测试使用 `HANDOVER_SKIP_UPDATE=1`。

两份 Skill 共用 `~/.config/handover-ui/config.json`（0600）：

```json
{"serverUrl":"<HANDOVER_SERVER_URL>","username":"Xpy"}
```

本地变量 `HANDOVER_SERVER_URL` 可覆盖目标服务器；`HANDOVER_USERNAME` 覆盖目标用户名。未设置用户名且未配置旧 Agent 凭据时默认使用 `Xpy`，无需填写 `HANDOVER_AGENT_TOKEN`。用户名区分大小写，仅接受 1–64 个英文字母、数字、下划线或短横线。`HANDOVER_CONFIG` 可指定其他配置文件。

**用户名只是公开命名空间，不是登录认证。任何知道用户名的人都可能读取、提交、修改或结束其新请求，不能凭用户名证明答复者身份。** 不要在此模式放入秘密或需要保密的资料。来源会话仍用于防止客户端误接其他会话事件，不是身份认证。旧的无用户名记录不会自动转入 Xpy，仍保留原登录与每请求凭据保护；旧配置中的 `agentToken` / `HANDOVER_AGENT_TOKEN` 继续支持旧模式。显式设置用户名即使用用户名模式，即使旧 token 仍存在。

用户名模式的浏览器打开不签发登录票据，也不能查看登录码、管理订阅或取得 owner 权限；用户名请求不会发送 Web Push，以免泄漏给旧模式设备订阅。旧登录、管理功能和 Webhook 保持独立保护。

```sh
node cli.mjs config --show
node cli.mjs update
node cli.mjs config --server "$HANDOVER_SERVER_URL" --username Xpy
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

创建返回绝对 handle 路径、请求 ID 和普通 URL。用户名模式 URL 携带 `?username=Xpy`，schema 2 handle 保存不可变用户名与创建载荷，不需要每请求秘密；旧模式 schema 1 handle 保留每请求凭据，自动打开的登录链接只在浏览器片段携带一次性票据。所有 handle 仍以 0600 保存。切换配置不会改写已有请求归属；网络故障后 `resume --handle` 继续相同请求，不能重复创建。

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

测试使用隔离临时目录和虚构来源，不向真实会话伪造答复。测试涵盖上游兼容、认证、来源隔离、幂等、恢复、前台等待、推送调度、Webhook 与回滚；浏览器检查手机/平板布局、多选、草稿、重复提交、固定登录码和缓存边界。真实手机安装与系统通知许可需在设备上验收。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/` | 远端 HTTP 服务、原子持久化、身份与事件隔离 |
| `web/` | 手机收件箱、PWA、推送与上游页面的适配层 |
| `skills/` | 两份 Skill 与通用客户端 |
| `deploy/` | 首装、Webhook、systemd、独立版本发布和回滚 |
| `page.html`、`server.mjs` | 保留的上游界面、校验和原始回归服务 |
| `docs/upstream-*` | 原始 Skill 与 README 的来源存档，不用于本机安装 |

## 自定义页面与 JSON 反馈

服务也可作为桥接层，承载 Skill 自己生成的自包含 HTML，并将其自定义 JSON 反馈交回来源会话。先用 `node cli.mjs probe` 检查能力；创建载荷中的 `page` 提供 `version:1`、`html`、`feedbackType` 和 `documentId`。页面调用 `window.HandoverBridge.submit(payload)` 提交，收到的事件为 `type:"feedback"`，原始 JSON 位于 `payload`。先保存和核验，再明确 `ack`；自动返回沿用原请求机制并保留用户名。只有旧认证模式请求发送 Web Push，用户名请求不发送通知。

自定义 HTML 在隔离 iframe 中运行，不获得本站 Cookie、存储或网络访问能力；HTML 和反馈有大小限制。业务决定、JSON 结构校验及执行授权由来源 Skill 负责，服务不执行反馈中的命令。页面应始终保留本地导出 JSON 的能力；客户端、配置或服务器能力缺失时使用离线 HTML／JSON。创建结果未知时保留原 handle，核对同一请求，不重复创建。详细接入见 [自定义页面契约](skills/grill-with-ui/references/custom-pages.md)。

三份 MIDA 项目 Skill 的隔离桥接联调可通过 `MIDA_PROJECT_ROOT` 指定项目，沿已有 Playwright 环境运行 `npm run test:bridge`。它只生成合成页面与反馈，不启动 Unity，不恢复项目测试队列。
