# 部署与运维

实际域名、服务器地址和秘密值仅保存在服务器及仓库外的运维记录，不放入项目文档。部署分支为 `main`。

## 环境配置

应用通过 systemd 的 `EnvironmentFile` 注入配置；参考根目录 `.env.example` 的变量名。`.env.example` 不含可用凭据，也不由应用自动载入。

- `HANDOVER_PUBLIC_URL`：实际 HTTPS 站点入口，监听公网端口 8024。
- `HANDOVER_HOST`、`HANDOVER_PORT`：内部应用监听地址及端口，默认回环 8025。
- `HANDOVER_AGENT_TOKEN`、`HANDOVER_ADMIN_TOKEN`：不同的独立随机凭据。
- `HANDOVER_LOGIN_CODE`：本人固定登录码，长期有效、不自动轮换。
- `HANDOVER_VAPID_PUBLIC_KEY`、`HANDOVER_VAPID_PRIVATE_KEY`、`HANDOVER_VAPID_SUBJECT`：沿用现有推送身份，公私钥必须成对设置。
- `HANDOVER_DATA_DIR`：独立于 release 的持久数据目录。
- 接收器由独立的受限环境文件注入 `HANDOVER_WEBHOOK_SECRET`，与 GitHub Webhook 配置保持相同。

环境文件在仓库外保存，权限 0600，由 systemd 读取。更新、重启和 Skill 替换保留原值、浏览器登录和通知订阅。旧数据目录中的固定码与 VAPID 文件只用于兼容旧安装，环境变量优先；迁移时使用现有值，不重新生成。只读 Git 部署身份也在仓库外维护。

## 发布与验收

1. GitHub `main` push 触发原生 Webhook。地址为 `HANDOVER_PUBLIC_URL` 加 `/hooks/github`，只接收带正确签名的 POST。
2. 在仓库 Settings → Webhooks → Recent Deliveries 核对 `refs/heads/main`、目标完整 SHA 与 HTTP 202；202 只代表持久入队。
3. `handover-ui-deploy.path` 启动 `handover-ui-deploy.service`，从可信仓库当前 `main` 准备独立 release、安装依赖、测试、原子切换并检查健康。失败回滚，同一失败 SHA 不因重投无限重试。
4. 核对 `/opt/handover-ui/deployment.json` 与公网 `/healthz` 的 `version` 都等于目标完整 SHA，再检查业务入口；不能以流水线开始或单项绿灯代替发布成功。

应用入口为 `/opt/handover-ui/current`，历史 release 在同级 `releases/`，运维脚本在 `ops/`。持久数据与配置不随 release 切换。普通源码更新只走 push 链路，不直接编辑在线 release。可信运维脚本与 systemd 配置需要显式维护。

## 日志与回滚

```sh
systemctl status handover-ui handover-ui-hook handover-ui-deploy.path --no-pager
journalctl -u handover-ui -n 40 --no-pager
journalctl -u handover-ui-hook -n 40 --no-pager
journalctl -u handover-ui-deploy -n 80 --no-pager
cat /opt/handover-ui/deployment.json
```

默认通过提交修复恢复服务。人工回滚只选择已经通过验证的 release，原子切换 `current`，仅重启本服务，核对目标版本健康；长期保留旧行为应在仓库提交 revert。代码回滚不恢复业务数据，不自行执行破坏性数据迁移。

首次安装使用 `deploy/bootstrap.py`；实际 HTTPS 入口经环境变量传入，Nginx 模板在安装时渲染，不记录具体部署域名。部署或访问配置有变动时，按用户级规则更新仓库外的端口记录。

## 手机与 Skill

Skill 在 `new`、`resume`、`home` 前检查仓库 `main`，按确定提交备份、更新后继续。它只更新本机 Skill，服务器仍使用 push webhook 发布。

手机访问同一入口并添加到主屏幕，开启通知由本人在设备上授权。通知跳转保持请求身份；提交须等来源 Agent 确认后才返回主界面。真实系统通知与安装需真机验收，不能用浏览器模拟结果代替。
