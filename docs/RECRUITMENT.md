# 官网在线简历投递 0.6.0 候选

## 流程及隐私边界

Uppy Core / Dashboard / XHRUpload 在站内上传一份 PDF 或 DOCX，最多 **10 MiB（10,485,760 字节）**。字段为姓名、产品组/开发组/测试运维组、联系邮箱及用途同意。邮件只发往 `f74974332@gmail.com`，主题固定为 `[招新简历] 姓名-应聘组别`，候选人邮箱仅用于 Reply-To，不允许填写其他收件人。原邮件投递链接及主题保留。

服务端独立校验字段、扩展名、MIME、文件大小和内容特征。PDF 检查文件头与结束标记；DOCX 校验 ZIP 结构、文件名、必要 XML 部件的 CRC 与类型声明，拒绝加密、宏、嵌入对象、实体声明和过大解压量。ZIP 总解压量不超过 32 MiB，正文 XML 不超过 1 MiB，XML 层级不超过 128、标签数不超过五万；复杂文档可导出为 PDF。这里提供格式与资源限制，不声称提供完整 PDF 语义解析或杀毒能力；文件不会被服务端渲染或执行。

临时文件与 SQLite 均在发布目录外的私有目录，目录 0700、文件 0600，文件名为随机 UUID。没有下载接口、公开文件地址或网页预览。SMTP 使用内存中的附件内容，实际 MIME 邮件须小于 14,500,000 字节；10 MiB 上限已用真实 MIME 编码测试，适配现有阿里云 SMTP 整封邮件 15MB 限制。

## 回执和发送结果

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| RECEIVED | 资料已持久化接收 | 排队等待发信 |
| SENDING | 独占发信租约中 | 等待 SMTP 结果 |
| SENT | SMTP 明确接受固定收件人 | 页面显示邮件已发送；不代表 Gmail 已入箱或已阅读 |
| RETRYING | SMTP 明确拒绝且属于暂时错误，或确定发生在 DATA 前的连接错误 | 自动重试 |
| FAILED | SMTP 明确永久拒绝、文件错误或自动重试耗尽 | 候选人最多手动重试两轮 |
| UNKNOWN | DATA 中断、确认超时或过期发信租约 | 停止自动重发，维护者核实后处理 |
| EXPIRED | 未确认发送的资料已过保留期并清理 | 联系实验室并附回执编号 |

客户端随机生成 256 位能力凭证，Authorization 请求头携带；服务端只存其哈希。同一凭证同一资料返回原回执，资料改变则冲突。另有 24 小时内容指纹去重。回执接口只提供状态和时间，不回传姓名、邮箱、文件或路径。浏览器 sessionStorage 只保留回执编号和凭证，不持久化简历及候选人字段；发起上传前就保存凭证，即使接收响应丢失，也可在重新打开页面时凭此恢复原回执。尚未确认的上传不会显示“提交已接收”。关闭标签页后可用回执编号联系维护者查询。

持久化队列使用 SQLite IMMEDIATE 事务协调 API 和 worker，每次仅一个邮件在发送，全局每分钟最多一封，接收默认每天最多 100 份，每邮箱每天 3 份，每 IP 每小时 30 份，上传请求每 IP 每 10 分钟 30 次。单 API 实例最多两个并行上传，私有文件总量最多 512 MiB。只有明确配置的可信代理 IP 可提供 X-Forwarded-For，默认不信任。

暂时错误每轮最多 8 次发信，间隔为 1 分钟、5 分钟、15 分钟、1 小时、3 小时、6 小时、12 小时；显式手动重试开始新一轮，最多两轮。SMTP 确认超时为 3 分钟，租约 5 分钟；租约恢复为 UNKNOWN，旧 worker 的迟到结果无法覆盖回执。稳定 Message-ID 便于发信日志核对，不能保证邮件系统按此去重。

每 15 分钟及 worker 启动时清理：确认发送满 24 小时的文件及姓名/邮箱明文、接收满 7 天的待发/失败/未知资料；执行时间允许一个调度间隔，停机后启动补清理。回执与事件记录接收满 30 天后清理。未登记且满 1 小时的中断上传文件回收。收件邮箱中的副本由实验室管理，不受网站临时文件清理影响。

## 已核实的发信服务

2026-10-01 只读核实 `lab110-assessment` 已配置 `smtpdm.aliyun.com:465` 隐式 TLS，From 为 `110lab <noreply@notify.110-lab.cn>`，生产测试收件模式关闭，发信域 SPF 包含阿里云。未读取或获取 SMTP 密钥，未外发邮件。

飞书已有 `noreply@110-lab.cn` 可发信公共邮箱，但官网没有持续运行所需的飞书发信配置。候选优先复用现有 SMTP；不会将本机飞书用户登录令牌复制到官网。现有考核服务不是附件 relay，不修改其业务或增加 relay 接口。现有 SMTP 的附件到达 Gmail 的真实链路仍待授权外发测试。

## 新部署配置范围（尚未实施）

