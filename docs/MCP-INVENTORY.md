# 工作台 MCP 清单

核对日期：2026-10-05。0.14.0 新增 39 个业务工具，保留原名称与需求平台连接。

## 已随 110lab 插件安装

插件配置有两个本机 stdio 服务，共 58 个工具定义。其中工作台 3 个辅助工具仅向应用页面开放；模型可直接使用公共入口 2 个、业务工具 39 个及需求平台 14 个工具。

### 110lab 工作台（5 个）

| 工具 | 用途 | 身份与副作用 |
|---|---|---|
| `open_110lab` | 打开工作台及应用目录 | 公共入口，无业务写入 |
| `search_110lab_projects` | 搜索官网展示的项目 | 公共只读；不是内部立项项目查询 |
| `connect_110lab_mail` | 发起/衔接实验室飞书登录 | 应用私有工具；本机 OAuth；建立登录态 |
| `complete_110lab_mail_login` | 完成本机回调或取消登录 | 应用私有工具；有会话副作用 |
| `get_my_110lab_requirement_todos` | 工作台显示个人需求、PR 待办 | 应用私有工具；只读本机连接的需求账号 |

远端资源入口：`https://internal.110-lab.cn/mcp/workbench-v6-1`。
本机入口：`plugin/110lab/mcp/portal-bridge.mjs`。
资源 URI 保持 `ui://110lab/workbench/v0.8.7`，避免更换插件嵌入存储分区。

### 110lab_requirements 需求平台（14 个）

| 工具 | 用途 | 类别 |
|---|---|---|
| `my_requirement_todos` | 当前处理人为自己的需求 | 只读 |
| `requirements_list` | 需求筛选列表 | 只读 |
| `requirement_get` | 单条需求详情 | 只读 |
| `requirement_release_readiness` | 发布就绪检查 | 只读 |
| `requirement_operation_get` | 查询异步操作实际结果 | 只读 |
| `pull_requests_list` | 合并请求列表 | 只读 |
| `pull_request_get` | 合并请求详情 | 只读 |
| `requirement_trigger_review` | 发起需求 AI 评审 | 写入/启动任务 |
| `iteration_trigger_available_reviews` | 按迭代补跑评审 | 批量启动任务 |
| `requirement_update_fields` | 更新需求字段 | 写入 |
| `requirement_update_personnel` | 修改需求人员 | 写入 |
| `requirement_transition_status` | 流转需求状态 | 写入 |
| `pull_request_set_reviewers` | 设置 GitHub 评审人 | 外部写入，可能触发通知 |
| `pull_requests_refresh` | 刷新 PR 同步数据 | 触发同步 |

服务端：需求平台 `server/modules/requirements/requirements-mcp.service.ts`。
插件入口：`plugin/110lab/mcp/requirements-bridge.mjs`，凭据只发送到固定的需求平台入口。
认证：个人 MCP Key，绑定妙搭用户及飞书人员 ID；不使用超级管理员的共享凭据。权限仍由需求平台核验。
写入遵守上游幂等键和异步操作状态约定。`accepted` 不代表完成；失败或超时不得盲目重放。

## 考核系统另有 MCP（未合并到工作台插件）

远端入口：`https://exam.110-lab.cn/mcp`。旧 IP 入口仍保留兼容。

| 工具 | 远端 | 考生本机桥接 | 行为 |
|---|---|---|---|
| `exam_status` | 有 | 有 | 读取本人考核、截止时间、仓库与材料收据 |
| `test_connection` | 有 | 有 | 记录连接检查，有写入；不会开始计时 |
| `submit_materials` | 有 | 无 | 创建限定考核/仓库版本的材料上传凭证 |
| `find_candidate_files` | 无 | 有 | 在已授权范围内发现文件元信息 |
| `submit_files` | 无 | 有 | 上传所选原始文件并确认收据 |

考核认证限定到考生自己的 enrollment。此次管理员网页飞书认证不扩大这些工具权限，不开放管理工具，也不能通过 MCP 自动交卷。

## 新增业务 MCP（39 个）

共用工作台服务，每次调用核验本人 OAuth 授权、实时角色及对象权限。参见 [实现说明](MCP-BUSINESS.md)。

