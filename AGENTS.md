# AGENTS.md

本文件适用于整个 `handover-ui-server` 仓库，供在本项目工作的 Agent 使用。与用户当前指令及用户级 `AGENTS.md` 配合执行；沿用已有授权，不重复设置确认关卡。

## 开始工作

- 先用普通命令确认 `pwd`、Git 根目录和 `git worktree list --porcelain`，读取当前工作树的 `codex.workspaceProfile`、`codex.sparseEnvironment` 登记。检查 `git status --short`，保留已有的无关修改。工作树环境和会话图标按用户级规则处理；缺少环境登记时不自行创建配置。
- 先读 `CONTEXT.md` 与 `README.md`；涉及远端部署、端口、凭据位置或回滚时，再读 `docs/DEPLOYMENT.md`。以当前代码和配置核实文档中的行为。
- 搜索优先使用 `rg`。只读取当前任务需要的资料；`graphify-out/` 是可选的本地产物，保持 Git 忽略，不作为开工前置条件。

## 产品范围与兼容性

- 本项目基于 `jasonku09/grill-with-ui`，保留来源说明、MIT 许可证和上游回归测试；来源记录见 `UPSTREAM.md`。
- 用于本人在电脑、手机上处理 Agent 发来的问卷、反馈和求助。多个来源会话共享服务器，但各自拥有独立请求、事件与消费游标。手机只处理已有请求。
- 保留 Grill 的选项、多选、每题讨论、暂缓、重新打开、深入分析与图解协议。领域术语以 `CONTEXT.md` 为准，不把“交接请求”收窄成问卷。
- 根目录的 `page.html`、`server.mjs` 是上游界面和原始协议实现；远端功能优先通过 `src/`、`web/` 适配。确需修改上游文件时，核实兼容性并保留相应回归验证。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `src/server.mjs` | 远端服务入口、认证、请求路由、等待和事件确认 |
| `src/store.mjs` | 请求与事件的原子持久化 |
| `web/` | 手机收件箱、问卷适配、草稿、PWA、通知与页面跳转 |
| `cli.mjs` | 仓库内客户端入口 |
| `skills/grill-with-ui/scripts/handover.mjs` | 来源 Agent 使用的客户端 |
| `skills/`、`scripts/grill-with-docs-ui.md` | 两份远程 Skill 源码及已有组合入口的安装模板 |
| `skills/manifest.json` | 本地 Skill 更新允许安装的文件清单 |
| `scripts/install-skills.mjs` | 本地 Skill 安装入口 |
| `deploy/` | Webhook、发布、systemd、Nginx 和首次安装配置 |
| `test/` | 上游、远端协议、通知、Skill 更新、浏览器及部署测试 |
| `docs/upstream-*` | 上游资料存档，不作为本机活动 Skill 安装 |

## 人工答复与会话隔离

- 需要问卷时使用新版 `grill-with-ui`；反馈、求助和人工交接使用 `remote-handover`。组合访谈使用 `grill-with-docs-ui`，遵循其远程入口与文档维护流程。仅修改代码或说明时不自动发起访谈。
- 禁止使用 Codex 内置提问控件。问题、必要背景与待决定事项同时保留在普通聊天中；打开网页、发送通知、推荐选项、超时和断线都不构成人的答复。
- 使用经过核实的来源身份，例如 `CODEX_THREAD_ID`；不得借用最近会话、其他会话的 handle 或共享消费游标。
- 远程 Skill 适用用户级等待例外：来源 Agent 在当前回合前台等待自己发起的请求，每段最长 30 秒。不得创建后台等待、自动化或另一个会话代为等待。未通过这些 Skill 发起的提问继续遵循用户级规则。
- 创建成功后保存 `requestId`、`sourceSession` 和绝对 handle 路径。断线、取消、中断或发送结果未知时保留身份与恢复位置，先核对原请求，再通过 `resume` 恢复；不得重复创建请求来绕过故障。
- 每次创建或追加待答事项后，在来源普通聊天立即展示问题、必要背景及可点击的请求 `url`。用户名模式保留 `?username=`，免密码直达原题，不用首页替代；通过原 handle 恢复链接，不重复创建。
- `wait` 读取事件不自动消费。核对 `requestId`、`sourceSession` 与连续 `seq`，只处理尚未确认的真实事件；先落实答复并 `patch` 写回答案、讨论及状态，回答的题设为 `status:"answered"`，再 `ack` 已处理的最高连续序号。不得跳过未处理事件；恢复时核对服务端状态和已记录结果。
- `thread` 是讨论，`defer` 是暂缓，`finish` 是结束问答；按事件真实含义处理，不自动扩大实施授权。部分答复不解除其他必要问题的阻碍。
- 同一访谈的后续轮次在原请求中追加新题 ID，不复用已答题 ID；新题没有推荐时仍提供 `rec:{}`。真正结束时才 `finish`。
- 来源 Agent 可撤回自己的请求；同题在本地聊天或已明确传回本会话的群消息中得到真实答复后，先记录答复及来源、按需 patch，再 cancel 原请求。网页也允许本人取消。收到 cancelled 停止等待，保留历史事件与草稿；取消不等于作答或授权，不跳过未处理事件，不扩大到其他来源请求或未授权的群消息操作。

