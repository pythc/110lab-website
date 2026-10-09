# 招新工作台工作流

## 0.16.0 的范围

候选人、简历、面试安排、审核记录、模板、图片和发送任务均保存在外网服务器的招新工作台数据库中。官网投递和插件「招新管理」共用这一份数据。**不依赖飞书表格，不读取、迁移或接管其他部署的存量招新流程。** 原 `/recruitment-test` 虚构流程继续独立。

页面改动由服务器提供，现有 0.15.0 插件加载新版页面即可；本次不修改本机登录协议。旧表格同步 MCP 已停止提供；客户端重新读取工具列表后生效。

## 操作流程

1. 官网 Uppy 表单填写姓名、组别、联系邮箱，上传一份 PDF/DOCX（10 MiB 内）。服务端校验内容、大小、同意记录、限流和重复投递。
2. 同一事务保存候选人、简历、私有投递回执，并创建发给**候选人**的收件确认邮件任务。页面分别报告“提交已接收”与邮件状态；不把服务商接收当作收件箱送达。
3. 管理员在传统列表中处理初筛，可选择先记录考核或直接进入面试。面试阶段从现有飞书通讯录选择面试官。
4. **招新工作流**应用仅向被选择的面试官发消息，消息包含 `/recruitment/interviewer?assignment=<UUID>`。面试官通过工作台飞书身份登录，填写未来的面试时间、HTTPS 面试链接、回复邮箱和联系方式。链接本身不能代替登录，其他身份不能查看或回填。
5. 面试官提交后，管理员看到“安排待审核”，可以退回修改。选择模板、填写自定义变量、检查实际 From / To / Reply-To、主题、图文预览后，逐人确认发送。面试及后续结果邮件的回复发往面试官联系邮箱；尚未安排面试官的回执和未通过邮件回复到公共收件邮箱。修改安排、改派面试官或模板变化会使旧预览失效。
6. 记录面试反馈后，可准备录取邮件；未通过邮件可从未结束的流程准备。结果决定和发送任务在确认时一起提交。已经成功发送的结果不能重复发；明确失败可重试，配置变化后可重新预览同一结果。
7. 所有发送保留独立任务、冻结内容、Message-ID、操作人、尝试次数和状态记录。管理员可核实不明确结果、重试明确失败；不会因刷新页面重复发送。

## 模板和多媒体

内置投递回执、面试邀请、录取通知、未通过通知四种用途。管理员可新增或编辑模板、主题、富文本、系统变量、自定义变量及默认值；超级管理员选择自动回执模板。

系统变量：`name`、`group`、`applicationId`、`interviewTime`、`interviewerName`、`interviewerEmail`、`interviewerContact`、`location`、`decisionNote`。语法为 `{{name}}`。自动回执只可使用投递时已经知道的字段，自定义必填变量必须有默认值。结果说明是会发送给候选人的文字，不应填写内部评议。

正文支持文字样式、链接和 PNG/JPEG/GIF/WebP 内嵌图片。单张不超过 2 MiB，单封最多 8 张、总计不超过 8 MiB。服务端检查图片格式，清理脚本、事件属性和外部跟踪图片，变量按 HTML 转义。图片随 MIME 以 CID 内嵌，存储和预览均需管理员权限，不提供公开文件地址。邮件同时包含纯文本版本。视频和音频使用封面配 HTTPS 链接，不承诺邮件客户端内直接播放。

## 飞书应用边界

应用 ID：`cli_aae419847eb85bcf`，名称「招新工作流」。仅使用出站 [发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)，以企业 `union_id` 定位同一成员，不混用另一个登录应用的 `open_id`。

**不建立第二个长连接，不更改事件订阅、回调、原表格或现有运行实例。** 现有 App Secret 经授权后只在服务器私有 worker 配置使用，不重置、不进入浏览器或插件包。通知失败可在工作台查看错误及重试。应用必须已经具备机器人发消息权限，并对所选面试官可用；代码完成不能代替这项真实验证。

