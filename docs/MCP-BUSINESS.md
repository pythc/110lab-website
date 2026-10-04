# 110lab 业务 MCP 0.14.0

实现范围：项目立项、奖项荣誉、招新管理、公共邮箱、动态管理。39 个 `lab_*` 工具加入现有工作台服务；需求平台的 14 个工具及个人连接保持独立。完整名称见 [清单](MCP-INVENTORY.md)，产品设计见 [设计稿](MCP-BUSINESS-DESIGN.md)。

## 身份与使用

更新插件后，用 `lab_whoami` 开始。首次调用受保护工具会返回当前用途的授权链接；打开链接，用本人飞书身份同意相应能力，回到对话重试原操作。后续新增用途会再请求对应权限，不会把旧 `mail:session` 登录令牌升级为业务权限。角色和对象权限在服务端每次重新核验。普通成员不能读取简历、公共邮件、动态草稿或执行审核。

本机 Node.js >=20.11，服务器 Node.js >=24。本机业务授权保存在 `~/.config/110lab-business/oauth.json`，目录 0700、文件 0600，进程间锁防止刷新令牌竞争。客户端绑定固定 HTTPS 资源，不将飞书 App Secret、SMTP 密码交给模型。需求平台继续使用原个人连接码。

- 新建/编辑使用 UUID `requestId`。相同请求重试保留同一 ID；内容改变换新 ID。
- 编辑和审核先读取详情，提交 `expectedRevision`；冲突后重新读取，不能盲目覆盖。
- 查询使用 `limit/cursor`；分页期间数据变化返回 `CURSOR_STALE`，重新开始查询。
- 附件上传只读取用户明确指定的本地绝对路径，不扫描目录。只支持 PDF、DOCX、PNG/JPG、TXT，最大 10MB。荣誉证书只接受原证书类型。
- `lab_attachment_read` 根据荣誉、简历或邮件所属对象重新鉴权，返回私有原文件和可提取文本。PDF 最多 50 页、文本最多 100000 字符；DOCX 保留段落。独立 Worker 限时 12 秒、堆 128MB、最多并发 2；图片不自动 OCR，加密/损坏文件明确返回不可解析。
- 业务成功结果放在 `structuredContent`，同时提供 JSON 文本；错误使用 `isError` 及 `{code,message}`。工具输入为严格 JSON Schema，拒绝未定义参数。

## 预览与实际效果

邮件发送、逐人招新通知、飞书同步、官网动态发布/撤回都先生成绑定用户、客户端、对象版本、配置版本及内容摘要的预览。有效期 10 分钟。用户打开 `confirmationUrl`，检查具体对象和内容后确认；模型不能用 `confirmed:true` 替代。浏览器需要本人身份、同源请求和 CSRF。

确认本身不触发发信。随后调用对应执行工具，传原 `previewId`，再使用 `lab_operation_get` 查询状态。预览 ID 是实际效果的幂等键，换请求 ID 不会重复执行。内容、角色、配置或附件变化使原预览失效。

邮件结果严格区分：`QUEUED` 已接收、`SIMULATED` 仅模拟、`SMTP_ACCEPTED` 发信服务器接受、`PARTIAL` 部分收件人拒绝、`FAILED` 外发前失败、`UNKNOWN` 结果待核实。SMTP 接受不保证送达或已读。超时或进程崩溃产生 UNKNOWN 后不自动重发；先人工核实，再另建草稿并确认。没有后台群发或自动录取功能。

招新工具沿用现有工作流、变量校验、Reply-To 面试官邮箱、逐人预览和持久任务队列。飞书目标未配置时明确拒绝，不尝试查找或接管其他部署的存量招新流程。

## 本次启用范围

- `noreply@notify.110-lab.cn`：复用服务器现有凭据，仅对实时实验室管理员且飞书成员同步已完成者开放。IMAP 只读，不因查询而标记已读；SMTP 发信须逐封人工确认。
- `noreply@110-lab.cn`：列为待配置，不复制 notify 身份或伪造 From。
- 官网招新：保持根域邮箱及 `dry-run`，资料永久保留；不更改真实存量流程。
- 考核入口：默认保留现有 `/login`。只有完成考核后端无中断发布后才打开 `PORTAL_ASSESSMENT_SSO_ENABLED=true`。本次不改考核容器。