## 网页、手机与通知

- 请求创建后通过系统默认浏览器打开对应页面，手机和电脑访问同一服务。保留移动端排版、触控操作和添加到主屏幕的能力。
- 提交成功仅代表服务器保存了答复。页面收到保存成功回执后立即返回当前用户名的请求列表，不等待来源 Agent `ack`；请求继续显示“已发送，等待回复”，Agent 仍须按原流程处理并确认事件。保存失败或提交期间用户写入新草稿时保留当前内容。
- 已发送反馈必须可从服务端回执恢复：普通问卷恢复待处理提交，自定义页面通过受限 SDK 回填自己的选项与数据，并保留原 JSON 查看入口。`ack`、刷新、换设备或重启不删除历史反馈；回填不重发、不消费事件、不覆盖新草稿，也不扩大业务授权。旧页面保持原 HTML 与指纹。
- 点击通知直接进入对应请求；已有窗口、冷启动和登录后的恢复都要保留目标。跳转限制在本站合法请求路径，避免丢失请求 ID 或额外要求用户点击收件箱。
- “清空未读”仅清除本浏览器当前用户名的角标快照，不删请求或答案、不标记已答、不消费 Agent 事件；未来通知仍可重新出现角标。
- Service Worker 只缓存公开静态界面，不缓存请求列表、题目、答复或认证接口。草稿、重复发送与断线恢复不能混入其他请求。
- 用户名通知订阅明确绑定当前用户名；仅同名请求投递，旧私有订阅独立。一个浏览器/PWA 订阅同时只绑定一个用户名；当前用户名持久保存在本浏览器，链接不能自动切换。本人主动开启通知时可凭完整订阅 endpoint 和两项 keys 改绑这一设备，不能影响其他设备；退出先解绑本设备，不能删除其他设备或被新用户名替换的绑定。处理异步注册、退出及推送服务过期响应竞态，过滤已排队的旧用户名通知。不得返回设备 endpoint/keys 列表。
- 手机安装与通知权限由本人在设备上操作。浏览器模拟与协议测试不能替代真实手机系统通知验收，报告时说明实际覆盖范围。

- 自定义页面由来源 Skill 生成，通过隔离 iframe 和 `HandoverBridge.submit(payload)` 回传 JSON。服务只做身份、版本、大小、持久化与回执桥接，不替业务 Skill 定义批准或执行语义。页面保留 HTML／JSON 离线回退。

## Skill 配置与更新

- 两份 Skill 共用 `~/.config/handover-ui/config.json`，权限为 0600。`HANDOVER_CONFIG` 可指定配置文件；`HANDOVER_SERVER_URL`、`HANDOVER_USERNAME` 分别覆盖目标服务器和目标用户名；未配置用户名时始终默认 Xpy。旧 `HANDOVER_AGENT_TOKEN` 与保存的 agentToken 被忽略；`--token-stdin` 和旧登录入口停用，原配置和数据不删除。用户名是公开命名空间，不是认证；任何知道用户名的人可操作其新请求。不得将用户名模式接入 owner 登录票据、登录码、管理员或 Webhook 权限，不自动公开旧无用户名数据。
- 客户端在 `new`、有效 schema 2 的 `resume`、`home` 前通过本机 Git 非交互运行 `git ls-remote https://github.com/UnityX103/handover-ui-server.git refs/heads/main` 检查完整 SHA；无需 gh 登录或访问 token。有更新则使用 Node.js 内置 fetch 从 `raw.githubusercontent.com` 固定同一完整 SHA 下载清单和文件，备份、安装，再以新版客户端继续原操作。
- 客户端更新只读取公开仓库；不改变服务器只读 Git 部署身份、Webhook 验签或发布链路。保留清单路径校验、并发锁、完整下载后的备份、按目录原子重命名切换及失败恢复。更新失败时报告并继续使用现有版本，不宣称已更新，不重建已有请求。`wait`、`patch`、`ack` 不在同一交接中反复检查更新。
- 源码修改落在仓库内的 Skill、客户端与安装模板，不只修改用户安装副本。需要安装时运行 `npm run install:skills`；更新结果为 `updated:true` 时重读已安装说明。
- 替换旧 Skill 前备份到技能发现目录之外，默认 `~/.local/share/handover-ui/skill-backups/`。保留本地配置、请求 handle、游标及已有 `grill-with-docs-ui` 的组合能力。