旧 `lab_recruitment_feishu_preview`、`lab_recruitment_feishu_sync` 已撤下；历史表格配置只为读取旧数据兼容保留，旧排队的表格同步任务会拒绝执行。

## 权限与发件配置

- 实验室超级管理员：配置可用邮箱、默认发信邮箱、收件/回复邮箱、自动回执模板。
- 实验室管理员：候选人管理、面试官分配、模板维护、逐人确认发送、核实与重试。
- 普通成员：只看和填写分配给自己的面试安排，不能读取所有候选人或下载简历。

默认邮箱 `noreply@110-lab.cn`。官网邮箱投递链接与说明跟随收件地址，人工投递主题仍为 `[招新简历] 姓名-应聘组别`。不将 notify 子域凭据冒充根域发件人。若经授权临时使用 `noreply@notify.110-lab.cn` 联调，实际 From 也必须是该地址。

HTTP 配置：

```text
PORTAL_RECRUITMENT_WORKFLOW_ENABLED=true
PORTAL_RECRUITMENT_WORKFLOW_MODE=dry-run
PORTAL_RECRUITMENT_WORKFLOW_DATA=/data/mail/workspace/recruitment
PORTAL_RECRUITMENT_WORKFLOW_SENDERS=<已经核实具备 SMTP 凭据的邮箱列表>
```

默认 `dry-run` 不外发：官网回执任务为 `HELD`，管理员确认的任务可模拟执行。切换到 `live` 不会释放旧 `HELD` / `SIMULATED` 任务。正式模式中，新官网投递自动排队回执；其他邮件仍需逐人确认。

仅指定本人测试时，HTTP **保持 dry-run**，额外配置：

```text
PORTAL_RECRUITMENT_TEST_EMAILS=<用户已确认的测试收件邮箱>
PORTAL_RECRUITMENT_TEST_SUBJECTS=<用户本人已核实的企业 subject>
```

两项需要一起配置。只有新投递邮箱精确命中的候选人会创建 live 任务；面试官也只允许该本人 subject。其他候选人仍模拟/保留。发送 worker 必须同时设置下述 `testAllowlist`，发信前再校验收件人，不能只靠页面约定隔离。

独立进程 `server/recruitment-workflow-worker-runtime.mjs`，MODE=live。worker 挂载 WORKFLOW_DATA 可写、现有 PORTAL_MAIL_DATA 角色库只读，以及 WORKFLOW_PROVIDERS 指向的 0600 JSON：

```json
{
  "smtp": [{"address":"<获准发件地址>","host":"smtp.feishu.cn","port":465,"secure":true,"user":"<实际 SMTP 用户>","pass":"<私有凭据>"}],
  "feishu": {"appId":"cli_aae419847eb85bcf","appSecret":"<经授权的现有凭据>"},
  "testAllowlist": {"emails":["<用户测试邮箱>"],"subjects":["<用户本人 subject>"]}
}
```

所有占位符必须先由实际授权配置替换，否则不得启用。SMTP 凭据只挂给 worker，HTTP 仅持有非秘密发件地址清单。正式开放前先停止测试 worker 并排空/核实在途任务，再按明确批准切换正式范围；不可通过删除 allowlist 顺手开启所有人的发送。

### 正式启用

收到正式启用指令后，先检查全部发送任务。`QUEUED`、`SENDING`、`RETRYING`、`UNKNOWN` 必须逐项核实，不能把历史测试积压作为正式任务补发。拦截新的招新提交，等待在途上传的 180 秒期限结束，冻结业务写入并停止发送 worker，备份数据库、原 HTTP 配置、私有 provider 配置及网关。

保持已有业务权限、SMTP 发件地址、应用凭据和数据不变，只将 HTTP 的 `PORTAL_RECRUITMENT_WORKFLOW_MODE` 设为 `live`，去除 `PORTAL_RECRUITMENT_TEST_EMAILS` / `PORTAL_RECRUITMENT_TEST_SUBJECTS`，并删除 provider JSON 中的 `testAllowlist`。先在维护状态下验证新 HTTP 和发送 worker，再恢复招新提交。新官网申请自动排队回执；面试官通知以管理员分配为触发，面试及结果邮件仍需管理员逐人预览确认。历史 `HELD` / `SIMULATED` 任务保持原状。

