# 公共邮箱管理候选

候选版本：网站 0.8.5 / MCP 工作台 0.8.4。此文档描述代码能力，不代表已经发布或完成真实飞书登录。

## 功能与权限

工作台应用卡片打开 `/mail/embedded`；独立网页为 `https://internal.110-lab.cn/mail`。管理员配置和操作记录都在公共邮箱管理内部。

- 飞书企业登录验证 `tenant_key + union_id`，只接受指定租户的 `enterprise_email`，不使用联系人邮箱或姓名授权。
- 周灿宇的已核对身份由服务器私有配置指定。首次建库初始化唯一超级管理员，绝不把第一个访问者设为管理员。真实身份标识不进入仓库。
- 成员先成功登录，再由超级管理员添加为普通管理员。只有超级管理员可以修改名单、查看成员和操作记录。
- 转让对象必须是已验证的普通管理员；转让原负责人降为普通管理员。操作原子提交，每次校验实时角色、修订号、CSRF 和五分钟内的身份确认。
- 撤权立即影响所有旧会话；重启不会重新授予初始负责人。修改初始身份配置会拒绝启动并要求明确迁移。
- 普通管理员角色供后续受限人工发信接入，当前没有发信端点或 SMTP 密钥挂载。

`noreply@110-lab.cn` 是飞书公共邮箱。当前入口打开飞书邮箱，用户仍需在“其他账号”中选择它；自动切换且进入可编辑写信窗口没有验证成功。飞书公共邮箱成员权限仍由飞书管理，官网角色不会修改它。

`noreply@notify.110-lab.cn` 是现有阿里云 DirectMail 系统发信地址，不是飞书收件箱。人工发信保持关闭，本次不改系统通知、考核或简历投递的发送链路。

## 飞书登录配置

需用户指定并配置一个企业自建应用，不自动复制 CLI 的 App Secret、不创建新密钥、不添加付费服务。

1. 应用权限只需要 `contact:user.employee:readonly`，用于企业邮箱身份验证。没有邮箱读取、邮件发送或 `offline_access` 权限。
2. 注册精确回调 `https://internal.110-lab.cn/mail/auth/callback`，应用可用范围包括要使用的成员。
3. 通过服务器私有文件交付配置，文件应归容器 UID 1000 所有、权限 0600；父目录 0700。不能放进 release、Git、构建包或聊天记录。

私有 JSON 字段：`appId`、`appSecret`、`tenantKey`、`bootstrapUnionId`、`bootstrapEmail`、`bootstrapName`。后四项绑定已经核对的初始负责人，不能使用未验证的同名账号替代。

建议宿主配置路径 `/opt/110lab-homepage/private/mail-config.json`，数据路径 `/opt/110lab-homepage/private/mail`。只给 HTTP 容器新增以下配置：

```text
PORTAL_MAIL_ENABLED=true
PORTAL_MAIL_CONFIG=/app/private/mail-config.json
PORTAL_MAIL_DATA=/app/private/mail
```

新增一个只读配置挂载和一个可写私有数据挂载；不挂载现有系统 SMTP 配置。网关可信代理 IP 沿用已核对的 recruitment trusted proxy 配置，不能信任任意 X-Forwarded-For。

## 登录持久化与清理

OAuth 使用 state、PKCE S256、浏览器回调绑定和一次性回传码。插件通过独立窗口授权，然后同源 opener 回传；客户端不支持 opener 时，用户可显式输入回传码。单凭登录链接和发起 cookie 不能获取另一浏览器的身份。

网页会话 cookie 为 HttpOnly / Secure / SameSite=Strict；嵌入会话单独使用 SameSite=None / Partitioned，不能重命名普通 cookie 来复用身份。飞书授权 token 只在当次请求中使用，不保存到数据库、前端、日志或 localStorage。

会话数据库只保留随机令牌的哈希，绝对期限八小时、闲置期限三十分钟；登录流程五分钟到期，每分钟清理。重启保留尚有效的会话。角色与审计数据库持久保存；角色读取不缓存。每 IP 每十五分钟最多十次发起，另有全局上限。

尚须在真实 Codex 客户端验证外部窗口、一次性回传及 Partitioned cookie 兼容性；虚构 HTTP 和浏览器测试不等于真实飞书 SSO 已通过。

## 发布与回滚

应用配置缺失时登录关闭；显式启用但配置无效时拒绝启动。当前候选等待真实应用配置，不替换现网版本。

发布前完成 `npm run build`、`npm test`、`npm run release` 及 `scripts/verify-mail-release.mjs` 等独立 bundle 校验。应检查公共首页哈希、视频、APK 和旧考核/需求/动态管理入口，确认现有动态及简历数据库未改变。

首次启用前记录现网容器 ID、release hash、Caddy 标记段和 worker ID。已有 mailbox 数据库时，使用 SQLite backup API 各自备份 sessions/access DB，私有备份 0600；首次为空时记录尚无数据库。不能在 WAL 活跃时只复制主文件。

候选 HTTP 容器在独立端口完成健康检查和登录验证后，才修改现有 Caddy 的两个门户引用并 reload。不变更其它站点路由、不重建考核、SMTP worker 或 cleaner。

回滚切回旧 HTTP 容器和原 Caddy 引用；关闭新增 mailbox 配置，保留新数据库。绝不能把旧角色数据库恢复到 live 路径，因为这会撤销已生效的转让或重新授予已撤销权限。会话需要单独失效处理，不能靠恢复角色快照来退版本。

## 验证范围

当前自动测试使用虚构身份和本机 HTTP，不向真实收件人发信。浏览器验证覆盖添加、转让、移除、操作记录及 320px 布局。真实 OAuth 与公网发布待配置后验证。

官方依据：

- [授权码和 PKCE](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)
- [OAuth v3 用户访问令牌](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3)
- [获取用户身份信息与企业邮箱权限](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)
