# 自选 Our Choice

一个本地优先的内容订阅与整理工具：今日页只展示你主动选择的来源，发现页则通过人工合集帮助你扩圈，不把推荐偷偷混进订阅流。

完整的用户指南、能力边界、项目结构和 API 说明见[在线文档](https://billshiyaozhang.github.io/our-choice/)或仓库内的 [`docs/`](./docs/)。本地开发时也可访问 [http://localhost:3000/docs/](http://localhost:3000/docs/)。

## 已实现

- 有限的“今日”收件箱，支持类型筛选、新增筛选、搜索、稍后看与安静阅读
- 频道和具体内容在站内主显示区打开，提供固定返回按钮与同页降级入口
- 记录查看时间，并以订阅时刻为基线判定新增；刚加入来源的历史内容不会全部变成新增
- RSS / Atom / 播客订阅识别、网站 Feed 自动发现与按需刷新
- 十二个主流中文内容平台的链接模式，以及可选的 RSSHub + Radar 自动转换，包括 B站、微信、知乎、小红书、抖音、快手、微博、头条、百家号、豆瓣及主流音频平台
- 订阅暂停、移除、单源刷新与最多 3 路并发刷新
- 本地合集创建、收录、移除与订阅精选合集
- 设备内发现偏好、不感兴趣与明确的推荐原因
- 浏览器本地持久化、跨标签页同步、离线提示、JSON 导入导出
- 内嵌来源在浏览器与平台允许第三方 Cookie / Storage Access 时可复用登录会话；应用不读取或保存密码、Cookie
- 桌面、平板和移动端响应式布局，键盘焦点、弹窗焦点约束与减少动效支持

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

如需把没有公开 Feed 的平台页面转换为订阅，请连接一个由你选择的 RSSHub 实例：

```bash
RSSHUB_BASE_URL=http://127.0.0.1:1200 npm run dev
```

实例配置了 `ACCESS_KEY` 时，同时设置仅服务端使用的 `RSSHUB_ACCESS_KEY`。应用通过 RSSHub 的 Radar 规则 API 发现路由，不默认使用公共实例，也不会把实例地址或密钥保存到浏览器。

生产模式：

```bash
npm run build
npm run start
```

## Docker

```bash
docker compose up --build
```

打开 [http://localhost:3000](http://localhost:3000)。容器只运行本地站点，不包含 OpenAI Sites 部署配置。

## Dev Container

仓库包含 Compose 驱动的 Dev Container。在支持 Dev Containers 的编辑器中重新打开仓库后：

- `workspace` 开发容器挂载当前源码并自动执行 `npm ci`
- 独立的 RSSHub sidecar 自动启动
- 应用通过 `RSSHUB_BASE_URL=http://rsshub:1200` 访问 RSSHub
- 开发服务器监听容器网络，编辑器自动转发应用的 `3000` 端口

如需启用 RSSHub 访问密钥，请在启动编辑器前给宿主机设置 `RSSHUB_ACCESS_KEY`；它会同时传给应用和 RSSHub。修改 `.devcontainer/` 后需执行 **Dev Containers: Rebuild Container**。

## 数据与隐私

- 订阅、查看时间、新增基线、合集和发现偏好保存在当前浏览器的 `localStorage` 中。
- 清理浏览器站点数据会删除本地内容；可在“设置 → 数据与隐私”中导出 JSON 备份。
- RSS 由本地服务端路由按需请求，解决浏览器 CORS 限制；请求时来源站点仍会收到正常网络访问。
- 中文内容平台在未配置 RSSHub、没有匹配 Radar 规则或转换失败时使用站内链接模式；成功转换的来源可像普通 Feed 一样按需刷新。
- 外部页面优先在受限 iframe 中加载。若来源通过 `X-Frame-Options` 或 CSP 禁止内嵌，界面会保留“在当前页打开”的降级入口。
- 来源平台的登录状态由浏览器 Cookie 策略管理。平台若在 iframe 中登录后仍显示未登录，请使用查看器中的“在当前页打开并登录”进入第一方登录环境，再通过浏览器返回。JSON 备份不会包含密码或 Cookie，只会包含非敏感的平台地址与最近打开时间。
- 源抓取限制协议、端口、重定向次数、响应时间和体积，并拒绝本地网络地址。

## 验证

```bash
npm run lint
npm test
```

`npm test` 会完成生产构建，并验证首页渲染、本地优先约束、URL 安全校验、中文内容平台链接模式和文档站集成。

## 文档维护与发布

文档源文件位于 `docs/`。`npm run dev` 和 `npm run build` 会先将它同步到 `public/docs/`，不要直接修改生成目录。

GitHub Actions 会在 `main` 分支的文档发生变化后把 `docs/` 发布到 GitHub Pages。仓库的 Pages 发布源需要设置为 **GitHub Actions**；整个流程不使用 OpenAI Sites。

## 上游项目与许可证

可选转换能力使用 [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) 提供的 Feed 与 Radar 规则 API，并沿用 [DIYgod/RSSHub-Radar](https://github.com/DIYgod/RSSHub-Radar) 的页面发现模型。两者均采用 AGPL-3.0；本仓库不复制其源码，Docker Compose 中的 RSSHub 作为独立网络服务运行，请按上游许可证与部署文档使用。