1. 发布官网 0.6.0 候选；只开放四个招新 API：config、submissions、status、retry。管理页面和其他写入接口继续关闭，工作台入口不变。
2. 创建 `/opt/110lab-homepage/private/recruitment`（0700、UID 1000）作为唯一共享队列及文件目录，发布/回滚包不包含资料。默认接收上限 512 MiB。官网 HTTP 与一个独立发信 worker 仅挂载该目录。
3. 创建 `/opt/110lab-homepage/private/recruitment-smtp.json`（0600、UID 1000），**由账号维护者配置已有 SMTP 账号或指定可复用的既有配置路径，不需要在聊天中提供密钥**。该文件只读挂载到 worker `/run/110lab/smtp.json`，HTTP 不挂载，不放进环境变量、Git、镜像或发布包。
4. HTTP 和 worker 设置 `PORTAL_RECRUITMENT_ENABLED=true`、`PORTAL_RECRUITMENT_DATA=/data/recruitment`；worker 另设 `PORTAL_RECRUITMENT_SMTP_CONFIG=/run/110lab/smtp.json`。HTTP 配置 `PORTAL_RECRUITMENT_TRUSTED_PROXY_IPS=172.29.0.10`，发布前须再次核对网关实际地址与 XFF 覆写行为。保持无 CORS、固定官网 Origin，不信任其他代理。
5. worker 运行 `node server/recruitment-worker-runtime.mjs`，根文件系统只读、UID 1000、drop ALL capabilities、no-new-privileges，单独资源限制（内存 192 MiB）并持续运行。不对公网暴露 worker 端口。另运行独立清理容器（同一发布包，内存 96 MiB，network none），只挂载队列、不挂 SMTP 配置，执行 `node server/recruitment-ops-runtime.mjs cleanup-loop`；即使官网回滚或发信暂停，也每 15 分钟清理到期资料。
6. 仅在 `110-lab.cn` 的投递路由设置网关请求体上限 11 MiB 与上传超时 180 秒；其他站点路由不变。后台另行保留相同 180 秒上传超时及 10 MiB 文件限制。无 DNS 修改、无新增付费服务或密钥申请。
7. 真实外发测试只发送 **一封**：收件人 `f74974332@gmail.com`，From 使用上述现有账号，主题 `[招新简历] 虚构上线测试-开发组`，姓名“虚构上线测试”、组别“开发组”、Reply-To `candidate@example.com`；正文明确标注虚构测试，附件为不含真实个人信息的约 625 字节 PDF。确认 SMTP 接受后，还需收件人确认 Gmail 到达及附件可打开。

SMTP JSON 字段仅为 `host`、`port`、`secure`、`user`、`pass`、`from`。生产要求隐式 TLS，不允许测试明文连接、跳过证书校验或远程测试收件模拟。已安装依赖均来自 npm，版本固定。

## 维护和回滚

部署前保留 0.5.3 发布目录及容器、原网关配置与哈希，记录队列/配置目录权限、worker 容器 ID、发布清单。首次上线前不能创建候选人的真实数据备份；上线后的队列备份只能由维护者在同机 0700 操作目录中、停 API/worker 并完成 SQLite checkpoint 后执行，备份默认七天清理，不能下载到开发机或 Git。

回滚先阻止新投递，再停止新 worker，保留私有队列和配置，切回原 0.5.3 官网容器及精确网关配置，核对首页/视频/考核/动态/工作台。不得将队列删掉或还原旧快照覆盖已接收记录，不得把 SENDING 或 UNKNOWN 直接改为待发。恢复本功能时先处理过期租约与清理，再根据维护者核实结果重试。旧版官网无简历 worker，因此其回滚不会触发旧队列重发。**回滚时保留独立清理容器**，不可因停止 worker 而无限保留资料；清理容器故障须由维护者恢复或执行同等清理任务。

私有维护命令（无网页管理入口）：

```sh
PORTAL_RECRUITMENT_DATA=/data/recruitment node server/recruitment-ops-runtime.mjs inspect 回执UUID
PORTAL_RECRUITMENT_DATA=/data/recruitment node server/recruitment-ops-runtime.mjs retry 回执UUID 当前revision
# UNKNOWN 必须先核实发信日志确认未发；可能重复发送风险须由维护者判断
PORTAL_RECRUITMENT_DATA=/data/recruitment node server/recruitment-ops-runtime.mjs retry 回执UUID 当前revision --confirmed-not-sent
PORTAL_RECRUITMENT_DATA=/data/recruitment node server/recruitment-ops-runtime.mjs cleanup
```

inspect 只显示状态、尝试次数、脱敏错误码和事件，不输出候选人资料或密钥。

## 验证与当前边界

`npm run build && npm run release && npm test` 构建前端、独立 HTTP/worker/ops 运行包并运行真实 loopback SMTP 测试。用虚构 PDF/DOCX 覆盖大小/类型/字段/同意校验、重复提交、权限凭证、附件 MIME 与邮件主题、暂时/永久 SMTP 错误、八次自动重试及手动上限、SMTP DATA 无确认、过期租约、跨连接队列协调、频率/空间上限、伪造 XFF 与 24 小时/七天/30 天清理。

本机浏览器候选地址为 `http://127.0.0.1:4184/#join`，测试接收器只监听 loopback，不向外转发。生产官网仍为 0.5.3，线上招新投递尚未启用。只有完成新增配置范围授权、维护者提供现有 SMTP 配置、真实外发及公网验证后，才能宣称线上完整流程已可用。

参考：[Uppy 文档](https://uppy.io/docs/uppy/)、[XHRUpload](https://uppy.io/docs/xhr-upload/)、[阿里云 SMTP 附件及限制](https://help.aliyun.com/zh/direct-mail/how-can-i-send-emails-with-attachments-using-smtp)。
