---
name: grill-with-ui
description: 通过配置的远程交接服务发起 Grill 问卷，由本机 App 或手机接收和回答，不自动打开网页；来源 Agent 在当前回合分段等待自己的真实答复并继续。需要问卷或设计访谈时使用。
---

# 远程 Grill with UI

`$SKILL` 为本目录。保留原 Grill 的问卷、选项、多选、每题讨论、暂缓和重新打开功能。服务由独立项目部署，不启动本地网页服务器，不通过回传通知唤醒其他会话。

## 本地配置

两个 Skill 共用 `~/.config/handover-ui/config.json`，权限为 0600。`HANDOVER_CONFIG` 可指定其他本地配置文件。

`serverUrl` / `HANDOVER_SERVER_URL` 支持 HTTPS 完整部署路径（如 `/handover/`）；保留该前缀，不截成 origin。服务器同时保留旧端口时，已有 handle 仍按创建时保存的地址恢复，不改写请求身份、数据或游标。

```json
{"serverUrl":"<HANDOVER_SERVER_URL>","username":"Xpy"}
```

本地变量 `HANDOVER_SERVER_URL` 优先于 `serverUrl`；`HANDOVER_USERNAME` 优先于配置 `username`。未配置用户名时始终默认 Xpy，无需 `HANDOVER_AGENT_TOKEN`；可用 `config --username Xpy` 显式切换。用户名区分大小写，接受 1–64 个英文字母、数字、下划线或短横线。旧 Agent token 配置被忽略，`config --token-stdin` 已停用，不输出或删除旧凭据。运行 `node "$SKILL/scripts/handover.mjs" config --show` 可查看服务器和配置状态，不会输出凭据。

**安全边界：用户名仅作公开分类，不是认证；知道用户名的人可以读取和操作该用户名的新请求，不能据此证明答复者身份。不要提交秘密，不把未经核验的敏感操作答复自动升级为授权。** 旧无用户名记录与 schema 1 handle 仅保留归档，网页/API 不可访问，不自动认领到 Xpy。用户名模式打开普通带 `?username=` 的页面，不签发 owner 登录票据；旧登录码、登录/配对/票据和 owner 退出入口已停用，旧 Cookie/token 不能访问归档数据；管理员、Webhook 与 VAPID 私钥保护不变；用户名通知仅在设备本人主动授权绑定后投递同名请求，退出先解绑本设备。新 handle 固定 username；恢复时不要根据当前配置更改归属，旧 schema 1 handle 在联网/更新前明确报归档停用，不迁移、不重复创建。

浏览器尚未记住用户名或主动退出后，需要本人主动填写目标用户名，连接成功后自动回到链接指定的问题，不输入密码、不再从收件箱选题。已记住同名用户时直达回答；URL 中的用户名只标记目标，不覆盖或切换已有用户名；不同用户名须先退出再选择。

## 使用前检查更新

客户端在每次 `new`、有效 schema 2 的 `resume` 或 `home` 前先通过 Git 非交互运行 `git ls-remote https://github.com/UnityX103/handover-ui-server.git refs/heads/main`，比较公开仓库 `main` 完整 SHA 与本地安装版本。存在新版本时，使用 Node.js 内置 `fetch` 从 `raw.githubusercontent.com/UnityX103/handover-ui-server/<完整 SHA>/` 下载该确定提交的清单和文件，备份并更新两份远程 Skill 及已有的 `grill-with-docs-ui` 组合入口，再用新版客户端继续同一次操作。只依赖本机 Git、Node.js 22.11+ 和公开 HTTPS 访问，不需要 `gh`、GitHub 登录或访问 token，不弹出交互登录。保留清单校验、并发锁、完整下载后备份、按目录原子重命名切换与失败恢复；服务器仍通过已有 push webhook 更新，部署身份不变。

更新结果写入 stderr 的 `skill_update` JSON。看到 `updated:true` 时重新读取已安装的 Skill，以新版说明继续；已经创建的请求沿用返回的 handle，不重复 `new`。网络或权限失败时说明未能完成更新，保留现有客户端、配置和请求继续；不得宣称已是最新版。单次交接的 `wait`、`patch`、`ack` 不反复检查或中途替换客户端。