| 工具 | 用途 | 授权 |
|---|---|---|
| `lab_whoami` | 读取本人身份和已授权能力 | `lab:identity` |
| `lab_members_search` | 查找实际实验室成员 | `lab:directory:read` |
| `lab_operation_get` | 查询操作和确认状态 | `按对象用途` |
| `lab_file_upload` | 上传用户明确指定的附件 | `按对象用途` |
| `lab_attachment_read` | 读取有权访问的私有附件 | `按对象用途` |
| `lab_projects_list` | 筛选内部立项项目 | `projects:read` |
| `lab_project_get` | 读取项目和里程碑详情 | `projects:read` |
| `lab_project_save` | 新建或编辑自由探索项目 | `projects:write` |
| `lab_project_apply` | 申请成为共同项目 | `projects:write` |
| `lab_project_review` | 审核项目申请 | `projects:review` |
| `lab_project_milestone_save` | 新增里程碑或完成重开 | `projects:write` |
| `lab_honors_list` | 筛选可见荣誉 | `honors:read` |
| `lab_honor_get` | 读取荣誉与审核历史 | `honors:read` |
| `lab_honor_save` | 填写荣誉草稿 | `honors:write` |
| `lab_honor_certificate_attach` | 绑定已上传证书 | `honors:write` |
| `lab_honor_submit` | 提交荣誉审核 | `honors:write` |
| `lab_honor_withdraw` | 撤回荣誉审核 | `honors:write` |
| `lab_honor_review` | 审核荣誉 | `honors:review` |
| `lab_candidates_list` | 筛选官网招新候选人 | `recruitment:read` |
| `lab_candidate_get` | 读取候选人资料及流程记录 | `recruitment:read` |
| `lab_recruitment_options` | 读取模板变量和当前配置 | `recruitment:read` |
| `lab_recruitment_template_save` | 维护招新邮件模板 | `recruitment:write` |
| `lab_candidate_record` | 记录初筛考核或面试安排 | `recruitment:write` |
| `lab_candidate_decide` | 记录管理员录取决定 | `recruitment:decide` |
| `lab_recruitment_notice_preview` | 逐人生成面试通知预览 | `recruitment:write` |
| `lab_recruitment_notice_send` | 发送已逐人确认的面试通知 | `recruitment:send` |
| `lab_mail_send` | 发送已确认的公共邮箱草稿 | `mail:send` |
| `lab_update_publish` | 发布已确认的官网动态 | `updates:publish` |
| `lab_update_withdraw` | 撤回已确认的官网动态 | `updates:publish` |
| `lab_mailboxes_list` | 查询授权公共邮箱及能力 | `mail:read` |
| `lab_mail_messages_list` | 搜索授权邮箱来信 | `mail:read` |
| `lab_mail_message_get` | 读取一封邮件及附件引用 | `mail:read` |
| `lab_mail_draft_save` | 准备邮件草稿和实际发信预览 | `mail:draft` |
| `lab_updates_list` | 查询官网动态和草稿 | `updates:read` |
| `lab_update_get` | 读取动态草稿及当前公开版本 | `updates:read` |
| `lab_update_draft_save` | 保存官网动态草稿 | `updates:write` |
| `lab_update_publication_preview` | 预览公开发布或撤回 | `updates:publish` |

两个批改系统本次不做 MCP 或身份改造。

## 保留的边界

- `search_110lab_projects` 名称容易被误解为内部立项搜索；现在只查公开展示内容。
- `connect_110lab_mail` 虽保留历史名称，已用于实验室共享身份。此次不改名，避免破坏已有页面调用。
- 需求平台 MCP 的个人连接与工作台网页飞书会话是两份授权，不能宣称同一会话；切换飞书账号不会自动更换本机个人 Key。
- 妙搭网页保留首次飞书官方授权，这是本次用户明确接受的范围。
- 业务工具使用明确用途和权限范围的授权流程；不能把当前只用于会话连接的 `mail:session` 悄悄扩大为发信、审核或管理权限。
- 验证未发送真实邮件、发起真实评审或通知；notify 接通 IMAP/SMTP，根域邮箱待配置，招新发送保持模拟。


招新改为工作台持久化后，`lab_recruitment_feishu_preview` 与 `lab_recruitment_feishu_sync` 已撤下，旧表格配置及授权不会触发写入。面试官通知和回填由招新工作台处理；飞书应用仅发送面试安排入口，不修改其已有事件订阅。