## 数据与凭据

- 业务数据、实际登录码、Agent/Admin token、Webhook secret、部署私钥和 Web Push VAPID 私钥不进入源码、Skill、Git、命令参数或日志。通过受限文件或标准输入传递秘密值。
- 客户端 handle 默认在 `~/.local/state/handover-ui/requests/`，权限为 0600，旧 schema 1 包含每请求凭据，新 schema 2 保存固定用户名；不输出完整文件内容。临时数据和测试证据放在忽略目录或隔离临时目录。
- 旧登录码、Agent token、登录 session、票据及无用户名请求保留归档，不自动轮换、删除或迁移；所有旧登录/配对/票据 API 已停用，旧凭据不能在线访问归档请求。schema 1 handle 在联网和更新前报停用，不重复创建。
- 服务数据独立于 release 保存；Admin 与 VAPID 凭据由服务器环境变量提供，旧登录码/Agent 凭据仅保留归档，保留已有值，不因发布轮换。修改持久化时保持原子写入与故障恢复，兼顾并发请求；代码回滚不等于数据回滚，不自行引入破坏性迁移。

## 开发与验证

- 服务端和客户端使用 Node.js 22.11+；部署脚本使用 Python 3.12+。依赖以 `package-lock.json` 为准，安装使用 `npm ci --ignore-scripts`，远端服务启动使用 `npm start`。
- `npm test` 运行 Node 和 Python 回归测试；`npm run test:remote` 可聚焦远端协议。修改身份、认证、等待、幂等、事件确认、更新器或部署行为时，补充有意义的边界或故障测试。
- 网页、草稿、自动返回、登录跳转或通知导航有变化时运行 `npm run test:browser`；通过 `PLAYWRIGHT_PKG` 和 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有依赖与浏览器，具体示例见 `README.md`。
- 测试使用隔离目录和虚构来源，Skill 更新测试设置 `HANDOVER_SKIP_UPDATE=1` 或注入隔离的 GitHub 替身。不得向真实用户请求注入答案、消费真实待处理事件或改动实际凭据来做模拟测试。
- 纯文档修改核对事实、路径及差异即可，不为可逆的小改动增加镜像测试。交付时说明实际运行的验证及仍需真机验收的部分，不固定抄写历史测试数量。

## 发布与运维

- 仓库：`UnityX103/handover-ui-server`；发布分支为 `main`。提交标题和正文默认以简体中文为主，准确描述实际变更。
- 公网入口由服务器环境变量 `HANDOVER_PUBLIC_URL` 设置。保留既有公网端口 8024、内部应用端口 8025 和接收器端口 8032；不在项目文档中记录实际域名、服务器地址或秘密值。
- 443 的 `/handover/` 路径通过 `HANDOVER_PUBLIC_ALIASES` 显式登记，Nginx 使用 `deploy/nginx-path.conf` 保留前缀转发。网页、客户端链接、manifest 与 Service Worker 必须使用当前入口路径；原 8024 handle 继续原地址，不改来源身份或游标。
- 普通源码发布走 GitHub push webhook：校验签名、持久入队、只读拉取可信仓库的 `main`、在独立 release 测试、原子切换、健康检查，失败回滚。不要直接编辑运行中的 release 或用 SSH 拷贝代码替代这条发布链路。
- `/opt/handover-ui/current` 指向当前 release；数据在 `/var/lib/handover-ui`，受限配置在 `/etc/handover-ui/`。可信运维脚本与 systemd 配置需要显式维护，不假定应用 push 会替换这些文件。
- 发布验收同时核对 GitHub 目标完整 SHA、Webhook 投递结果、部署结果和公网 `/healthz` 的 `version`。Webhook 返回 202 只表示入队，本地提交或推送不代表部署成功。
- 仅操作本项目的服务和已确认的进程，保护其他服务器服务与持久数据。部署、端口、访问方式发生变化时同步 `docs/DEPLOYMENT.md`、相关 README，并按用户级规则更新仓库外的服务器端口记录。
- 交付说明结论优先，给出实际修改、验证、限制和必要链接；沿用用户当前任务的授权范围。