可单独运行 `node "$SKILL/scripts/handover.mjs" update` 检查并更新，不创建交接请求。隔离测试可用 `HANDOVER_SKIP_UPDATE=1` 禁止访问真实 GitHub。

## 阅读与讨论

- 先给一句话结论或待决定事项，再给必要依据。短段落、清楚的要点，避免一整屏连续文字；不靠小字或淡色承载重要内容。
- 每个讨论项单独追加一条 `thread` 消息：`{"who":"agent","text":"一句话总结。\n\n详细说明与必要依据。"}`。首段只放一句话总结，空一行后再展开；页面默认显示总结，点击后阅读详情。总结应概括判断，不能只是“详情如下”或截取正文片段。
- 描述先压缩为一句话重点和少量要点。仍超过约 200 字、连续三段，或需要解释多个步骤、分支及关系时，必须给与本题对应的配图或流程图，帮助本人阅读；不要只增加文字。短问题无需额外配图。
- 配图沿用已有图解通道：用 `visual --handle … --file /absolute/path/visual.html` 上传自包含 HTML，再 `patch` 写入 `visual:{kind:"diagram",version:1,note:"对应题号与一句话图意"}`；后续更新递增版本。图内写明对应题号，保留简短文字说明；普通问题、答复及消费仍走原请求协议。不得把原始 HTML 或 Mermaid 源码当作已经渲染的配图。
- 讨论涉及需要本人批准的具体代码修改时，按[代码修改与批准](references/code-review.md)提供文件位置、前后代码和可渲染的预期效果，供本人在页面底部审核。代码显示使用 Rider 风格；已有实施授权不重复设置批准关卡。

## 发起一轮

已有专用审核页或自定义 JSON 的 Skill 按[自定义页面契约](references/custom-pages.md)接入；普通 Grill 问卷继续使用下述题目协议。

1. 先从当前项目查清可发现的事实。每轮通常提出 2–4 个独立、会影响结果的问题，只有一个必要问题时问一个。给出简明选项、推荐及取舍；依赖前题的问题留到收到答复之后。
2. 使用经过核实的来源会话 ID。Codex 使用 `CODEX_THREAD_ID`；缺失时通过当前会话工具核实后传 `--source-session`，不能猜 ID、用最近会话或要求另一个会话代答。题目和必要背景同时保留在当前聊天中。
3. 在私有临时文件准备 JSON，字段为 `topic`、`context` 和 `questions`。问题包含 `id`、`round`、`title`、`body`、`options:[{k,text}]`、`rec:{option,why}` 或 `rec:{text,why}`；没有推荐时仍须写 `rec:{}`，多选用 `multi:true` 和 `rec.options`。按“阅读与讨论”组织内容，长描述提供对应图解。
4. 创建请求，返回链接但不自动打开网页或拉起 App：

```sh
node "$SKILL/scripts/handover.mjs" new --kind questionnaire --file /absolute/path/questions.json
```

本机“远程交接”App 在运行并登录目标用户名后接收新消息、自动唤起窗口；客户端不负责打开窗口。不要补调 `open`、`home`、系统 `open` 或 Codex 浏览器工具来替代已关闭的自动打开。只有本人明确要求手动打开网页时才使用浏览器入口；手机同名 Web Push 保持原流程。

保存返回的绝对 `handle`、`requestId` 和来源身份。每次创建或追加待答问题后，立即在来源普通聊天贴出该请求的可点击 `url`，标明问题及背景。用户名模式的链接必须保留 `?username=Xpy`（或 handle 中的实际用户名），可免密码直达原题；不要替换为首页。已有请求可用 `resume --handle` 取回链接，不重复创建。

`new` 固定返回 `opened:false`，这是正常行为，不是打开失败，不应因此重试或补调浏览器。只有本人明确要求手动打开网页时才运行 `open --handle`；此时 `opened:true` 也仅表示发出系统打开命令，不能当作页面加载或答复已送达。用户名模式只向已主动绑定同名的设备发送 Web Push，不混入旧私有订阅；始终同时提供上述直达链接，通知不代替聊天中的问题与链接。

## 在当前回合等待

