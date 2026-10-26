# 远程交接服务

基于 `jasonku09/grill-with-ui` 扩展的个人远程交接服务。保留 Grill 的问卷、多选、每题讨论、暂缓、重新打开、深入分析与图解协议，增加反馈、求助、多会话隔离、手机桌面安装及 Web Push。

Agent 发起请求，自动打开默认浏览器，并在当前回合分段等待属于自己的真实答复。手机和电脑访问同一服务器；答复被持久保存，Agent 处理后明确确认消费，再继续原会话。手机不主动创建业务请求。

## 部署配置

- 仓库：`UnityX103/handover-ui-server`，发布分支 `main`。
- 公网入口由服务器环境变量 `HANDOVER_PUBLIC_URL` 设置；文档不记录实际部署地址。
- 现有 HTTPS 443 可挂载 `/handover/`，完整地址加入 `HANDOVER_PUBLIC_ALIASES`；Nginx 配置见 `deploy/nginx-path.conf`。8024 原入口可并行使用，共享同一份请求和数据。
- 内部应用：`127.0.0.1:8025`；内部 GitHub 接收器：`127.0.0.1:8032`。
- GitHub 原生 push webhook → 签名验证 → 持久队列 → 服务器只读拉取 → 独立 release → 测试 → 原子切换 → 健康检查。失败回滚，不使用定时拉取。

部署、查看版本、日志和回滚方法见 [部署交接](docs/DEPLOYMENT.md)。原始来源和许可证见 [UPSTREAM.md](UPSTREAM.md) 与 [LICENSE](LICENSE)。

## 手机使用

列表默认只显示“待回答”，已提交给 Agent 的内容单列为“已发送，等待回复”；Agent 确认收件（ack）不会把它重新归为待回答，追加新问题或重开后才重新待回答，结束/取消保持已结束。

列表顶部使用紧凑通知与退出控件，不显示大标题或常驻刷新按钮；在列表滚动到顶部时向下拉动刷新，键盘/屏幕阅读器仍可使用无障碍刷新控件。

默认首页为留空的用户名登录界面。手动填写并连接成功后，此浏览器持久记住所选用户名，刷新、关闭后重开或访问同名直达链接均无需重新输入；点击右上角“退出”后回到空白登录界面，才能切换用户名。带 `?username=Xpy` 的链接只标记目标；已记住同名用户时直接进入回答，首次或退出后仍需主动填写。目标不匹配时先退出再进入，不会被链接静默切换。

这里的“登录”只是公开用户名选择，不是身份认证。旧固定登录码、Agent token、owner 登录及票据入口已停用；旧无用户名记录与凭据留存归档，不能再通过网页/API 访问，也不会自动公开或迁移。

**用户名手机通知：** 在目标手机/PWA 登录所需用户名后，主动点击“开启通知”并授予系统权限，才把此设备绑定到该用户名。只接收同名请求通知；一个浏览器/PWA 推送订阅同时只绑定一个用户名，不能借此访问旧私有订阅。退出用户名会先解绑本设备，其他手机不受影响；解绑失败时保持当前登录并提示重试。登录另一用户名后需主动开启该用户通知。点击“开启通知”会凭本设备完整 PushSubscription 的 endpoint 和两项 keys，将这一设备的旧用户名/旧私有绑定安全替换为当前用户名；不暴露订阅列表，不影响其他设备，证明不匹配时拒绝替换。仅登录或打开链接不会自动改绑。

用户名设备绑定需要支持 Web Locks、Service Worker 与 Push 的浏览器；不支持安全跨标签页协调时会提示更新浏览器，不执行不安全回退。通知接收绑定与记住的用户名都是本浏览器级；多个标签页共享用户名选择，退出会使其他标签页失效。设备改绑仅由当前用户明确点击授权，链接不能静默改绑。退出后设备会过滤已排队的旧用户名通知。点击通知保留用户名和请求目标，仍遵循空白登录/不自动切换规则。

手机添加到主屏幕：iPhone 用 Safari 分享菜单“添加到主屏幕”，Android 用浏览器“安装应用 / 添加到主屏幕”。iPhone Web Push 需要 iOS/iPadOS 16.4 或更新版本的桌面 Web App。

“清空未读”仅清除当前浏览器、当前用户名的角标快照，不删除问题/答案、不将题目标为已答、不替 Agent 确认事件；后续新通知仍可重新出现角标。

安装和通知权限必须由用户在手机上操作。通知只提醒有新请求，不负责唤醒来源 Agent。关闭网页后，订阅过的设备仍可由浏览器推送服务接收提醒。断网时不提交答复；已暂存内容和草稿保留在该设备，恢复连接后手动发送。Service Worker 只缓存公开静态界面，不缓存请求列表、题目或答复。

