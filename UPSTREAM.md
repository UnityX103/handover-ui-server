# 上游来源

本项目基于 https://github.com/jasonku09/grill-with-ui ，起始提交为 `fc0de407ff3ca5c981304afba0ecf059ed5ce6cd`。

保留上游 Git 历史、MIT 许可及版权声明。根目录 `page.html` 和 `server.mjs` 继续承载上游问卷、讨论、暂缓、重新打开、深入分析及可视化协议；远端服务通过导出的校验和增量合并函数复用其状态模型。

`src/`、`web/`、`skills/` 和 `deploy/` 为本项目的远程服务、移动端入口、客户端及部署扩展。原始本地服务仍可用于上游回归测试，安装到本机的 Skill 使用远端入口。
