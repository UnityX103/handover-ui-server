# 部署与运维

实际域名、服务器地址和秘密值仅保存在服务器及仓库外的运维记录，不放入项目文档。部署分支为 `main`。

## 环境配置

应用通过 systemd 的 `EnvironmentFile` 注入配置；参考根目录 `.env.example` 的变量名。`.env.example` 不含可用凭据，也不由应用自动载入。

- `HANDOVER_PUBLIC_URL`：实际 HTTPS 站点入口，监听公网端口 8024。
- `HANDOVER_PUBLIC_ALIASES`：可选的其他完整 HTTPS 入口，多个用逗号分隔，支持 `/handover/` 这样的部署路径。仅列出的 Host 和路径会被接受；内部回环 `/healthz` 继续供发布检查使用。
- `HANDOVER_HOST`、`HANDOVER_PORT`：内部应用监听地址及端口，默认回环 8025。
- `HANDOVER_ADMIN_TOKEN`：仍必需的独立随机管理凭据（至少 32 字符）。
- `HANDOVER_AGENT_TOKEN`：已停用，客户端不使用该值；已有受限环境配置保留归档，不作为用户名，不删除或轮换。
- 客户端 `HANDOVER_USERNAME=Xpy` 或配置 `username` 选择目标用户，未配置时默认 Xpy；用户名区分大小写，仅为路由分类，不是认证。知道用户名的人可以读取和操作该用户名的新请求。旧记录不迁移、不公开；用户名模式不能取得 owner 登录票据、固定登录码或管理权限，通知仅向主动绑定同名的设备发送，不混入旧私有订阅。复用现有 VAPID 身份，不新增或轮换应用凭据。
- `HANDOVER_LOGIN_CODE`：旧登录入口已停用；现有值仅留存，不删除或轮换。
- `HANDOVER_VAPID_PUBLIC_KEY`、`HANDOVER_VAPID_PRIVATE_KEY`、`HANDOVER_VAPID_SUBJECT`：沿用现有推送身份，公私钥必须成对设置。
- `HANDOVER_DATA_DIR`：独立于 release 的持久数据目录。
- 接收器由独立的受限环境文件注入 `HANDOVER_WEBHOOK_SECRET`，与 GitHub Webhook 配置保持相同。

环境文件在仓库外保存，权限 0600，由 systemd 读取。更新、重启和 Skill 替换保留原值和存储文件。旧 Cookie、登录 session、票据、登录码和无用户名请求不再授予在线访问；`/api/login*`、配对、browser-tickets、owner logout 等退休入口返回 410。旧请求保持归档，不自动绑定或公开为 Xpy，不因客户端恢复而复制。旧推送订阅仅在该设备主动授权并提供完整 endpoint/keys 证明时可改绑；不能枚举或接管其他设备。VAPID 继续沿用现有值，不重新生成。只读 Git 部署身份也在仓库外维护。

可选通知桥接的 `HANDOVER_NOTIFY_*` 配置与系统用户权限见 [通知桥接契约](notification-bridge.md)。默认 `HANDOVER_NOTIFY_ENABLED=0`，不启动出站扫描或连接 Bot socket；启用状态以仓库外受限配置为准。先发布并确认 Bot 健康，再发布交接服务，由协调侧统一配置系统权限并启用两端；目标侧不并发修改这些配置。不新增网络监听端口，也不改 Web Push、Webhook 或原有凭据。验收不创建真实问题或发送测试微信。

全访客自动通知须两端显式启用：目标侧配置 `HANDOVER_NOTIFY_SOURCES=*`、`HANDOVER_NOTIFY_USERNAMES=*`，Bot 配置 `visitor_policy="all"`、`auto_approve=true`。各名单仅允许单独的 `*` 或原有精确名单，不能混用。先在原单来源配置下发布支持新模式的两端版本并确认健康，再由协调侧统一更新仓库外配置、重启所属服务；仅扩大目标名单不会自动解除 Bot 的待批准状态。自动放行只接收可信同机交接应用的通知，发送给既有绑定微信用户，保留固定站点、请求/来源/用户名格式、去重和限流，不开放任意联系人或业务执行。全来源模式支持服务已有的合法请求 ID 及安全文本来源，精确来源模式仍要求 UUID。该变更只覆盖未来真实新建、追加及 Agent 真正重开的待答事项，不扫描历史请求补发，也不重放 `unknown`。

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

### 现有 443 反向代理的路径入口

在已存在的 HTTPS 443 `server` 中包含 `deploy/nginx-path.conf`，不要覆盖该虚拟主机的其他 location。它将 `/handover/` 原样代理到回环应用 8025，专用 Webhook 路径转到 8032；不使用删除前缀的 `proxy_pass`。把含 `/handover/` 的实际完整地址加入服务器受限环境文件的 `HANDOVER_PUBLIC_ALIASES`，验证 `nginx -t` 后 reload，仅重启本应用加载环境。

入口启用后，把客户端配置 `serverUrl` / `HANDOVER_SERVER_URL` 设置为完整路径地址。客户端生成的问题链接、返回列表、静态资源、manifest、Service Worker 与通知都保留前缀。既有 8024 handle 继续原地址并访问相同数据，不改写来源或游标；GitHub 已有 8024 Webhook 继续使用，不必改动。

发布时先上线支持子路径的应用，再启用别名与 Nginx 路由。保留外部环境与 Nginx 备份；失败恢复这些配置，不回滚数据。核对新入口的 `/handover/healthz`、页面及资源、用户名 API、问题链接与 PWA scope，同时检查 8024 原入口和 443 其他路径。

端口改变会形成新的浏览器 origin；原 8024 的用户名记忆、PWA 安装和通知订阅仍属于原入口。使用新 443 地址时需在手机重新选择用户名、添加到桌面并主动开启通知，沿用原 VAPID 密钥；不自动搬移订阅或申请权限。

Skill 在 `new`、有效 schema 2 的 `resume`、`home` 前，用本机 Git 非交互运行 `git ls-remote https://github.com/UnityX103/handover-ui-server.git refs/heads/main` 取得公开仓库完整 SHA，再用 Node.js 22.11+ 内置 fetch 从 `raw.githubusercontent.com/UnityX103/handover-ui-server/<完整 SHA>/` 下载清单和文件。无需 gh、GitHub 登录或访问 token；需能访问这两个公开 HTTPS 服务。清单路径校验、并发锁、完整下载后备份、按目录原子重命名切换及失败恢复不变；检查或下载失败保留现有 Skill、配置、handle 和游标；安装恢复异常会明确报告 recovery-needed，并保留备份与锁等待人工处理。它只更新本机 Skill，服务器仍使用既有 push webhook 发布，只读 Git 部署身份及凭据不变。

手机访问同一入口并添加到主屏幕，开启通知由本人在设备上授权。通知跳转保持请求身份；页面收到服务器保存成功回执后立即返回当前用户名列表，不等待来源 Agent ack；“已发送，等待回复”及后端处理/确认流程不变。真实系统通知与安装需真机验收，不能用浏览器模拟结果代替。
