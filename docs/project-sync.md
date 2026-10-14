# Workbench project registration

New workbench projects are registered as project classifications in the requirements platform. A local project and its durable queue entry commit in one SQLite transaction. HTTP callers may provide a stable UUID `requestId`; the web form retains that ID for retries. MCP project creation uses its existing durable request journal and the same queue.

The worker rechecks the owner's active directory membership. It looks up the source project UUID before registering it, so a lost response or restart never requires a second project. The requirements service enforces the source UUID with a database primary key, compares the original name and summary, and exposes registered names alongside the existing Bitable options. It does not create placeholder requirements or replace field metadata.

## Configuration

- `PORTAL_PROJECT_SYNC_ENABLED=true`
- `PORTAL_REQUIREMENTS_PROJECT_CONFIG=/run/110lab/requirements-project.json`
- The read-only secret file is a regular, non-symlink file with mode 0600 and contains `{ "openApiKey": "..." }`.
- The key allows only `POST /openapi/workspace/projects/sync` and `POST /openapi/workspace/projects/lookup` in the existing requirements application.

Directory and network failures are retried with backoff. Configuration, authorization or content conflicts are blocked until the owner/administrator uses **重新同步** after resolving the cause. Pending work survives process termination; expired leases are recovered. Successful linkage fills only an empty requirements URL and increments the project revision. Manually entered links are retained.

Only new creations while the feature is enabled are registered. Existing projects, renames and deletions are not bulk synchronized. Projects sharing a name share the existing classification semantics.

## Release and rollback

Publish the additive requirements registry and its APIs first, verify the scoped key, then enable the portal worker. Back up SQLite before changing the portal image. Retain the previous container and reverse-proxy configuration. Rollback switches traffic and stops the new worker; do not drop `requirement_project_sync` or `portal_project`, or restore an old database over new writes. Re-enabling the worker recovers pending registrations by source UUID.

## Verification

The focused tests cover duplicate HTTP requests, conflict responses, SQLite lease recovery, a lost remote response after commit, inactive owners, directory outages, shutdown draining and protection of manually supplied links. Both the web and MCP creation paths use the tested workspace store.

## V2: 项目管理与双向分类目录

2026-10-14 新增：工作台全量项目补齐和修改快照，需求分类反向导入为“待完善”，明确保存立项后关联负责人。V2 outbox (`requirement_project_sync_v2`) 与旧 worker 隔离；同步单调版本和内容摘要拒绝旧结果。旧表保留用于代码回退，不删除/覆盖持久化业务数据。

项目改名保留别名；需求平台归一显示与筛选，无需批量覆盖原始需求。项目分类移除不等于删除项目，历史记录保留，归档继续从工作台控制。平台管理页每 30 秒刷新；目录每 30 秒拉取；同步任务每 2 秒处理一项，失败退避重试。
