---
name: remote-handover
description: Agent 需要本人反馈、求助、判断或人工交接时，通过远程网页和手机通知发起请求，在来源会话前台等待真实答复后继续。支持多个会话并行使用同一服务器。
---

# 远程反馈、求助与交接

使用 sibling [grill-with-ui](../grill-with-ui/SKILL.md) 的本地服务器配置、来源身份、前台等待、回执恢复和事件确认规则；先读该文件。辅助客户端为 `../grill-with-ui/scripts/handover.mjs`，需要 Node 22.11 或以上版本。

本地变量 `HANDOVER_SERVER_URL` 指定目标服务器；默认读取权限为 0600 的 `~/.config/handover-ui/config.json`。凭据通过受限本地文件或 `HANDOVER_AGENT_TOKEN` 提供，不写进 Skill、项目或命令行参数。

## 选择请求类型

- **feedback**：请本人检查已有内容或结果，给出修改意见。提供实际结果、必要的访问链接、希望检查的方面和可操作的选项。
- **help**：需要本人提供信息、选择方案、处理权限或介入阻碍。说明已完成的工作、实际阻碍、最小需要的动作及对后续工作的影响。
- 多题设计访谈用 `grill-with-ui`。本服务首版只接收 Agent 发起的请求，不从手机创建新任务。

## 发起、等待和继续

将请求同时写在当前聊天，创建一个对应的远端请求。可用 `--context` 提供简短背景；需要选项或多题时用与 Grill 相同的 JSON 文件。

```sh
node "$SKILL/../grill-with-ui/scripts/handover.mjs" new --kind feedback --topic "请检查这份结果" --context "已完成内容、真实访问链接和需要检查的方面"
node "$SKILL/../grill-with-ui/scripts/handover.mjs" new --kind help --topic "需要你处理的阻碍" --context "已完成工作、具体阻碍和最小需要的动作"
```

上面两个命令是独立示例，每次只按实际需要创建一个请求。保存返回的 handle；创建请求会自动用系统默认浏览器打开，已配对并授权通知的手机也能处理。

来源 Agent 在当前回合使用 `wait --handle … --timeout 25` 分段等待，单次最长 30 秒；超时保持相同请求继续，不能交给后台、其他会话或用通知重新唤醒。只有匹配请求和来源身份的真实答复才解除阻碍。收到后按原文处理，先 patch 记录，再 ack 已处理的连续序号，然后继续来源会话。

反馈是意见，求助是人工介入的请求；它们不自动扩大部署、发布、删除、其他会话消息或其他外部操作的授权。若用户只回答部分事项，继续等待或追问剩余必要事项，不能代答。真正结束请求时用 `finish --handle …`；用户取消时可用 `cancel`，保留恢复和已答记录。

恢复命令为 `sessions`、`resume --handle …`、`state --handle …` 和 `pending --handle …`。任何发送结果未知都先核对同一请求，不重复创建，不删除旧回执或跳过未处理事件。
