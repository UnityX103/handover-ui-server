# 同服务器通知桥接

交接服务可把真实待答事项的短标题和原请求链接，经同服务器 Unix socket 交给独立微信 Bot。功能默认关闭，通过仓库 `main` 的既有 push webhook 发布；是否启用以仓库外受限服务器配置为准。现有问卷、反馈、求助、Web Push 和来源会话的答复确认流程保留。

## 来源与批准

来源 Agent 使用自己的远程 Skill 创建真实请求。客户端 `new`、`resume`、`state` 返回 `notification`；有新题的 `patch` 也返回该字段。人工批准模式下，获本人授权的来源 Agent 将这份八字段 JSON 原样交给协调会话，同时展示标题和直达链接；全访客自动模式无需每条再发协调消息。标题已去控制字符、合并空白并截到 140 个 Unicode 字符，不能使用原 topic 重建同 ID 的载荷。

用户名和来源会话 ID 都是公开路由字段，不是认证。Socket 文件权限与接收端 `SO_PEERCRED` 只能确认交接应用进程。默认人工模式下，即使来源和用户名命中精确白名单，Socket POST 也只进入 `awaiting_approval`；协调会话通过公开会话接口核实真实来源后，使用其项目外的既有 Bearer 管理接口提交完全相同的八字段，才可进入 `pending`。

本人已于 2026-10-26 明确授权本服务所有合法访客的新待答事项自动通知。启用该模式须目标侧显式配置两份名单为 `*`，Bot 侧显式配置 `visitor_policy="all"`、`auto_approve=true`。Bot 仅对经过 `SO_PEERCRED` 核对的交接应用同机 socket 投递自动进入 `pending`，保留固定 HTTPS 站点、请求/来源格式、用户名、标题和类型校验；受保护控制 API 的权限边界保留。它只向既有绑定微信用户转发标题与原题链接，不批准业务操作、不开放 shell 或任意微信联系人，普通访客不需要 Bot 凭据。协调会话的授权和当前协作范围记录在 `AGENTS.md`。

来源会话继续保管原 handle，前台等待、落实真实答复并确认事件；Bot 只提醒，不代替本人作答。协调会话不取得来源消费游标，也不根据提醒内容自动批准业务操作。通知中只含以下字段，不转发正文、答案、项目路径、设备信息或凭据。

## 固定接口

接收端 socket 为 `/run/wechat-bot/handover-notify.sock`。发送端只使用 HTTP over Unix socket，不使用 TCP、DNS、重定向或 HTTP Bearer 凭据。

`POST /v1/handover-notifications` 的 JSON 恰好包含八个字符串字段：

```json
{
  "schema": "handover.notification.v1",
  "event_id": "<稳定的64位小写十六进制SHA256>",
  "request_id": "<合法请求ID>",
  "source_session": "<符合当前模式的来源ID>",
  "username": "<符合配置准入规则的合法用户名>",
  "title": "<单行短标题>",
  "url": "<配置的完整入口>grill/<request_id>/?username=<username>",
  "kind": "help"
}
```

`kind` 允许 `questionnaire`、`feedback`、`help`。`event_id` 为 `SHA256(JSON.stringify(["handover.notification.v1", requestId, userAttentionVersion]))`。URL 必须精确匹配配置入口、原请求 ID 和唯一 `username` 参数，不含凭据、fragment 或其他参数。创建后保留最初入口，支持已经登记的 8024 与 `/handover/` 别名；不把已发链接静默改为另一入口。

精确来源模式的请求 ID、来源 ID 仍须是小写 UUID。显式 `HANDOVER_NOTIFY_SOURCES=*` 模式兼容服务已有的请求格式：请求 ID 为 8–100 个 `[A-Za-z0-9_-]` 字符；来源为去空白后非空、至多 200 个 UTF-16 代码单元且不含 Unicode C 类字符的文本。两种模式下用户名均为 1–64 个英文字母、数字、下划线或短横线；通配不绕过这些格式校验，也不重写来源身份。问卷、反馈、求助及自定义页面共用用户名请求创建入口；符合当前模式的新请求均可按配置入队。原 API 的来源头及答复读写权限不变；旧非用户名记录仍归档，手机不增加主动创建业务请求的入口。

Bot 首次接收返回 202；同 ID、同载荷返回同一收件结果，内容冲突返回 409。回执形状如下，`GET /v1/handover-notifications/<event_id>` 返回 200 和相同形状：

```json
{"event_id":"<同一ID>","request_id":"<原请求ID>","state":"pending","error":null}
```

接收状态包括 `awaiting_approval`、`pending`、`dispatching`、`succeeded`、`failed`、`unknown`，首次收件状态取决于接收端批准模式。目标侧只有核对 event ID、request ID 和已知状态后才记为 `accepted`；它仅表示 Bot 已持久收件，不继续追踪发送晋级。`succeeded` 也仅表示微信 API 接受；不能宣称本人收到或已读。

POST 超时、断线或回执无效时，目标侧先持久保留未知结果，随后查询原 event ID。只有明确的 404 才允许按同 ID、同载荷重投；查询失败继续退避等待。包括 `unknown` 在内的已存在状态都不会再次 POST。400、401、403、409、422 的 POST 拒绝终止此出站项，不改业务请求。429、503 与网络错误退避后先查原 ID，不创建替代事件。

## 目标端配置

在仓库外受限 systemd `EnvironmentFile` 中设置以下变量；`.env.example` 仅提供空值和默认值，不包含真实凭据。