服务在原请求的私有 `webPushReceipt` 中保存最近一次 Web Push 的匹配订阅数、HTTP 状态及接受/拒绝/过期/未确认计数，同时写入脱敏 `push_receipt` 日志。它不记录设备端点、密钥、响应正文，也不表示手机已显示；旧请求不会补造回执，不因未确认而自动重发。排障边界见 [手机推送诊断](docs/push-diagnostics.md)。

可选的同服务器微信提醒桥接默认关闭：交接服务仅经 Unix socket 将简短标题和原请求链接持久交给独立 Bot。默认按精确来源/用户名白名单收件，再由协调会话核实批准。本人也可显式配置 `HANDOVER_NOTIFY_SOURCES=*`、`HANDOVER_NOTIFY_USERNAMES=*`，并在 Bot 启用全访客及可信同机自动放行，让所有合法访客的未来待答事项自动提醒既有绑定微信用户，无需聊天逐条放行。两份名单各自支持单独的 `*`，不能与具体项混用；全来源模式还支持服务已有的合法请求 ID 及安全文本来源，精确来源模式保留原 UUID 协议。旧私有归档及历史请求不补发。`new`、`resume`、`state` 仍返回精确的八字段 `notification`，供人工模式或排障时原样核对。此项目不保存微信、CNB 凭据或新的共享密钥；Bot 收件不等于微信送达，通知放行也不批准业务操作。配置、幂等与批准边界见 [通知桥接契约](docs/notification-bridge.md)。

点击通知直接进入对应问题；登录失效时先登录，再自动回到同一题。网页提交答复并收到服务器保存成功回执后立即返回当前用户名的请求列表，不等待来源 Agent ack。列表保留“已发送，等待回复”；页面返回不代表 Agent 已处理。提交失败或提交期间产生新草稿时留在原题并保留内容。

从“已发送，等待回复”重开时，普通问卷从服务器恢复尚未处理的选项与文字；自定义页面读取当前页面版本的最近已发送 JSON，通过恢复回调还原自己的控件。原始反馈始终可在页面上方查看；Agent 确认、浏览器刷新、换设备和服务重启不删除已发送数据。旧自定义 HTML 保持原版本，外层同样提供原 JSON；页面接入恢复回调后，新生成的页面还会自动回填选项。

## 安装两个 Skill

```sh
npm run install:skills
```

安装 `skills/grill-with-ui` 与 `skills/remote-handover` 到用户 Codex Skill 目录。旧版移到 `~/.local/share/handover-ui/skill-backups/<时间>/`，不再被发现为活动 Skill。已有 `grill-with-docs-ui` 会更新为组合调用新的远程入口，保留领域词汇表与 ADR 工作流。

每次使用客户端 `new`、有效 schema 2 的 `resume` 或 `home` 时，先用本机 Git 非交互运行 `git ls-remote https://github.com/UnityX103/handover-ui-server.git refs/heads/main`，读取公开仓库 `main` 的完整 SHA；不需要 `gh`、GitHub 登录或访问 token。有更新就使用 Node.js 内置 `fetch` 从 `raw.githubusercontent.com/UnityX103/handover-ui-server/<完整 SHA>/` 下载清单和 `skills/manifest.json` 列出的文件，始终固定同一个提交，备份并更新两份 Skill 和已有组合入口，再以新版客户端继续原操作；现有凭据、请求 handle 与游标保留。没有更新只发一次版本检查；当前交接的分段等待和答复确认不重复检查。检查或下载失败时保留现有版本并报告；可单独运行 `node cli.mjs update`。隔离测试使用 `HANDOVER_SKIP_UPDATE=1`。本机需安装 Git 与 Node.js 22.11+，能访问 GitHub HTTPS 和 raw.githubusercontent.com；完整下载、路径校验、并发锁、备份与按目录原子重命名切换/失败恢复保持不变。该客户端公开下载流程不改变服务器 Webhook 发布链路或只读部署身份。

两份 Skill 共用 `~/.config/handover-ui/config.json`（0600）：

```json
{"serverUrl":"<HANDOVER_SERVER_URL>","username":"Xpy"}
```

本地变量 `HANDOVER_SERVER_URL` 可覆盖目标服务器；`HANDOVER_USERNAME` 覆盖目标用户名。未设置用户名时始终默认使用 `Xpy`，无需填写 `HANDOVER_AGENT_TOKEN`。用户名区分大小写，仅接受 1–64 个英文字母、数字、下划线或短横线。`HANDOVER_CONFIG` 可指定其他配置文件。