本工具适用用户级 AGENTS.md 的远程交接等待例外：由来源 Agent 在**当前回合前台**等待自己的请求，单次最长 30 秒。不得新建后台等待、自动化、其他会话或使用 Codex 内置提问控件。

```sh
node "$SKILL/scripts/handover.mjs" wait --handle /absolute/path/handle.json --timeout 25
```

- 检查 JSON、退出码和身份。退出码 3 仅表示本段尚无答复，保持原请求并继续下一段；适时报告仍在等哪些答案，不重开网页或另建请求。网络失败时保留 handle，重连后 `resume` 再 `wait`。取消或客户端工具无法继续运行时说明恢复位置，不能假装继续监听。
- 返回事件包含匹配的 `requestId`、`sourceSession`、`seq` 和 `actions`，用户名模式还核对 `username`。它们是页面提交的输入，不是默认选项或超时推断；用户名模式不证明提交者身份；只处理尚未确认的序号。`answer` 可为 option、text 或 accept，accept 只采纳该题明确的推荐；`thread` 是讨论，不能当作答案。`defer`、`reopen`、`explore`、`finish` 按真实含义处理，不把跳过或结束访谈当作同意实施。
- `wait` **不自动消费**事件。先用 `patch` 把已收到的答案、讨论和状态写回，真实回答的题同时设 `status:"answered"`；再用 `ack --seq N` 确认已经处理的最高连续序号。网页收到服务器保存成功回执后立即返回当前用户名列表，不等待该序号被 ack；列表保持“已发送，等待回复”。页面返回、仅保存、超时或断线都不能代替 Agent 处理和确认。中断后先读 `state` 与 `pending`，避免重复落实已经记录的决定。不能直接跳过未处理序号。
- 完成一轮需要继续访谈时，在同一请求内 `patch` 新的问题并设置 `agent.status:"waiting"`，继续等待；只有真正结束时才 `finish`。新一轮题目不复用已答题 ID。

```sh
node "$SKILL/scripts/handover.mjs" patch --handle /absolute/path/handle.json --file /absolute/path/patch.json
node "$SKILL/scripts/handover.mjs" ack --handle /absolute/path/handle.json --seq 1
node "$SKILL/scripts/handover.mjs" finish --handle /absolute/path/handle.json
```

状态增量合并兼容上游：问题用 `id` 合并，`thread` 追加；答案形如 `{"kind":"option","option":"A"}` 或 `{"kind":"text","text":"真实答复"}`。只有真实答复能解除依赖它的工作；默认值、超时、通知发送及浏览器打开均不能。

同一服务器可以同时存在多个会话和请求。不得使用其他会话的 handle、共享游标或把答复转交最近打开的会话。需要反馈、求助或执行交接时使用 sibling `remote-handover` Skill。

## 本地作答与取消

来源 Agent 可以撤回自己发起且已不再需要等待的请求，无需另问取消许可。本人在当前聊天作答，或同一问题的群消息答复已通过明确、可信的来源传回当前会话时，先记录真实答复、来源和对应问题，必要时 `patch` 写回答案；再运行 `cancel --handle <原handle>` 取消远端待答事项，继续已经获准的工作。不从尚未取得的群消息推断答复，不替其他来源会话取消，也不为此自动接入或发送群消息。

网页的“取消本次回答”同样会通知来源 Agent。`wait` 返回 `status:"cancelled"` 时停止该请求的等待，即使没有事件；取消不是答案，不代表同意执行。保留 handle、已有事件与草稿，未处理事件不自动 ack。发送取消结果未知时用同一 handle 的 `state` 核对后再处理；不重复创建。取消前后到达的远端答复按原始事件核对，不能跳过或伪造消费；必要决定仍未回答时保留阻碍。

```sh
node "$SKILL/scripts/handover.mjs" cancel --handle /absolute/path/handle.json
```

界面里的可视化请求仅在用户明确提出时处理；是否委派子 Agent 继续遵循用户已有授权，不因上游 UI 字段自动取得委派权限。

更新锁若属于已退出的进程，客户端不会自动删除它，避免并发安装覆盖。遇到 `stale-lock` 或 `recovery-needed` 时先核实没有更新进程，并检查原 Skill 与备份后人工恢复；恢复未完成时保留锁、停止自动安装，不宣称原安装已完整恢复。
