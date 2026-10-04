# 官网招新工作流

0.11.0 新增 `/recruitment` 与 `/recruitment/embedded`，工作台应用「招新管理」指向这里。原 `/recruitment-test` 与其虚构数据保持独立。官网新增投递直接写入此工作流，不读取或迁移其他部署的真实招新内容。

## 操作

1. 官网填写姓名、组别、联系邮箱，上传一份 PDF/DOCX（10 MiB）。勾选用途与永久保留说明。服务端验证文件实际格式、限制重复提交、上传并发和持久频率。
2. 接收事务同时保存候选人、简历、同意记录、私有回执、简历转送任务。回执只表示资料已收到；邮件任务独立记录，不把模拟当发送成功。
3. 实验室管理员在传统候选人列表处理初筛、考核记录、面试安排和决策。邮件模板有系统变量及自定义变量；面试官邮箱用于 Reply-To，其他联系方式显示在正文。
4. 每名候选人生成独立邮件预览，检查 From、To、Reply-To、主题与正文后确认。冻结模板、配置版本及内容；等待发送时撤权、改模板、换邮箱、归档会使任务失败，不能悄悄改收件人后发送。
5. 超级管理员配置允许使用的邮箱、默认发信邮箱和收件邮箱。默认均为 `noreply@110-lab.cn`。收件地址同时更新官网邮箱投递链接、同意说明及转送收件人；邮件主题继续为 `[招新简历] 姓名-应聘组别`。UI 不保存凭据。

`HELD` 未发送；`QUEUED` 等待；`SENDING` 处理中；`SIMULATED` 模拟完成；`SENT` 服务商已接收（不承诺最终收件箱送达）；`FAILED` 明确失败；`RETRYING` 可安全重试的临时拒绝；`UNKNOWN` 结果待核实。连接中断/发送后无确认/进程失联不自动重发。管理员登记核实依据后才可重试明确未发送任务。任务保留操作人、冻结内容、稳定 Message-ID、尝试次数和状态事件。

当前默认 `dry-run`，没有任何对外邮件或飞书写入。官网资料仍正常入库，简历转送任务为 HELD；管理员可逐人模拟转送和面试通知。以后切到 live 也不会自动释放旧 HELD 或模拟任务，只有切换后的新投递自动转送。

## 飞书应用

2026-10-05 只读核实 [招新工作流](https://open.feishu.cn/app/cli_aae419847eb85bcf/baseinfo)：App ID `cli_aae419847eb85bcf`，已发布，使用长连接，订阅机器人入群与接收消息事件。未修改其 Secret、事件、回调、权限或现有部署。

新增适配器只调用出站多维表格 OpenAPI，不建立长连接。管理员逐人预览准备同步的记录后确认；当前仅模拟。正式启用需在**独立的联动表**配置 App Token / Table ID，应用获得该表访问权限及记录读写权限；不要复用会触发正在进行的真实招新自动化的表。

表字段：`110lab编号`（文本，唯一候选人 ID）、`姓名`（文本）、`应聘组别`（文本）、`阶段`（文本）、`邮箱`（文本）、`工作台链接`（超链接）。已有记录按编号查找后更新；创建用 UUID client_token 幂等。多条同编号记录拒绝写入。记录链接返回有登录保护的工作台，简历不上传飞书、不产生公开文件 URL。

参考官方接口：[创建记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create)、[更新记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update)、[查询记录](https://open.feishu.cn/document/docs/bitable-v1/app-table-record/search)。不自动触发录取决定、群消息、面试通知或旧招新进程。

## 数据与部署配置

仅新增 HTTP 环境变量：

```
PORTAL_RECRUITMENT_WORKFLOW_ENABLED=true
PORTAL_RECRUITMENT_WORKFLOW_MODE=dry-run
PORTAL_RECRUITMENT_WORKFLOW_DATA=/data/mail/workspace/recruitment
```

路径必须对应现有私有邮件数据挂载；以实际容器挂载点为准。默认可不配置 DATA，使用 `PORTAL_MAIL_DATA/workspace/recruitment`。无需新密钥、服务或外部网络任务。默认关闭时保留旧官网收件队列；旧回执通过原实现查询和重试，不消费两遍请求体。

私有目录 0700、数据库和盐 0600，数据库包含简历 BLOB、历史简历版本、候选人、模板、设置、审核记录及投递任务。所有正式工作流数据永久保留。只有未接收成功的过期临时上传、限流计数可清理。默认附件存储上限 1 GiB，满额拒绝新提交，不能删旧资料腾空间。外网服务器定期容量监控及 SQLite 一致备份；备份本身私有，发布包不含业务数据库。

新配置上线前须报告范围。切换前记录旧 release/容器、当前网关摘要、所有后台进程；使用 SQLite backup 备份所有私有数据库。仅切换门户 HTTP，保留旧发送与成员同步服务，不更改正在运行的招新程序。候选先验证主域不开放管理 API、嵌入 CSP、未登录拒绝、接收模式 dry-run、永久保留与当前邮箱。无真实外发测试。

回滚：按最新共享网关摘要检查后切回旧 HTTP 和 release 指针；不恢复或覆盖任何新数据库，不删除新简历。旧界面不显示新工作流，但再次升级可恢复所有新增资料；回滚前先关闭官网新提交入口，等在途接收完成、记录最后回执并备份，切换后明确官网恢复的接收地址及旧保留策略。不可把新数据库交给旧临时清理器。

## 以后启用真实发送时的配置（本次不自动启用）

独立进程 `server/recruitment-workflow-worker-runtime.mjs`。只给 worker 挂载 0600 的私有 JSON：

```
{
  "smtp": [{"address":"noreply@110-lab.cn","host":"smtp.feishu.cn","port":465,"secure":true,"user":"noreply@110-lab.cn","pass":"<由用户提供到私有配置>"}],
  "feishu": {"appId":"cli_aae419847eb85bcf","appSecret":"<经授权配置>"}
}
```

SMTP 与 Feishu 任一可暂不配置，不得复用 notify 子域凭据冒充根域地址。HTTP 只配置非机密目录 `PORTAL_RECRUITMENT_WORKFLOW_SENDERS=noreply@110-lab.cn`；该目录不证明凭据有效，需运维核实后填写。worker 需要 `PORTAL_MAIL_DATA` 只读角色库，WORKFLOW_DATA 可写，WORKFLOW_PROVIDERS 指向私有 JSON，MODE=live。HTTP 与 worker 的 MODE 必须一致；配置文件不进环境变量、Git、聊天或发布包。默认每分钟最多一项任务，最多 8 次尝试。取消外发测试不等于已验证飞书线上发信。

## 验证

`npm run build && npm test && npm run release`。新测试覆盖官网 multipart 到候选人和模拟面试通知、模板变量、权限撤销、配置变更、容量回滚、永久保留、幂等、UNKNOWN 中断恢复与人工核实、仅 loopback 的 SMTP 交付及模拟 Feishu 请求。浏览器实际验证 Uppy 上传、回执、列表详情、自定义模板、面试官回复邮箱、逐人确认。

本地 `node scripts/preview-recruitment-workflow.mjs` 使用虚构身份，仅监听 127.0.0.1:4195；数据在 ignored artifacts/recruitment-workflow/local-data，永不打包。只用于预览，不是生产登录绕过。
