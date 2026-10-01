# 公开动态的最小架构与接入边界

当前工作台是公网入口目录，不具备管理员认证。历史 CMS 已退役；其凭据和登录有效性没有在本轮验证。不能将旧账号配置文件存在视作可用认证。本轮不启用管理员页面、写入 HTTP/MCP 接口或新的 OAuth。

## 已实现的核心

- 独立 SQLite 文件，与考核、批改和历史首页数据库隔离。`PORTAL_UPDATES_DATABASE` 显式指定路径；未配置时只使用空的内存存储。
- 每条记录保存私有草稿和单独的公开快照。编辑已发布内容不会直接改变公开版本；再次发布需要明确确认适合公开。撤回立即移除公开快照并保留草稿。
- 创建、编辑、发布、撤回使用递增 revision；保存或发布旧 revision 会报冲突，避免覆盖别人的修改。
- `GET /api/updates` 与 HEAD 仅返回最多 50 条已发布快照。不存在匿名写入、草稿查询和自动业务资料导入接口。
- 受限富文本为段落、标题、列表、加粗和 HTTPS 链接。服务端严格校验类型、长度、字段和 URL；客户端只用 DOM/textContent 创建内容，不解析 HTML。
- 记录公开更新时间；公开读取使用内容 ETag 和短缓存，发布/撤回后响应 ETag 改变。可见首页每 60 秒重新验证，返回前台立即验证；隐藏时取消计时和在途请求。只有一个有效在途请求，迟到响应不能恢复旧内容。
- 请求和读取响应体共享 10 秒期限。失败或超时立即移除旧卡片，显示加载失败；下一次定时验证重试。返回前台先清除后台保留的快照，验证成功后展示。无动态显示空态，不回退到草稿或历史快照。
- `scripts/updates.mjs` 是受本机文件权限控制的操作验收 CLI，不是网页管理员认证替代品。

## 尚待认证授权后接入

工作台管理页面及保护后的创建、编辑、发布、撤回接口尚未实现。需要指定一个已验证、可用且授权本应用使用的认证来源；或者明确批准本项目恢复独立管理员登录。新 OAuth scope、会话密钥或账号权限不能由当前工作台身份推导获得。没有认证时保持写入路由关闭。

接入后由服务端验证管理员会话，写操作同时验证 Origin/CSRF、请求大小与 revision。发布页面必须独立显示即将公开的快照并要求确认；私有草稿不进入公共响应或 MCP 搜索。不会自动复制内部任务、考核记录或私人资料。

## 本地流程验收

使用 Node.js 24。将 `PORTAL_UPDATES_DATABASE` 指向专门的本地文件；CLI 和预览服务共享该文件。

```sh
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs create draft.json
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs edit ID REVISION draft.json
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs publish ID REVISION --confirm-public
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite node scripts/updates.mjs withdraw ID REVISION
PORTAL_UPDATES_DATABASE=artifacts/dynamic-preview/updates.sqlite PORTAL_PREVIEW_PORT=4178 node scripts/preview.mjs
```

这些命令只用于本地验收，不意味着生产已启用动态管理。单元与 HTTP 集成测试覆盖发布隔离、确认要求、并发 revision、恶意链接、未知字段、缓存更新和撤回。

## 页面同步边界

在页面持续可见、浏览器正常调度 JavaScript、公共接口能在 10 秒内完成的条件下，发布和撤回的设计同步上界为 70 秒：距下一次请求最多 60 秒，再加响应期限 10 秒。请求按开始时间计周期；失败清除也在同一期限内执行。标签页隐藏、设备休眠或主线程长时间阻塞时，不能承诺墙钟 70 秒；页面恢复前台后立即重新验证，旧快照先移除。公开接口的 max-age 本身不会更新 DOM，因此不能代替这个调度机制。

`tests/updates-sync.test.mjs` 使用可控时钟验证同步期限、后台无轮询、前台恢复、去重、响应体超时、取消以及迟到响应隔离。本地同一已打开页面的发布时间、撤回时间、HTTP 请求和 DOM 观察保存在 `artifacts/acceptance-v10/`。历史 v9 记录描述的是修改前的缓存缺陷，不能视作当前行为。

## 其他待决事项

- 企业邮箱继续使用官网已有 Gmail 投递地址。现有飞书主邮箱和公共邮箱可作为后续选项；公开地址、负责人员及外部附件接收仍需确认，本轮不发送或修改路由。
- 招新考核沿用现有 HTTPS IP 目的地址。更换为子域名需要确认名称、域名解析、证书、应用 Origin/Cookie/MCP 配置及回滚方案；不属于此次本地页面改动。
- 官网 Android 清单只描述已校验的本项目 APK 0.2.2；不修改智评学堂应用服务器仍为 0.2.1 的下载元数据。
