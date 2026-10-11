# 招新邮件模板排版 0.16.2

图片上传后插在选定光标处，保留前后文字并独立成段。文字段落和图片支持左对齐、居中、右对齐；点击图片选中后可使用同一组排版按钮。

上传前保存编辑位置，异步上传与焦点切换不会将图片追加到末尾。上传期间禁止保存，切换模板或关闭弹窗后不再向旧编辑器插图。保留原有变量、链接、文字样式和私有 CID 图片；服务端图片检查、HTML 清洗、邮件逐人确认及发送权限不变。

使用现有原生编辑命令保留撤销记录，兼容性依据 [MDN execCommand 文档](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand) 并由实际 Chromium 回归验证。本次没有迁移编辑器依赖；原生命令已被标记 deprecated，后续更换编辑器时应保留这些行为测试。

验证：

- `node --test --test-timeout=60000 tests/recruitment-lifecycle.test.mjs tests/recruitment-workflow.test.mjs`：23 项通过，包含模板保存、变量替换、CID 附件、邮件 HTML 中间图片及段落对齐。
- `node scripts/verify-mail-editor.mjs`：需要 Playwright，可用 `PLAYWRIGHT_MODULE` 指定其模块路径、`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器路径；覆盖光标插入、异步失焦、图文对齐、保存重开、预览、键盘工具栏、切换模板、首位插图、撤销重做及窄屏。
- 构建后的招新页面使用本机隔离的虚构身份检查桌面和窄屏；不发送真实邮件，不修改生产模板。

发布仅替换招新页面及带版本标识的 HTTP 运行包。保留旧容器、旧代码、配置和 SQLite 备份；切换前拦截招新写入并等待上传退出，冻结发送后备份。考核、批改、成员同步和独立招新发信进程不重启。回滚恢复 HTTP 上游和 current 指针，保留当前业务数据库，不用旧库覆盖新资料。

插件客户端版本保持 0.15.1，刷新招新管理页面即可加载新编辑器。现有已保存模板不会自动改写；实际外部邮箱客户端的显示不作为本次测试结论。
