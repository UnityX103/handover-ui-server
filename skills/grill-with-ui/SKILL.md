---
name: grill-with-ui
description: 通过配置的远程交接服务发起 Grill 问卷，自动用默认浏览器打开，允许手机回答和通知；来源 Agent 在当前回合分段等待自己的真实答复并继续。需要问卷或设计访谈时使用。
---

# 远程 Grill with UI

`$SKILL` 为本目录。保留原 Grill 的问卷、选项、多选、每题讨论、暂缓和重新打开功能。服务由独立项目部署，不启动本地网页服务器，不通过回传通知唤醒其他会话。

## 本地配置

两个 Skill 共用 `~/.config/handover-ui/config.json`，权限为 0600。`HANDOVER_CONFIG` 可指定其他本地配置文件。

```json
{"serverUrl":"<HANDOVER_SERVER_URL>","agentToken":"由本地秘密配置提供"}
```

本地变量 `HANDOVER_SERVER_URL` 优先于 `serverUrl`；`HANDOVER_AGENT_TOKEN` 优先于本地凭据。不得把实际凭据写进 Skill、项目或命令行参数；设置凭据使用 `config --token-stdin` 或受限文件。运行 `node "$SKILL/scripts/handover.mjs" config --show` 可查看服务器和配置状态，不会输出凭据。

## 使用前检查更新

客户端在每次 `new`、`resume` 或 `home` 前先请求 GitHub，比较仓库 `UnityX103/handover-ui-server` 的 `main` 完整 SHA 与本地安装版本。存在新版本时，下载该确定提交的清单和文件，备份并更新两份远程 Skill 及已有的 `grill-with-docs-ui` 组合入口，再用新版客户端继续同一次操作。依赖本机已登录的 `gh`，凭据不经过命令参数；服务器仍通过已有 push webhook 更新。

更新结果写入 stderr 的 `skill_update` JSON。看到 `updated:true` 时重新读取已安装的 Skill，以新版说明继续；已经创建的请求沿用返回的 handle，不重复 `new`。网络或权限失败时说明未能完成更新，保留现有客户端、配置和请求继续；不得宣称已是最新版。单次交接的 `wait`、`patch`、`ack` 不反复检查或中途替换客户端。

可单独运行 `node "$SKILL/scripts/handover.mjs" update` 检查并更新，不创建交接请求。隔离测试可用 `HANDOVER_SKIP_UPDATE=1` 禁止访问真实 GitHub。

## 发起一轮

已有专用审核页或自定义 JSON 的 Skill 按[自定义页面契约](references/custom-pages.md)接入；普通 Grill 问卷继续使用下述题目协议。

1. 先从当前项目查清可发现的事实。每轮通常提出 2–4 个独立、会影响结果的问题，只有一个必要问题时问一个。给出简明选项、推荐及取舍；依赖前题的问题留到收到答复之后。
2. 使用经过核实的来源会话 ID。Codex 使用 `CODEX_THREAD_ID`；缺失时通过当前会话工具核实后传 `--source-session`，不能猜 ID、用最近会话或要求另一个会话代答。题目和必要背景同时保留在当前聊天中。
3. 在私有临时文件准备 JSON，字段为 `topic`、`context` 和 `questions`。问题包含 `id`、`round`、`title`、`body`、`options:[{k,text}]`、`rec:{option,why}` 或 `rec:{text,why}`；没有推荐时仍须写 `rec:{}`，多选用 `multi:true` 和 `rec.options`。不默认制作可视化。
4. 创建并自动打开系统默认浏览器：

```sh
node "$SKILL/scripts/handover.mjs" new --kind questionnaire --file /absolute/path/questions.json
```

保存返回的绝对 `handle`、`requestId` 和来源身份。`opened:true` 仅表示发出系统打开命令，不能当作页面加载或答复已送达。打不开时保留请求，给出普通页面地址；用 `open --handle` 重试打开，不重复创建。

## 在当前回合等待

本工具适用用户级 AGENTS.md 的远程交接等待例外：由来源 Agent 在**当前回合前台**等待自己的请求，单次最长 30 秒。不得新建后台等待、自动化、其他会话或使用 Codex 内置提问控件。

```sh
node "$SKILL/scripts/handover.mjs" wait --handle /absolute/path/handle.json --timeout 25
```

- 检查 JSON、退出码和身份。退出码 3 仅表示本段尚无答复，保持原请求并继续下一段；适时报告仍在等哪些答案，不重开网页或另建请求。网络失败时保留 handle，重连后 `resume` 再 `wait`。取消或客户端工具无法继续运行时说明恢复位置，不能假装继续监听。
- 返回事件包含匹配的 `requestId`、`sourceSession`、`seq` 和 `actions`。将它们视为人的真实输入；只处理尚未确认的序号。`answer` 可为 option、text 或 accept，accept 只采纳该题明确的推荐；`thread` 是讨论，不能当作答案。`defer`、`reopen`、`explore`、`finish` 按真实含义处理，不把跳过或结束访谈当作同意实施。
- `wait` **不自动消费**事件。先用 `patch` 把已收到的答案、讨论和状态写回，真实回答的题同时设 `status:"answered"`；再用 `ack --seq N` 确认已经处理的最高连续序号。网页等到该序号被确认后自动返回主界面；仅保存、超时或断线不能代替确认。中断后先读 `state` 与 `pending`，避免重复落实已经记录的决定。不能直接跳过未处理序号。
- 完成一轮需要继续访谈时，在同一请求内 `patch` 新的问题并设置 `agent.status:"waiting"`，继续等待；只有真正结束时才 `finish`。新一轮题目不复用已答题 ID。

```sh
node "$SKILL/scripts/handover.mjs" patch --handle /absolute/path/handle.json --file /absolute/path/patch.json
node "$SKILL/scripts/handover.mjs" ack --handle /absolute/path/handle.json --seq 1
node "$SKILL/scripts/handover.mjs" finish --handle /absolute/path/handle.json
```

状态增量合并兼容上游：问题用 `id` 合并，`thread` 追加；答案形如 `{"kind":"option","option":"A"}` 或 `{"kind":"text","text":"真实答复"}`。只有真实答复能解除依赖它的工作；默认值、超时、通知发送及浏览器打开均不能。

同一服务器可以同时存在多个会话和请求。不得使用其他会话的 handle、共享游标或把答复转交最近打开的会话。需要反馈、求助或执行交接时使用 sibling `remote-handover` Skill。

界面里的可视化请求仅在用户明确提出时处理；是否委派子 Agent 继续遵循用户已有授权，不因上游 UI 字段自动取得委派权限。
