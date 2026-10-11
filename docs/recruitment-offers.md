# Offer 访问名单

入口：招新工作台 → Offer 名单。HR 和实验室管理员搜索并选择考核账号，核对姓名、学号、邮箱后确认加入；普通面试官无权读取或修改该名单。名单独立于候选人的录取阶段，不会自动导入、发放或发送通知。

授权按考核系统不可变的 `user.id` 绑定。搜索及加入时均由服务器读取考核目录，不接受浏览器提供的姓名、邮箱作为授权依据。撤销不依赖考核目录可用性。名单、回复及审计全部保存在现有外网服务器的 `recruitment.sqlite`，新增表 `recruitment_offers`；不修改已有候选人、简历或发信任务。

## 服务接口

管理接口使用现有飞书会话、HR/管理员角色、CSRF 和 Origin 校验，插件通过原有 embedded 路径访问：

- `GET /api/recruitment-admin/[embedded/]offers`：名单与答复。
- `POST /api/recruitment-admin/[embedded/]offer-accounts/search`：`{query}`，2–100 字符，最多20条，只返回考核候选人账号。
- `POST /api/recruitment-admin/[embedded/]offers`：`{requestId,assessmentUserId,revision,enabled,note}`。首次添加 revision=0；变更需要当前版本，请求幂等，角色变更实时生效。

考核服务专用接口，不接受浏览器会话或浏览器自报身份；需要专用 Bearer 凭据，带 Origin / Sec-Fetch-Site 的请求拒绝：

- `POST /api/recruitment-offer/access`：`{userId}` → `{allowed:false}`，或 `{allowed:true,grantId,revision,status}`。
- `POST /api/recruitment-offer/respond`：`{userId,grantId,revision,decision}`，decision 为 `ACCEPTED` 或 `DECLINED`。事务内检查授权、grantId、版本。相同答复重试幂等；已撤销、旧版本、不同答复返回409。

状态为 `PENDING` / `ACCEPTED` / `DECLINED`。撤销保留原答复，重新允许访问增加 revision 并重置为 PENDING；审计保留历史答复。考核端每次读取和提交均查询当前名单，不缓存允许结果；未登录先使用考核登录，名单外不展示邀请内容。

考核账号目录约定：

- `POST https://exam.110-lab.cn/api/internal/offer-users/search`，`{query}` → `{users:[{id,name,studentNo,email}]}`。
- `GET https://exam.110-lab.cn/api/internal/offer-users/<UUID>` → `{user:{id,name,studentNo,email}}`。

均使用同一专用 Bearer 服务凭据。目录只读、限量检索，仅 HR / 管理员能经招新服务调用。连接4秒超时，禁止重定向，限制响应大小，身份变化或上游错误不授予访问。

## 配置与发布

`PORTAL_OFFER_INTEGRATION_CONFIG` 指向私有 JSON：`{token,assessmentBaseUrl}`。token 至少43个 base64url 字符，assessmentBaseUrl 固定 `https://exam.110-lab.cn`。文件只允许所有者读写，禁止软链接；凭据不能进入浏览器、日志或仓库。

考核端复用专用 token，配置 `OFFER_SERVICE_TOKEN`、`OFFER_ACCESS_URL` 和 `OFFER_RESPONSE_URL`。两边必须完成鉴权联调后才添加正式名单。

新增表使用 `CREATE TABLE IF NOT EXISTS`，旧版招新与 worker 可继续使用原表。上线前使用 SQLite backup API 保存数据库、备份旧版本与当前代理配置。先启动并验证新服务，再仅切换官网服务块；回滚恢复旧容器路由，保留当前数据库，禁止用旧备份覆盖新投递或答复。若回滚到不支持 Offer 的版本，考核端校验失败，按默认拒绝处理。

验证：`node --test tests/recruitment-offers.test.mjs` 覆盖权限、精确身份、幂等、并发版本、撤销、答复持久化、重新授权、双进程可见性与服务认证；`npm test` 覆盖现有流程。`scripts/preview-recruitment-workspace.mjs` 提供仅本机虚构账号的界面验证，不加载生产凭据或发送通知。
