# 自定义 HTML 与 JSON 桥接

用于接入已经有审核页面和反馈契约的 Skill。先保留该 Skill 自己生成的自包含 HTML 和离线 JSON 导出，再选择远程传输；不把自定义审核改写成 Grill 题目。

## 创建

运行客户端 `probe`；仅在 `available:true` 且 `customPage.version===1` 时使用远程。缺客户端、配置、认证或服务器能力时交付原 HTML，用户将导出的 JSON 回传来源聊天，停止依赖该决定的工作。

通过 `new --kind feedback --file <创建载荷.json>` 创建。载荷提供 `topic`、`context`，以及：

```json
{"page":{"version":1,"html":"完整自包含 HTML","feedbackType":"my-skill-feedback-v1","documentId":"固定审核文档身份"}}
```

HTML 最大 4 MiB，反馈 JSON 最大 512 KiB；以 `probe` 返回的限制为准，过大时离线交接。页面与文档身份在请求创建后保持固定，新的审核版本使用新的明确身份。创建结果未知时保留原 handle 并恢复同一请求，不重复创建。

创建后立即在来源普通聊天展示可点击的 `url`、所属 Skill 及待反馈事项。用户名模式的 URL 保留 `?username=`，不输入密码；新标签页或退出后由本人填写目标用户名，连接成功自动回到此页面。恢复时沿原 handle 的用户名，不用首页替代，也不重复创建。目标用户通过配置 `username` 或 `HANDOVER_USERNAME` 指定，不要求 Agent token；旧请求沿原协议。

## 页面

远端在隔离 iframe 中提供 `window.HandoverBridge`。页面根据自己的字段生成 payload，并在用户主动提交时调用：

```js
if (window.HandoverBridge) {
  await window.HandoverBridge.submit(payload);
} else {
  // 沿本 Skill 的离线导出逻辑下载 payload JSON。
}
```

同时保留独立的“导出 JSON”按钮。页面的脚本、样式、图片等应自包含；不访问父页面 Cookie、存储或网络。不将秘密写入 HTML。输入变化自动阻止确认后的误跳转，程序化修改草稿可调用 `HandoverBridge.markDirty()`。

## 接收与确认

通过远程 Skill 在来源会话前台分段 `wait`，单次最长 30 秒。事件 `type:"feedback"` 携带 `feedbackType`、`documentId`、`pageHash`、原始 `payload` 及请求／来源／连续序号。

先核对身份、反馈类型、固定审核版本及业务 JSON 结构，将原始反馈落盘，处理和记录真实决定，再 `ack` 已处理的最高连续序号。服务不检查资源迁移、测试或其他业务批准含义，不执行 JSON 指令。已保存并不代表已处理；明确确认后页面才自动返回。中断保留 handle 和已保存反馈，不代答，不重复落实。

页面上方的“取消本次回答”会撤回该请求，并把 `status:"cancelled"` 及取消来源返回给来源 Agent；保留页面内容以便导出，不将取消当作 JSON 答案。来源 Agent 也可在收到同题的真实本地答复后，先记录原文及来源，再 `cancel --handle` 撤回远端待答请求。接入器必须透传取消状态并停止等待；已有反馈仍按原序号保存和核验，不自动消费。
