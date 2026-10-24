# 华为个人部署交接

## 实际位置

| 配置 | 值 |
| --- | --- |
| 主机 | 华为个人 `113.46.152.120` / `hcss-ecs-4b3a` |
| 公网入口 | https://server.nanzhaigame.cn:8024/ |
| 健康与版本 | https://server.nanzhaigame.cn:8024/healthz |
| 私有仓库 / 分支 | https://github.com/UnityX103/handover-ui-server / `main` |
| GitHub Webhook | https://server.nanzhaigame.cn:8024/hooks/github，仅 POST |
| 应用内部端口 | `127.0.0.1:8025` |
| 接收器内部端口 | `127.0.0.1:8032` |
| 代码 / 当前版本 | `/opt/handover-ui/releases/<完整 SHA>` / `/opt/handover-ui/current` |
| 只读远端 | `/opt/handover-ui/repo.git`，独立只读 deploy key 经 `ssh.github.com:443` |
| 数据 | `/var/lib/handover-ui`；每请求状态与事件同文件原子保存，独立于版本 |
| 服务 | `handover-ui.service`、`handover-ui-hook.service` |
| 部署触发 | `handover-ui-deploy.path` → `handover-ui-deploy.service` |
| Nginx | `/etc/nginx/conf.d/handover-ui.conf`；复用已有域名证书 |

## 凭据来源

服务器 `/etc/handover-ui/service.env`（root:root 0600）保存应用配置、`HANDOVER_AGENT_TOKEN` 和独立的 `HANDOVER_ADMIN_TOKEN`。`/etc/handover-ui/webhook.secret`（root:handover-hook 0640）与 GitHub 仓库的 Webhook secret 同步；轮换时必须同时修改两端。

部署配置 `/etc/handover-ui/deploy.json` 固定仓库、分支、端口与服务；只读部署私钥 `/etc/handover-ui/deploy_key` 仅 root 可读。Web Push VAPID 密钥在 `/var/lib/handover-ui/vapid.json`，应与数据一同备份。普通版本更新不重新生成这些文件。

Mac Agent 配置在 `~/.config/handover-ui/config.json`（0600）；客户端 handle 在 `~/.local/state/handover-ui/requests/`。不在日志、Git 或交接消息中显示秘密值。手机登录码从已登录桌面网页生成。

## 推送后怎样查看

1. 登录 GitHub，打开私有仓库，选择 `main`，核对最新提交；源码配置见 [deploy](https://github.com/UnityX103/handover-ui-server/tree/main/deploy)。本项目使用 GitHub 原生 Webhook，没有通知流水线 YML。
2. 打开 [Settings → Webhooks](https://github.com/UnityX103/handover-ui-server/settings/hooks)，选择指向 `:8024/hooks/github` 的钩子。在 Recent Deliveries 找到这次 `push`，检查请求 `ref` 为 `refs/heads/main`、`after` 为目标完整 SHA；响应应为 HTTP 202 和 `queued:true`。重复投递返回 `duplicate:true`。
3. 接收成功只代表入队。服务器运行 `systemctl status handover-ui-deploy.service --no-pager` 与 `journalctl -u handover-ui-deploy.service -n 60 --no-pager` 检查测试、发布和健康检查；结果在 `/opt/handover-ui/deployment.json`，每次投递结果在 `/var/lib/handover-ui-deploy/results/`。
4. 打开公网 `/healthz`，应返回 `ok:true`、`service:"handover-ui"`，`version` 必须等于 `main` 的目标完整 SHA。网页页脚显示短 SHA，刷新后核对。然后打开业务入口验证。

服务器固定从可信 origin 的当前 `main` 发布，构建期间有新提交会重新准备最新版本；旧推送或重放不能把当前版本降回旧提交。同一已失败 SHA 不会因重复投递无限重试。队列和 receipt 落盘后才确认接收；GitHub 投递 ID 用于持久去重。

## 故障与回滚

```sh
systemctl status handover-ui handover-ui-hook handover-ui-deploy.path --no-pager
journalctl -u handover-ui -n 40 --no-pager
journalctl -u handover-ui-hook -n 40 --no-pager
journalctl -u handover-ui-deploy -n 80 --no-pager
curl --fail http://127.0.0.1:8025/healthz
cat /opt/handover-ui/deployment.json
```

依赖安装与测试在新 release 以无特权应用账号执行，完成后代码归 root，只允许应用写独立数据目录。仅本服务重启；健康失败自动切回此前 release 并核对旧版本健康。首次安装没有旧版本时保留失败证据并停止应用。

业务代码修复并推送新的 SHA 是默认恢复路径。确需人工重试相同失败 SHA 时，运维先排除故障，再在受限配置中清除 `failed_sha` 并重新排队，不能无限循环重启。人工回滚先检查目标是已通过测试的 release，用临时 symlink 原子替换 `current`，重启 `handover-ui.service` 并核对目标 `/healthz`；不修改数据和其他服务。后续推送仍以仓库 `main` 为准，因此需要长期保留旧版时应在仓库提交 revert。

首装使用 `deploy/bootstrap.py` 的 prepare / activate 两阶段：服务器产生密钥 → GitHub 注册只读公钥 → 推送初始提交 → 安装固定运维脚本、服务和 Nginx → 初始发布 → 配置签名 Webhook。仅首装用 SSH；后续源码推送由服务器自行拉取，运维脚本与 systemd 配置由有权限的运维显式维护。

此项目不迁移破坏性数据库结构，代码和业务 JSON 分离；未来若增加不兼容的数据迁移，需要另外设计数据恢复方案，不能把代码回滚视为数据回滚。
