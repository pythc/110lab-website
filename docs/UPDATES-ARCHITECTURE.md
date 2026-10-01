# 公开动态的最小架构与接入边界

0.7.0 增加独立管理员登录与动态管理。工作台域名的 `/admin` 提供登录及管理页面；官网域名的管理页面和接口继续返回 404。历史 CMS 已退役，不使用旧账号；MCP 工具继续只读。生产开放必须显式配置私有认证文件、会话目录和持久化动态数据库。

## 已实现的核心

- 独立 SQLite 文件，与考核、批改和历史首页数据库隔离。`PORTAL_UPDATES_DATABASE` 显式指定路径；未配置时只使用空的内存存储。
- 每条记录保存私有草稿和单独的公开快照。编辑已发布内容不会直接改变公开版本；再次发布需要明确确认适合公开。撤回立即移除公开快照并保留草稿。
- 创建、编辑、发布、撤回使用递增 revision；保存或发布旧 revision 会报冲突，避免覆盖别人的修改。
- `GET /api/updates` 与 HEAD 仅返回最多 50 条已发布快照。不存在匿名写入、草稿查询和自动业务资料导入接口。
- 受限富文本为段落、标题、列表、加粗和 HTTPS 链接。服务端严格校验类型、长度、字段和 URL；客户端只用 DOM/textContent 创建内容，不解析 HTML。
- 记录公开更新时间；公开读取使用内容 ETag 和短缓存，发布/撤回后响应 ETag 改变。可见首页每 60 秒重新验证，返回前台立即验证；隐藏时取消计时和在途请求。只有一个有效在途请求，迟到响应不能恢复旧内容。
- 请求和读取响应体共享 10 秒期限。失败或超时立即移除旧卡片，显示加载失败；下一次定时验证重试。返回前台先清除后台保留的快照，验证成功后展示。无动态显示空态，不回退到草稿或历史快照。
- `scripts/updates.mjs` 是受本机文件权限控制的操作验收 CLI，不是网页管理员认证替代品。

## 管理员与发布流程

在工作台点击「动态管理」，使用独立账号登录。新建动态后先保存草稿，再点击「预览与发布」，检查公开内容并确认发布。修改已发布内容先保存为私有草稿，再次发布才替换公开版本；撤回保留草稿。

- 密码使用随机盐和 scrypt 派生，只在私有配置保存哈希。会话令牌仅在 Cookie 中保留原值，服务器存储 SHA-256 摘要。
- 生产 Cookie 为 `__Host-110lab_admin`，Secure、HttpOnly、SameSite=Strict、Path=/；8 小时绝对期限与 30 分钟空闲期限。退出删除服务端会话；替换账号配置使旧会话失效。
- 登录有持久化每 IP 与全局预算，并限制并行密码校验。仅信任明确配置的代理 IP，其余连接不接受 X-Forwarded-For。
- 所有写入校验同源 Origin 和 CSRF，以及大小、字段和 revision。无匿名草稿读取。登录页可公开访问，但草稿 API 必须登录。
- `PORTAL_ADMIN_ENABLED=true`、`PORTAL_ADMIN_CONFIG`、`PORTAL_ADMIN_DATA` 与 `PORTAL_UPDATES_DATABASE` 必须同时正确配置。缺配置启动失败；默认仍关闭。认证文件 0600、目录 0700，不包含在发布包。
- `node server/admin-init-runtime.mjs CONFIG_PATH ACCOUNT_FILE [USERNAME]` 只用于私有目录首次初始化，已有文件拒绝覆盖。随机密码只写入 0600 账号交付文件，不打印到终端。
- 本次回滚只切换官网 HTTP 容器及路由，保留动态数据库、会话目录、账号配置与简历队列。回滚 0.6.0 后管理路由关闭，邮件与清理服务继续运行。

## 本地流程验收

使用 Node.js 24。将 `PORTAL_UPDATES_DATABASE` 指向专门的本地文件；CLI 和预览服务共享该文件。

```sh
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs create draft.json
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs edit ID REVISION draft.json
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs publish ID REVISION --confirm-public
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs withdraw ID REVISION
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite PORTAL_PREVIEW_PORT=4178 node scripts/preview.mjs
```

这些命令只用于本地验收；生产管理通过受保护的网页操作。单元与 HTTP 集成测试覆盖发布隔离、确认要求、并发 revision、恶意链接、未知字段、缓存更新和撤回。

## 页面同步边界

在页面持续可见、浏览器正常调度 JavaScript、公共接口能在 10 秒内完成的条件下，发布和撤回的设计同步上界为 70 秒：距下一次请求最多 60 秒，再加响应期限 10 秒。请求按开始时间计周期；失败清除也在同一期限内执行。标签页隐藏、设备休眠或主线程长时间阻塞时，不能承诺墙钟 70 秒；页面恢复前台后立即重新验证，旧快照先移除。公开接口的 max-age 本身不会更新 DOM，因此不能代替这个调度机制。

`tests/updates-sync.test.mjs` 使用可控时钟验证同步期限、后台无轮询、前台恢复、去重、响应体超时、取消以及迟到响应隔离。本地同一已打开页面的发布时间、撤回时间、HTTP 请求和 DOM 观察保存在 `artifacts/acceptance-v10/`。历史 v9 记录描述的是修改前的缓存缺陷，不能视作当前行为。

## 其他待决事项

- 简历在线投递复用已经配置的企业发信服务，收件人及备用投递地址为 f74974332@gmail.com。本次不修改邮件路由或执行真实外发测试。
- 招新考核沿用现有 HTTPS IP 目的地址。更换为子域名需要确认名称、域名解析、证书、应用 Origin/Cookie/MCP 配置及回滚方案；不属于此次本地页面改动。
- 官网 Android 清单只描述已校验的本项目 APK 0.2.2；不修改智评学堂应用服务器仍为 0.2.1 的下载元数据。
