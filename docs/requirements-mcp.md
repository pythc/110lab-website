# 需求平台 MCP 整合

插件 0.8.0 新增 `110lab_requirements` 本机 stdio 服务；原工作台远程服务和插件身份、私有可见范围、字标及默认提示保持不变。

桥接为无依赖 Node.js 单文件。只读取现有个人凭据文件，检查所有者、0600 权限、非符号链接、内容大小和固定端点；凭据只送至现有需求平台。响应和输入有大小限制，最多排队 32 条请求，90 秒超时包含读取响应正文。不会重放失败请求，不把 HTTP 错误正文、凭据和请求地址输出到协议日志。

本机 MCP 协议验证已完成 initialize、tools/list 和 requirements_list 只读调用，发现 13 个工具；33 项本地测试通过（其中 7 项新增桥接测试）。未调用任何线上写入、评审通知或真实 PR 修改工具。平台现有权限、幂等和异步阶段语义由上游继续执行。

这条接入路线适用于 Codex 桌面端。ChatGPT 网页和手机不能运行本机进程；后续跨端版本应为需求平台接入标准 OAuth 授权，不以共享个人密钥替代身份。

## 嵌入登录修正

未登录入口的实际 HTTP 跳转链为应用 → open.feishu.cn → accounts.feishu.cn → passport.feishu.cn → accounts.feishu.cn → login.feishu.cn → accounts.feishu.cn。原 MCP 资源漏掉 open、passport 和 login 三个域名，本次补齐精确 HTTPS frameDomains，不加通配域名，不代理或改写飞书认证。

新增需求页面的重新加载及独立登录提示。飞书跨站 Cookie 与真实 Codex 插件内登录仍需用户验收；HTTP 跳转和白名单核验不能替代完整登录测试。

用户截图确认侧栏完整插件入口中的需求页显示“内容被屏蔽”，考核页显示拒绝连接；这与此前工具侧面板登录页验证不同。增加折叠的“连接诊断”，只展示工作台页面 origin、scheme/host、祖先 origin 和 referrer origin，不读取 Cookie、用户数据或目标 iframe 内容。仅在用户点击“发送诊断到当前对话”后通过 MCP App 桥发送到当前对话，便于精确核对考核 frame-ancestors。来源不会被自动加入白名单。
