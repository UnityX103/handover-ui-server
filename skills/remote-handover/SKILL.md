---
name: remote-handover
description: Agent 需要本人反馈、求助、判断或人工交接时，通过远程网页和手机通知发起请求，在来源会话前台等待真实答复后继续。支持多个会话并行使用同一服务器。
---

# 远程反馈、求助与交接

使用 sibling [grill-with-ui](../grill-with-ui/SKILL.md) 的本地服务器配置、来源身份、前台等待、回执恢复和事件确认规则；先读该文件。辅助客户端为 `../grill-with-ui/scripts/handover.mjs`，需要 Node 22.11 或以上版本。

每次发起或恢复交接时，共用客户端先检查 GitHub `UnityX103/handover-ui-server` 的 `main`，有新版本则备份并更新两份远程 Skill 后继续。本机需有已登录的 `gh`；检查失败时说明并保留现有版本，不重建已有请求。更新显示 `updated:true` 时重读已安装说明；完整行为见 sibling 的“使用前检查更新”。

本地变量 `HANDOVER_SERVER_URL` 指定目标服务器；默认读取权限为 0600 的 `~/.config/handover-ui/config.json`。目标用户通过配置 `username` 或 `HANDOVER_USERNAME` 提供，无旧凭据时默认 `Xpy`，无需 Agent token。用户名只是公开分类，不是认证；任何知道用户名的人可能读取或操作其新请求，不能证明答复者身份。旧记录保持原凭据保护，已有 handle 不随配置变化而改归属。

## 选择请求类型

已经拥有自己的 HTML 审核页面和 JSON 数据格式时，按 sibling 的[自定义页面契约](../grill-with-ui/references/custom-pages.md)接入。先探测能力，远程不可用时保留原 HTML／JSON；收到 `type:"feedback"` 后校验并记录原始 `payload`，再确认消费，不将其当作普通选项答案。

- **feedback**：请本人检查已有内容或结果，给出修改意见。提供实际结果、必要的访问链接、希望检查的方面和可操作的选项。
- **help**：需要本人提供信息、选择方案、处理权限或介入阻碍。说明已完成的工作、实际阻碍、最小需要的动作及对后续工作的影响。
- 多题设计访谈用 `grill-with-ui`。本服务首版只接收 Agent 发起的请求，不从手机创建新任务。

## 发起、等待和继续

将请求同时写在当前聊天，创建一个对应的远端请求。可用 `--context` 提供简短背景；需要选项或多题时用与 Grill 相同的 JSON 文件。

```sh
node "$SKILL/../grill-with-ui/scripts/handover.mjs" new --kind feedback --topic "请检查这份结果" --context "已完成内容、真实访问链接和需要检查的方面"
node "$SKILL/../grill-with-ui/scripts/handover.mjs" new --kind help --topic "需要你处理的阻碍" --context "已完成工作、具体阻碍和最小需要的动作"
```

上面两个命令是独立示例，每次只按实际需要创建一个请求。保存返回的 handle；创建请求会自动用系统默认浏览器打开。每次创建或追加待答事项后，立即在来源普通聊天贴出请求的可点击 `url`，同时保留问题与背景；用户名模式保留链接中的 `?username=`，无需密码。新标签页或退出后由本人填写目标用户名，连接成功自动回到原问题。不要只给首页，也不为取链接重新创建请求。用户名模式通过链接在手机处理，并仅向本人主动绑定同名的设备发送 Web Push；旧私有订阅独立，通知不代替聊天中的问题与链接。

来源 Agent 在当前回合使用 `wait --handle … --timeout 25` 分段等待，单次最长 30 秒；超时保持相同请求继续，不能交给后台、其他会话或用通知重新唤醒。只有匹配请求和来源身份的真实答复才解除阻碍。收到后按原文处理，先 patch 记录，再 ack 已处理的连续序号，然后继续来源会话。网页在该答复被确认后自动返回主界面；通知直接打开对应请求，必要登录后也回到原题。

反馈是意见，求助是人工介入的请求；它们不自动扩大部署、发布、删除、其他会话消息或其他外部操作的授权。若用户只回答部分事项，继续等待或追问剩余必要事项，不能代答。真正结束请求时用 `finish --handle …`；用户取消时可用 `cancel`，保留恢复和已答记录。

恢复命令为 `sessions`、`resume --handle …`、`state --handle …` 和 `pending --handle …`。任何发送结果未知都先核对同一请求，不重复创建，不删除旧回执或跳过未处理事件。
