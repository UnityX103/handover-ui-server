# 标准页的代码修改与批准

需要本人批准具体改码方案时，在对应问题的 `codeReview` 提供修改片段。先展示已能渲染的预期效果，再让本人批准这个版本；已有实施授权继续有效，不为所有代码修改额外设置确认关卡。没有改码内容的普通问题不添加此区域。

先用客户端 `probe` 核对服务器的 `codeReview.version` 为 1。不支持时保留本地代码与效果草稿并说明能力缺口，不把普通页面打开或一般选项当作版本批准。

```json
{
  "questions": [{
    "id": "q1",
    "codeReview": {
      "id": "readable-question-body",
      "revision": 1,
      "summary": "放大重要说明并增加行距。",
      "files": [{
        "path": "/absolute/project/web/grill.css",
        "summary": "覆盖正文的固定小字号。",
        "startLine": 65,
        "language": "css",
        "before": ".body { font-size: 15px; }",
        "after": ".body { font-size: 22px; line-height: 1.9; }"
      }],
      "expected": {
        "summary": "说明文字放大，行间留白增加。",
        "html": "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'><style>body{font:22px/1.9 system-ui}</style></head><body>预期的问题说明排版。</body></html>"
      }
    }
  }]
}
```

- 支持创建时与 `patch` 时提供；`id` 使用 1–100 个英文字母、数字、下划线或短横线，`revision` 从 1 开始递增。修改代码、说明或效果 HTML 时递增版本，不能沿用旧批准。
- `files` 提供核实过的项目路径、起始行号、修改原因及真实的前后片段。最多 12 个文件，代码合计不超过 200 KB；语言支持 `css`、`html`、`javascript`、`typescript`、`csharp`、`json`、`python`、`text`。不把未经核实的片段写成现有代码。
- 能渲染效果时提供 `expected:{summary,html}`，HTML 自包含且不超过 500 KB。用真实样式或实际运行证据制作；示意预览在说明中标明，不把它冒充运行验收。页面以独立沙箱展示，不能访问父页面、请求、Cookie 或网络接口。不能渲染的逻辑修改省略 `expected`，改用简短的行为前后例子。
- 服务生成 `digest` 绑定文件、代码和效果。网页底部显示 Rider 风格代码、行号和修改前后内容；本人点击“批准并发送”或“需要调整”后，通过原请求发送 `type:"answer",kind:"text"`，其 `review` 字段含 `id`、`revision`、`digest` 与 `decision:"approve"|"revise"`。发送失败保留暂存内容；新版本拒绝旧版本决定。
- 来源 Agent 收到事件后核对请求、来源及版本，只按具体批准范围继续。`approve` 仅批准展示的修改，不自动批准部署、发布、删除或其他会话的操作。没有 `review` 的普通答复、讨论及截图预览不构成这项版本批准。服务器保存/ack 也不等于代码已经修改。
- 沿用原有 patch/ack 流程记录真实答复及其 `review`，题目设为 `answered` 后确认已处理的连续序号；回执与本次任务的授权范围保持不变。
