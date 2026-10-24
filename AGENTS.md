# 远程交接服务

- 先读 `CONTEXT.md`。本项目从 `jasonku09/grill-with-ui` 派生；原始问卷的 `page.html`、`server.mjs` 和测试保留在根目录。
- 远端服务入口为 `src/server.mjs`；客户端为 `skills/grill-with-ui/scripts/handover.mjs`。业务数据、登录凭据和推送密钥不进入仓库。
- `npm test` 验证上游兼容性和远端协议。修改等待、身份、认证或事件消费时补充有意义的协议测试；不得用真实用户回答做模拟测试。
- 等待仅限当前来源会话自己的请求，每次最长 30 秒。`wait` 读取不自动确认消费；处理真实答复后再 `ack`，中断时保留 handle。
- 发布分支 `main`。普通部署由 GitHub push webhook 触发服务器拉取确定提交，使用独立 release、健康检查和回滚；不能直接编辑运行中的 release。
- 新服务部署后同步更新用户的华为云端口配置记录。不得改动服务器无关服务。
- 新 Skill 的源码在 `skills/`，通过 `npm run install:skills` 安装；替换前把旧版备份到技能发现目录之外。