若需要退回测试模式，先恢复招新维护、冻结并停止 worker，核实在途任务和新增的正式任务，再备份当前数据库。恢复启用前的私有 provider 配置和同版本旧 HTTP 容器，核对网关后切回；不恢复旧数据库覆盖新资料。存在尚未处理的正式任务时，发送 worker 保持停止，先由管理员处置任务，不能让测试白名单将这些正式任务批量标记失败。回滚不得覆盖并发修改的网关或私有配置。

## 数据、投递状态和保留

私有目录 0700、SQLite/盐/凭据 0600。SQLite 保存简历 BLOB、历史版本、内嵌图片、模板、候选人、审核、回执、发送任务。永久保留业务记录；只清理未接收的过期上传和限流计数。简历默认容量上限 1 GiB，图片总容量 100 MiB，满额拒绝新内容，不能删除已有资料腾空间。

`HELD` 未发送；`QUEUED` 等待；`SENDING` 处理中；`SIMULATED` 模拟完成；`SENT` 服务商已接收；`FAILED` 明确失败；`RETRYING` 可安全重试；`UNKNOWN` 结果待核实。每分钟最多处理一项，最多 8 次尝试。发送中断、无确认或进程失联进入 UNKNOWN，不自动重发；管理员登记核实依据后才可继续。

## 发布与回滚门槛

1. 核对当前 HEAD、构建 manifest、线上 release、网关摘要/挂载 inode、现有容器及私有配置摘要；不覆盖其他会话或管理员的变动。
2. SQLite backup 备份全部业务库并执行 quick_check，备份旧 release、配置与共享网关。先拦截招新写入/新上传并等待在途上传完成；业务 MCP 冻结且邮件发送排空。备份失败则不切换。
3. 启动候选 HTTP，验证匿名 API 401、公开域不暴露管理员数据、嵌入页 CSP、面试官入口和 dry-run 配置。候选只新增 mail_images 表和缺失默认模板，不删除或重写候选人资料。
4. 只切换 110lab 的 HTTP 上游和 current 指针。考核、批改、需求平台、原招新程序以及成员同步和旧收件服务均不重启。新增 live worker 只能在本人白名单与批准的私有配置到位后启动。
5. 从官网以明确标记的虚构资料提交，用本人身份分配、回填、审核并检查邮件；分别覆盖录取和未通过。核对 SMTP 接收结果、实际收到的图片/回复地址及 Feishu message_id。未经这些验证不得报告线上全链路已通过。
6. 回滚前拦截招新写入并等待在途操作、停止新 worker、核实 SENDING/UNKNOWN，做新的数据库备份。检查网关没有并发修改再切回旧上游及 current。**不恢复旧库覆盖新数据，不删新简历或图片**。旧版不理解完整新流程，回滚后招新写入暂时维护，其他工作台应用继续可用；修复升级后恢复。新库不得交给旧临时文件清理器。

## 验证命令

```sh
npm run build
npm test
npm run release
BUSINESS_RELEASE_ROOT="$PWD" node --test --test-timeout=90000 tests/business-mcp-matrix.test.mjs
```

自动测试使用隔离 SQLite、虚构身份、loopback SMTP 和模拟 Feishu 传输，涵盖官网 multipart 接收、模板 CID 图片、赋权与跨身份拒绝、回填、审核前不发信、结果两分支、重试和防重、测试白名单、旧工具停用，以及原工作台回归。真实 SMTP/飞书外发与模拟结果应分别记录。

`node scripts/preview-recruitment-workflow.mjs` 为仅监听 127.0.0.1:4195 的开发预览，使用虚构身份；数据在 ignored artifacts/recruitment-workflow/local-data，不打包到生产。这不是生产登录入口。