| 变量 | 含义 / 默认值 |
| --- | --- |
| `HANDOVER_NOTIFY_ENABLED` | `0` 默认关闭；只有 `1` 启用 |
| `HANDOVER_NOTIFY_SOCKET` | 显式绝对 socket 路径，最多 100 字节 |
| `HANDOVER_NOTIFY_SOCKET_UID` | 显式配置 Bot socket 所有者的数字 UID，无自动默认 |
| `HANDOVER_NOTIFY_SOURCES` | 逗号分隔的精确来源白名单，或单独的 `*` 允许所有合法 UUID 来源 |
| `HANDOVER_NOTIFY_USERNAMES` | 逗号分隔的精确用户名白名单，或单独的 `*` 允许所有合法用户名 |
| `HANDOVER_NOTIFY_MAX_PENDING` | 全局未收件项上限 128，可设 1–512 |
| `HANDOVER_NOTIFY_PER_SOURCE_MINUTE` | 每来源每分钟最多新建 5 项，可设 1–20 |
| `HANDOVER_NOTIFY_INTERVAL_MS` | 两次出站处理至少间隔 1000 毫秒，可设 50–60000 |
| `HANDOVER_NOTIFY_TIMEOUT_MS` | 单次 socket 请求超时 3000 毫秒，可设 50–10000 |

初次联调使用已获授权的单一来源及 `Xpy`。默认行为保留精确名单；`HANDOVER_NOTIFY_SOURCES` 和 `HANDOVER_NOTIFY_USERNAMES` 可各自独立设为单独的 `*`，例如所有来源配精确用户名，或两项均为 `*`。`*,Xpy`、`*,` 等混用写法及空名单均不合法。启用而缺少 socket UID 或准入名单时启动报错。所有配置只保存在受限服务器环境文件，源码发布不会自动启用通配或修改 Bot 批准模式。

关闭时不扫描历史出站记录，不连 socket；再次启用只恢复已有未收件出站项，不为没有出站项的历史请求补发通知。扩大准入范围也只影响未来真实新建、追加新题及 Agent 真正重开待答题时的 `prepare`，读取、恢复和重放创建不补造旧版本意图；已接受状态和 `unknown` 不重投。即使桥接关闭，合法 UUID 请求仍可返回 `notification` 供获授权的会话协作使用。

Bot 侧另有限额：最多 100 项待处理，每来源每小时 60 项，发送间隔至少 30 秒，未结束任务一天到期（包含待批准项）。这些是接收端约定；最终值以协调端实现为准。微信发送优先使用可用的私聊上下文，缺少时省略 `context_token` 尝试发送，不设置“本人必须先发微信”的前置条件；最终结果以微信响应为准。

## 持久化与并发

出站意图附加在原请求的私有 `notificationOutbox` 元数据，与创建或追加待答题的业务变更通过同一次 0600 原子文件写入提交。只有落盘后才开始发送。初次创建、新题或从已答/暂缓等状态真正重开时，沿 `userAttentionVersion` 创建新 ID；创建重放、读取、等待、同状态 patch 和普通 topic 编辑不新建事件。每版 descriptor 单独随原请求保存为 `notificationEvent`，包括桥接关闭或未准入的请求；标题与载荷不因普通元数据编辑而改变，恢复时可取得原载荷。

全局队列和每来源入队速率均有上限。满载或限流时保留 `lastSkipped` 原因，不撤销业务请求，也不因为重复创建或刷新再补发同一版本。每个请求保留待处理项和最近至多 32 个已结束项；未收件项受全局限额约束。最近一分钟的入队记录在重启后恢复用于限流。

每次 POST 前先保存 `uncertain`；崩溃后先 GET 原 ID。回执到达后重新读取最新业务记录，只修改本项出站元数据，再原子落盘，不覆盖同时到达的答案、取消或 ack。已回答、已完成、已取消或不再获允许的未投递项停止发送。出站故障不把网络等待挂在请求创建接口上，不改变 Agent 的 wait/patch/ack 语义。

## 操作系统与秘密边界

Bot 以 `wechat-bot` 用户运行，交接应用以 `handover-ui` 用户运行。协调侧管理运行目录、0660 socket 与专用 `handover-notify` 组，仅赋予连接该 socket 的权限；接收端核对 `SO_PEERCRED` 的实际 handover-ui UID。目标端在每次连接前核对文件确实是 socket 且所有者 UID 匹配。运行目录须防止无关用户替换 socket；目标服务不取得 `/var/lib/wechat-bot` 的读取权限。现有服务已允许 `AF_UNIX`，没有新增网络端口。

Bot 的微信 token、管理凭据、CNB 凭据留在协调端的项目外秘密存储，不进入本项目、Skill、Git、参数或日志。此桥接没有新增共享密钥；既有 Admin/VAPID/Webhook 配置仍独立保管，不删除、轮换或转交。系统组、systemd、socket 与线上受限配置由协调会话统一维护；目标侧仅发布所属仓库并只读验收，不并发改配置或安装全局 Skill。先确认 Bot 版本健康，再发布交接服务；目标版本健康后才由协调侧统一启用两端全访客/自动放行配置并重启所属服务。不能仅改一侧名单后宣称自动通知已接通。发布验收不创建真实验证请求或发送测试微信。

## 本地验证

`node --test test/notify-outbox.test.mjs` 使用临时目录、虚构来源、假 Unix socket 接收器和独立业务数据。覆盖默认关闭、白名单和 UID、原子意图、稳定载荷、重放去重、超时与重启核对、限流、取消、异步回执与答案/ack 并存，以及 CLI descriptor。测试不连接真实 Bot、不发微信、不创建真实用户问题。完整回归使用 `npm test`；真实 Linux socket 权限、批准接口、微信结果与手机体验仍需后续联调验收。
