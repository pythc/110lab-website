# 110 实验室官网与工作台

官网：https://110-lab.cn/

工作台：https://internal.110-lab.cn/

白色玻璃质感的实验室展示网站，包含随滚动变化的玻璃环、实验室介绍、项目制与研究分享、智评学堂等项目，以及 2026 招新。工作台提供四个应用入口，MCP App 让插件从侧边栏打开工作台。

## 本地开发

使用 Node.js 24 LTS 和 npm。

```sh
npm ci
npm run build
npm test
npm run preview
```

打开 `http://127.0.0.1:4177/`；工作台预览为 `/workbench`。`npm run serve` 默认监听 8080，可通过 `PORTAL_HTTP_PORT` 修改。服务根据 Host 区分官网与工作台，公网 MCP 位于 internal 域名的 `/mcp/workbench-v5`。

## 更新内容

修改 `src/index.html` 中的介绍、项目和招新内容，新增项目时复制项目区的 `<article>` 并调整文案与链接。`src/homepage-v5.css` 控制展示布局，`src/motion.js` 与 `src/motion.css` 控制滚动叙事。图片放在 `src/assets/`，同时补充 `server/http.mjs` 的资源列表及 `scripts/package-release.mjs` 的发布清单。

`src/projects.json` 为工作台应用与 MCP 搜索目录。官网项目文案和目录需要一起维护。二维码为用户提供图片的无缩放裁切；智评学堂标志来自该项目原始品牌素材，请保留。

通过分支与 Pull Request 提交修改。CI 会构建、测试并产出发布包；合并代码不会自动修改生产环境。

## 部署

`npm run build` 产出 `dist/index.html` 和 `dist/assets/`，官网可以作为静态站点部署。部署完整工作台与 MCP 服务时执行 `npm run release`，按 `release.json` 的 SHA-256 清单打包，或使用提供的 Dockerfile。

```sh
npm ci
npm run build
npm test
npm run release
node scripts/archive-release.mjs
```

发布包包含官网、工作台、MCP App、服务端运行包、配置和图片，不含账号、凭据或旧内容数据库。Docker 方式：

```sh
docker build -t 110lab-website:latest .
docker run --name 110lab-website --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 110lab-website:latest
```

由现有 HTTPS 网关代理 `110-lab.cn` 与 `internal.110-lab.cn` 到该服务。生产更新应先启动独立候选版本，验证两个域名的页面和 MCP，再切换网关上游；保留旧版本以便回滚。服务器权限由维护者管理，不将 SSH 凭据放入仓库。

首页内容已回到源码管理，不提供在线内容编辑或管理员登录。旧数据库由服务器维护者私下保留作历史备份，当前服务不读取、不挂载它。

## 插件

`plugin/110lab/` 保存插件清单。`open_110lab` 是侧边栏入口，其资源 URI 为 `ui://110lab/workbench/v0.5.0`，明确加载工作台；`search_110lab_projects` 为只读项目搜索。修改 UI 资源时提升资源 URI 和插件版本，避免沿用早期首页资源缓存。

## 素材与许可

第三方实现的许可保存在 `vendor/`。品牌标志与招新二维码属于实验室素材；复用前请联系实验室。未复制苹果官网的代码或品牌素材。