## 服务器配置

```text
PORTAL_BUSINESS_MCP_ENABLED=true
PORTAL_BUSINESS_MAIL_CONFIG=/run/110lab/business-mail.json
PORTAL_ASSESSMENT_SSO_ENABLED=false
PORTAL_RECRUITMENT_WORKFLOW_MODE=dry-run
```

业务数据默认在现有 `mail/workspace/mcp-business`，须持久挂载。私有邮箱配置文件由服务用户持有、0600，不放入 Git/发布包/日志：

```json
{
  "mode": "live",
  "mailboxes": [
    {"address":"noreply@110-lab.cn","enabled":false},
    {
      "address":"noreply@notify.110-lab.cn","enabled":true,
      "imap":{"host":"imap.feishu.cn","port":993,"secure":true,"user":"noreply@notify.110-lab.cn","pass":"<existing private credential>"},
      "smtp":{"host":"smtp.feishu.cn","port":465,"secure":true,"user":"noreply@notify.110-lab.cn","pass":"<existing private credential>"}
    }
  ]
}
```

只允许精确飞书主机、端口和邮箱身份；不接受任意协议服务器。修改配置后按发布流程加载，旧邮件预览失效。服务器不得把该配置挂载给考核或需求平台。人事角色、邮箱授权名单仍在原管理页维护，MCP 不提供任免或密钥管理工具。

未绑定的临时上传文件 24 小时后清理；已经绑定草稿/证书的文件及审计、任务记录保留。上传每日每人 100 次、全局 512MB 配额；附件上限和解析并发限制独立生效。文件无公开地址。

## 升级与回滚

1. 固定 Git 提交、干净工作树、release.json 哈希清单；发布前核对 live 容器 ID、启动时间、current 指针和共享网关哈希。
2. 用 SQLite backup API 备份在线数据库；保存旧发布包、私有配置和网关文件，不复制正在写的 WAL 数据库文件。
3. 新门户容器旁路启动，使用原 Node 运行时、业务数据挂载和身份配置；新增业务邮箱配置只读挂载。保留旧容器和现有 worker。
4. 验证健康、匿名访问拒绝、工具发现、官网投递仍为模拟、公开动态及视频；仅替换门户的两个 Caddy 上游，并保持配置文件 inode。
5. 回滚先在业务数据目录创建 `frozen` 文件（或 `PORTAL_BUSINESS_FREEZE_FILE` 指定路径）。新 MCP 写入和邮件领取立即停止；等待 `mail_jobs` 中 SENDING 归零，核实 UNKNOWN。再切回旧上游和 current 指针，停止新门户。
6. 回滚保留新数据库、任务、审计和上传资料，不能恢复旧数据库覆盖上线后的真实资料，也不能清除 UNKNOWN 以触发重发。恢复新版前逐项处理遗留任务，再移除冻结文件。

OAuth scopes 使用附加表，未改变旧 requests/codes/tokens 的列数，兼容旧版按位置 INSERT。其他业务幂等日志使用附加表。动态管理升级为实验室飞书管理员登录；回滚到 0.12 恢复旧版认证方式，需留意用户会话差异。

## 验证

```sh
npm run build
npm test
npm run release
node scripts/verify-admin-release.mjs
node scripts/verify-mail-release.mjs
node scripts/verify-recruitment-release.mjs
node scripts/verify-business-release.mjs
```

测试使用虚构身份、临时数据库和本机 SMTP 接收器；不向真实收件人发信，不写真实飞书表。发布验证与用户在 Codex 原生插件里的首次授权验收分别记录，不能把工具发现成功当作完整真人授权通过。

协议实现参考：[飞书第三方邮箱客户端](https://www.feishu.cn/hc/zh-CN/articles/902478147400-在第三方邮箱客户端登录飞书邮箱)、[ImapFlow](https://imapflow.com/docs/api/imapflow-client/)、[MailParser](https://nodemailer.com/extras/mailparser)、[PDF.js](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)。
