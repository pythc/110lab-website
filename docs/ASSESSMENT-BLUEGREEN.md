# 考核无中断发布方案

状态：2026-10-05 已完成隔离演练、生产备份及两份网关配置验证。**尚未切换公网，尚未执行生产 007 迁移，插件和门户候选版本 0.13.0 未发布。**

## 不停服的具体方式

| 角色 | 版本和职责 | 生命周期 |
|---|---|---|
| 原服务 `lab110-assessment` | 当前线上代码；唯一后台任务执行者 | 全程保留，不重启、不停止 |
| 新 HTTP `lab110-assessment-sso-0130` | 新认证代码；后台任务禁用 | 先启动、验收，再接网关流量 |
| 回滚 HTTP `lab110-assessment-rollback-0130` | 原后端和原首页，加上新旧两版静态资源；后台任务禁用 | 回滚时先启动并验收，再接网关流量 |

三个角色共用原 PostgreSQL schema、会话密钥和 `/opt/110lab-assessment/data`。新 HTTP 不复制答卷、不生成新截止时间、不轮换考生 Cookie；不存在把旧快照覆盖回生产库的步骤。考核旧 IP 和 `exam.110-lab.cn` 两个入口必须一起切换。

迁移 007 只新增 SSO 的三张表及索引；涉及旧表的外键锁等待最多 2 秒，失败会自动回滚并让候选容器启动失败，旧服务继续接流量。它是有界短暂锁等待，不能描述为数据库完全不加锁。

