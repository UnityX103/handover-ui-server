# Mac 本机 App

“远程交接”是独立的 macOS App，使用 AppKit 窗口与 WKWebView 承载现有收件箱和题目。客户端只创建和恢复请求；App 自行检查同名新消息并唤起窗口，不依赖 Codex 自动打开网页。

## 构建与安装

macOS 13+，构建需系统 Swift（Xcode Command Line Tools），客户端继续使用 Node.js 22.11+。

```sh
npm run build:app
npm run install:app
open "$HOME/Applications/远程交接.app"
```

构建产物在 `.local/macos/远程交接.app`，安装目标为 `~/Applications/远程交接.app`。构建使用本机 CPU 架构，不下载第三方运行时；产物采用本机 ad-hoc 签名，不表示已通过 Apple 公证。更新安装前将原 App 备份到 `~/.local/share/handover-ui/app-backups/`；更新运行中的 App 后需退出并重开以加载新版。

安装默认写入 `~/Library/LaunchAgents/com.handover-ui.desktop.plist`，下次本人登录时后台启动 App。`npm run install:app -- --no-login` 只安装 App，不新增登录启动文件；若已安装过登录项，需按下方卸载方法移除已有文件。关闭窗口仍在菜单栏接收；菜单或 Command-Q 退出后停止检查，直至手动重开或下次登录。

## 配置与行为

复用 `~/.config/handover-ui/config.json` 的 `serverUrl` 和 `username`，支持 `HANDOVER_CONFIG`、`HANDOVER_SERVER_URL`、`HANDOVER_USERNAME`。默认用户名 Xpy。菜单“设置”修改共享文件，保留旧配置的其他字段，以 0600 原子写入；环境变量覆盖优先于文件。

App 使用独立持久浏览器存储；首次需本人在窗口内主动填写目标用户名登录，之后记住选择。链接与配置不替本人登录、不静默切换；退出网页用户名后不再接收该用户名提醒，其他设备不受影响。

App 每 5 秒对当前用户名只读请求列表。仅新请求、追加题目或重开后的 `userAttentionVersion` 提升会触发提醒；提交、Agent 确认、结束和取消不触发新消息。首次连接只保存历史基线；已提醒版本以 0600 存在 `~/Library/Application Support/Handover/attention.json`，按完整服务器路径与用户名隔离。状态持久化失败会显示错误并停止这一轮提醒，网络失败保持原记录并重试，重连和重启后不反复唤起同一版本。

菜单“新消息自动唤起 App”默认开启。收到新消息时恢复窗口并置前；若当前在收件箱，进入新请求；若正在填写其他题目，保留原页面和草稿，通过窗口上方“新消息”进入收件箱。一次检查到多条消息时只唤起一次。系统休眠、断网或 App 退出期间不能即时提醒；再次连接后继续检查未见过的消息。

普通问卷、自定义隔离 HTML、JSON 回执与答复继续由原服务器处理。App 的只读检查不接触来源 Agent 的 `wait`、`ack`、handle 或消费游标，也不模拟答复。页面内手动点击外站链接才交给默认浏览器；其他自动导航限制在配置的服务器与部署路径。页面下载使用系统保存对话框，保留 HTML／JSON 导出入口。

## 验证

```sh
npm run test:app
node --test test/username-cli.test.mjs
```

模型验证覆盖 URL 边界、部署路径、用户名隔离、历史基线、新版本提醒、重复检查、Agent 确认、取消、重启恢复、原子写入和权限。CLI 检查使用隔离服务与浏览器替身，验证创建/恢复不会调用浏览器，显式 `open` 才调用。

原生窗口、最小化后唤起、输入草稿与下载需在真实 App 中验收；手机安装及系统 Web Push 需在手机上验收，桌面测试不能替代。

## 移除登录启动与卸载

```sh
rm "$HOME/Library/LaunchAgents/com.handover-ui.desktop.plist"
```

若曾手动使用 `launchctl bootstrap` 加载过此项，先 `launchctl bootout "gui/$(id -u)/com.handover-ui.desktop"`。安装脚本只写入下次登录的配置，不主动 bootstrap。退出 App 后在 Finder 删除 `~/Applications/远程交接.app` 即可卸载。配置、提醒记录、Skill、请求 handle 和服务器数据保留；不自动删除旧业务记录。
