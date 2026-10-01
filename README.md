# 110 实验室官网与工作台

官网：https://110-lab.cn/

工作台：https://internal.110-lab.cn/

白色玻璃质感的实验室展示网站，包含随滚动变化的玻璃环、实验室介绍、项目孵化方式、智评学堂与一分钟视频，以及 2026 招新。工作台提供四个应用入口，MCP App 让插件从侧边栏打开工作台。

## 本地开发

使用 Node.js 24 LTS 和 npm。

```sh
npm ci
npm run build
npm test
npm run preview
```

打开 `http://127.0.0.1:4177/`；工作台预览为 `/workbench`。`npm run serve` 默认监听 8080，可通过 `PORTAL_HTTP_PORT` 修改。服务根据 Host 区分官网与工作台，公网 MCP 位于 internal 域名的 `/mcp/workbench-v5-1`。

## 更新内容

修改 `src/index.html` 中的介绍、项目和招新内容，新增项目时参照 `section.product-section` 的标题、简述、链接和媒体结构。`src/homepage-v6.css` 控制展示布局，`src/homepage-polish.css` 控制细节动效，`src/homepage-colors.css` 控制首屏之后的配色，`src/motion.js` 与 `src/motion.css` 控制首屏滚动叙事，`src/homepage-motion.css` 控制玻璃环悬浮、模块入场及按钮交互；尊重系统减少动态效果偏好，隐藏页面暂停持续动画。图片放在 `src/assets/`，同时补充 `server/assets.mjs` 的资源列表及 `scripts/package-release.mjs` 的发布清单。

`src/projects.json` 为工作台应用与 MCP 搜索目录。官网项目文案和目录需要一起维护。二维码为用户提供图片的无缩放裁切；智评学堂标志来自该项目原始品牌素材，请保留。

`src/assets/zhiping-promo.mp4` 完整保留提供的一分钟宣传片。0.5.3 使用 `zhiping-promo-1080p30.mp4`：1920×1080、30fps、H.264/AAC、总码率约 2.056Mbps、15,429,148 字节，播放索引位于文件开头。原生播放器点击播放时加载，服务支持分段请求与拖动进度。封面为视频截帧。

官网安卓版入口直接下载 `src/assets/zhiping-public-0.2.2.apk`，包名 `com.aihomework.public`，连接 `https://ai-grading.110-lab.cn/api/v1`。文件 SHA-256 为 `4c553d94f356047f09af41dab0db425b88a499cf78da6462cbd60eef8eed3c56`；签名与已有外网版一致。官网自己的下载清单为 `src/assets/zhiping-public-release.json`，不改变批改系统服务器的下载元数据。更新 APK 时须同时更新官网链接、下载清单、服务端资源清单、发布清单与下载验证。官网不展示需求平台，工作台仍保留其应用入口。

通过分支与 Pull Request 提交修改。CI 会构建、测试并产出发布包；合并代码不会自动修改生产环境。

0.6.0 新增 Uppy 站内简历投递、私有持久队列与独立 SMTP worker。默认关闭在线接收，邮件投递方式保留。完整流程、资料保留、部署配置与回滚见 [RECRUITMENT.md](docs/RECRUITMENT.md)。静态站点部署只能使用邮件投递；在线投递需要启用受限后端和独立 worker。

## 部署

`npm run build` 产出 `dist/index.html` 和 `dist/assets/`，官网可以作为静态站点部署。部署完整工作台与 MCP 服务时执行 `npm run release`，按 `release.json` 的 SHA-256 清单打包，或使用提供的 Dockerfile。

```sh
npm ci
npm run build
npm test
npm run release
node scripts/archive-release.mjs
```

发布包包含官网、工作台、MCP App、服务端运行包、配置、图片和视频，不含账号、凭据或旧内容数据库。Docker 方式：

```sh
docker build -t 110lab-website:latest .
docker run --name 110lab-website --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 110lab-website:latest
```

由现有 HTTPS 网关代理 `110-lab.cn` 与 `internal.110-lab.cn` 到该服务。生产更新应先启动独立候选版本，验证两个域名的页面和 MCP，再切换网关上游；保留旧版本以便回滚。服务器权限由维护者管理，不将 SSH 凭据放入仓库。

首页介绍和项目由源码管理，当前生产不提供在线内容编辑或管理员登录。旧数据库由服务器维护者私下保留作历史备份，当前服务不读取、不挂载它。

0.5.3 新增独立公开动态核心及只读 `/api/updates`，详见 [动态架构与接入边界](docs/UPDATES-ARCHITECTURE.md)。未配置 `PORTAL_UPDATES_DATABASE` 时为空内存存储；已发布快照可以展示，草稿不能公开读取。本次发布使用空内存存储，不携带本地验收数据库。可见页面每 60 秒验证，返回前台立即验证，隐藏页面停止轮询；请求 10 秒超时，失败清除旧动态。正常浏览器调度和网络条件下设计同步上界为 70 秒。工作台管理页面和受保护的写入接口等待可用管理员认证确认，不向匿名访问者开放。纯静态部署无法提供这个 API；动态展示需要完整服务。

## 插件

`plugin/110lab/` 保存插件清单。`open_110lab` 是侧边栏入口，其资源 URI 为 `ui://110lab/workbench/v0.5.1`，明确加载工作台；`search_110lab_projects` 为只读项目搜索。修改 UI 资源时提升资源 URI 和插件版本，避免沿用早期首页资源缓存。

## 素材与许可

第三方实现的许可保存在 `vendor/`。品牌标志与招新二维码属于实验室素材；复用前请联系实验室。未复制苹果官网的代码或品牌素材。