原有请求在原 HTTP 实例中继续完成。网关使用 Caddy 热加载；不执行容器重启。Caddy 的配置加载是原子替换，失败时保留原配置，见 [官方 API 文档](https://caddyserver.com/docs/api)。业务数据、静态资源和后台任务的兼容性另外通过下述演练验证。

## 锁定的制品

| 制品 | 镜像 digest |
|---|---|
| 当前原服务 | `sha256:465339fd9810955ed8e3e156d1c920be92eb3da8da0009df642931a22c80b5d3` |
| 已演练的新 HTTP | `sha256:ff99ec7457c482b353f25a82f267fa0a8e0835f6ba9407d80ba6de6a5bd632d4` |
| 已演练的回滚 HTTP | `sha256:e06948597fb83a3d93e5d35f8df650216fe517478e563ddc803075a03c4a6c6e` |

新镜像直接叠加在原镜像上，不重新安装依赖。两份镜像保留原来的 97 个静态资源；回滚镜像包含总计 138 个资源，以支持切换前后已打开页面的延迟加载。

已校验制品归档：`/opt/110lab-assessment/rehearsals/20261005-8d3b0806be/verified-build.tar.gz`，SHA-256 `e736343fe263b022091632db9c68868120c9b5b763adab7eebd9fb977fdd13e5`；其中编译文件与上述演练镜像的构建输入逐文件一致。

考核源码基线是 `20261004-oauth-compat-067386dbc9`。补丁及逐文件 SHA-256 在 `integrations/assessment/assessment-sso.patch`、`baseline.json`。已验证补丁可应用于线上取回的基线，且结果与测试源码逐文件一致。

## 已完成的备份与路由准备

生产目录：`/opt/110lab-assessment/operations/sso-bluegreen-preflight-20261004T212006Z`。

- 考核 schema 的一致性 PostgreSQL 自定义格式备份 232,587 字节，`pg_restore --list` 成功。没有执行真实数据恢复测试。
- 门户 12 个 SQLite 库通过在线 backup API 备份，逐个 `quick_check=ok`。
- 原网关配置、容器元数据、原进程启动时间和 SHA-256 清单已保存。含配置和凭据的元数据只存在服务器 0700 目录内的私有文件，不进入 Git。
- `candidate.Caddyfile` 和 `rollback.Caddyfile` 均通过线上相同 Caddy 镜像的 `adapt`、`validate`。
- 对比解析后的 JSON，只有考核的两个 upstream 改变，其他站点配置相同。
- 原网关 SHA-256：`1887b1c7ec2dc17fe9cdcaadc32857dc91f7e8b8b91c3c3acacec4111afcfcb8`；原文件 inode：`1765688`。
- 候选网关 SHA-256：`4c3e6da424d5c1d95a59dbeea539a9e924c335a9300c50b31e4732bad80197d0`。
- 回滚网关 SHA-256：`d010e98f0cf6c47f525646a16f003bd54d3f32a54f2f9e5b8d8132c4b96580b5`。

这些是本次准备时的基线。正式发布前重新备份，并重查镜像、路由、进程、会话密钥/存储挂载以及剩余内存；任一基线变化就重新生成路由计划，不能覆盖别的应用后续发布。

## 正式发布顺序

1. 核对源码提交和制品校验和；正式发布使用已演练 digest。保存门户旧版本、插件完整清单、当前指针及配置快照。
2. 先并行启动门户 0.13.0，启用 `PORTAL_ASSESSMENT_SSO_ENABLED=true`；现有飞书凭据和回调不变。验证内部 SSO 端点、匿名拒绝、管理员校验及招新 dry-run；按现有门户发布流程热切流量，保留原门户回滚容器。门户发布会改变共享网关：核对其差异后，以新哈希重新准备、验证考核两份路由计划；本报告的两份静态文件不能直接覆盖门户的新路由。
3. 新考核 HTTP 沿用原环境，只增加 `LAB_SSO_ENABLED=true`、`LAB_SSO_FREEZE_FILE=/run/110lab/sso-frozen`、`ASSESSMENT_WORKERS_ENABLED=false`。创建专用控制目录并只读挂入 `/run/110lab`；目录 0755，可由运维写入冻结文件，运行用户只能读取。加入原 Docker 网络，不新增公网端口。
4. 等待健康检查和迁移 007 完成。验证旧资源哈希、登录和普通考生 API 不受 SSO 服务状态影响，认证端点拒绝错误凭据。确认后台任务禁用日志。记录新旧 HTTP 容器与原 worker 的角色。
5. 确认网关哈希仍等于准备基线，原位写入已验证的候选 Caddyfile，保持 bind mount 的 inode，执行 `caddy reload`。禁止用 `docker restart` 或改文件路径替换 bind mount。若加载失败，恢复磁盘文件到旧内容；旧运行配置和原 HTTP 保持服务。
6. 验证公网首页、登录页、健康接口、旧 IP 兼容入口、公开下载及嵌入 CSP；确认当前答卷的 `started_at`、`deadline`、题目版本和材料记录没有被发布步骤改动。候选人自行操作造成的合理状态变化单独核对。
7. 更新 current 指针和运行角色元数据，明确原 `lab110-assessment` 仍负责后台任务；后续运维不能只看这个固定容器名判断 HTTP 版本。最后发布插件 0.13.0，保留既有 resource URI、origin、MCP 工具、默认提示和凭据配置。
8. 在真实 Codex 侧栏完成一次飞书管理员进入考核和动态管理的验收。隔离演练不替代这一步。需求平台保留首次官方授权；两个批改系统维持独立账号。

## 回滚顺序与竞态保护

1. 启动锁定的回滚 HTTP，使用原考核环境与共享存储，加 `ASSESSMENT_WORKERS_ENABLED=false`；通过健康检查和静态资源完整性检查。保持原服务和新 HTTP 运行。
2. 在新 HTTP 的控制目录创建 `sso-frozen` 文件。新认证入口、回调和会话检查随即停用，普通考生功能不受影响。
3. 在 assessment schema 中执行以下单个事务。回调也获取相同事务锁并在锁内再次检查冻结文件，因此不会在撤销完成后生成新的 SSO 会话。

```sql
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('lab-sso-issuance'));
DELETE FROM sessions
USING lab_sso_sessions
WHERE sessions.id = lab_sso_sessions.session_id;
COMMIT;
```

4. 若事务失败，保持 SSO 冻结，重试撤销；**撤销未完成时不把流量切回旧认证代码**。核验关联 SSO 会话数为零，原考生会话和上传票据仍存在。
5. 基于当前配置生成只替换考核 upstream 的回滚文件并验证；若其他应用发布导致共享网关哈希改变，重新计算，不能直接用整份历史 Caddyfile覆盖。原位写入并热加载，切至回滚 HTTP。
6. 确认回滚 HTTP 正常后，让新 HTTP 继续处理已开始的请求，保留到它的连接排空；此阶段不为了清理而强制停止容器。原 worker 保持运行。保留新增三张表及审计，不执行 down migration、不恢复旧业务库。
7. 同步 current 指针和 HTTP/worker 角色元数据。核对门户与插件恢复顺序，保留底层实验室登录能力。门户回滚不撤销原考生认证。后续重新启用 SSO 前清理旧 flow/grant 并重新校验权限。

## 演练证据与边界

`integrations/assessment/rehearsal-report.json` 记录已完成的一次隔离演练。使用外网服务器现有的 PostgreSQL、旧/新考核镜像和 Caddy 镜像，在禁止外网访问的独立 Docker 网络、临时数据库与虚构账号中运行。无生产数据库挂载、无公开测试端口、无真实发信。

- 连续 185 次身份请求：0 失败，观测最大 105 ms，覆盖新迁移及前后两次热加载。此为低负载功能演练，不是容量或网络稳定性保证。
- 切换与回滚时，特意用数据库锁保留一条旧请求，热加载后释放锁，两次请求均成功返回。
- 原 Cookie、截止时间、题目快照与仓库锁定版本保持一致。
- 2,097,181 字节原始材料分别在旧 HTTP、新 HTTP、回滚 HTTP 上传，最终完成且重复完成返回同一收据，随后交卷成功。
- 原版 97 个静态资源在新版可用；两版共 138 个资源在回滚后可用，逐文件核对响应 SHA-256。
- 回滚只撤销新增 SSO 会话；普通考生会话继续可用；新 HTTP/回滚 HTTP 后台任务均为禁用。
- 本地真实 PostgreSQL 回归：考核原有与新增认证用例 66 通过，1 个原有 1 GiB 大文件用例跳过；另验证锁冲突时新增迁移回滚、随后可重试且旧会话不变。门户 165 项通过；考核客户端 16 项通过。
- 演练完成后已移除本次测试容器与网络；生产所有既有运行容器的 ID、启动时间和共享网关配置保持不变。

演练过程中修正了两处测试夹具问题：虚构答卷需包含现行时长快照字段；Node fetch 访问隔离 Caddy 管理端点需携带其配置允许的 Origin。业务代码未因这两项更改。