**用户名只是公开命名空间，不是登录认证。任何知道用户名的人都可能读取、提交、修改或结束其新请求，不能凭用户名证明答复者身份。** 不要在此模式放入秘密或需要保密的资料。来源会话仍用于防止客户端误接其他会话事件，不是身份认证。旧的无用户名记录与 schema 1 handle 仅保留归档，所有在线访问路径停用，不自动转入 Xpy。客户端忽略旧配置中的 `agentToken` / `HANDOVER_AGENT_TOKEN`，不读取 stdin 设置 token，不删除原配置字段或文件。

用户名模式的浏览器打开不签发登录票据，也不能查看登录码或取得 owner 权限；可经用户主动授权绑定/解绑本设备通知，不能列出订阅、取得其他设备密钥或操作旧私有订阅。用户名请求只向绑定同名的设备推送，不发送给旧模式设备。旧登录、配对、票据、登录码及 owner 退出 API 返回 410（已停用），旧 Cookie 或 token 不再开放归档数据。管理员配置、Webhook 验签和 VAPID 私钥仍受原保护。

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

创建返回绝对 handle 路径、请求 ID 和普通 URL。用户名模式 URL 携带 `?username=Xpy`，schema 2 handle 保存不可变用户名与创建载荷，不需要每请求秘密；旧 schema 1 handle 只保留归档，客户端在联网或更新检查前拒绝恢复，不重复创建或迁移请求。所有 handle 仍以 0600 保存。切换配置不会改写已有请求归属；网络故障后 `resume --handle` 继续相同请求，不能重复创建。

本人可在普通问卷或自定义页面点击“取消本次回答”，来源 Agent 会收到取消状态并停止等待。来源 Agent 也可用 `cancel --handle` 撤回自己发起的请求；同题已在当前聊天或明确传回本会话的群消息中得到真实答复时，先记录答复及来源、按需 patch，再取消远端待答问题。取消保留草稿、已有事件与消费游标，不制造答案或自动批准后续操作；已完成记录不改成取消。

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
# 复用上述 Playwright / Chromium 环境，验证子路径下的手机问答与 JSON 页面：
HANDOVER_TEST_BASE_PATH=/handover node test/username.e2e.mjs
# 指定两个 Skill 工作区，验证已发送反馈重开、换设备、确认后恢复及资源手动处理数据：
MIDA_FLOW_PROJECT_ROOT=/absolute/path/flow-workspace \
MIDA_RESOURCE_PROJECT_ROOT=/absolute/path/resource-workspace npm run test:sent
```

测试使用隔离临时目录和虚构来源，不向真实会话伪造答复。测试涵盖上游兼容、认证、来源隔离、幂等、恢复、前台等待、推送调度、Webhook 与回滚；浏览器检查手机/平板布局、多选、草稿、重复提交、用户名会话、旧入口停用和缓存边界。真实手机安装与系统通知许可需在设备上验收。

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

服务也可作为桥接层，承载 Skill 自己生成的自包含 HTML，并将其自定义 JSON 反馈交回来源会话。先用 `node cli.mjs probe` 检查能力；创建载荷中的 `page` 提供 `version:1`、`html`、`feedbackType` 和 `documentId`。页面调用 `window.HandoverBridge.submit(payload)` 提交，收到的事件为 `type:"feedback"`，原始 JSON 位于 `payload`。来源 Agent 先保存和核验，再明确 `ack`；页面收到服务器保存成功回执后立即返回列表并保留用户名，不等待 ack，也不代表反馈已被处理。用户名请求向主动绑定同名的设备发送 Web Push；旧认证模式已停用，归档私有订阅不再接收旧请求通知。

自定义 HTML 在隔离 iframe 中运行，不获得本站 Cookie、存储或网络访问能力；HTML 和反馈有大小限制。业务决定、JSON 结构校验及执行授权由来源 Skill 负责，服务不执行反馈中的命令。页面应始终保留本地导出 JSON 的能力；客户端、配置或服务器能力缺失时使用离线 HTML／JSON。创建结果未知时保留原 handle，核对同一请求，不重复创建。详细接入见 [自定义页面契约](skills/grill-with-ui/references/custom-pages.md)。

三份 MIDA 项目 Skill 的隔离桥接联调可通过 `MIDA_PROJECT_ROOT` 指定项目，沿已有 Playwright 环境运行 `npm run test:bridge`。它只生成合成页面与反馈，不启动 Unity，不恢复项目测试队列。

更新锁若属于已退出的进程，客户端不会自动删除它，避免并发安装覆盖。遇到 `stale-lock` 或 `recovery-needed` 时先核实没有更新进程，并检查原 Skill 与备份后人工恢复；恢复未完成时保留锁、停止自动安装，不宣称原安装已完整恢复。

安装切换按各 Skill 目录分别重命名，不保证进程崩溃时多目录整体原子性；恢复失败不会伪称旧版本已完整还原。
