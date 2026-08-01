# 自选 Our Choice

一个本地优先的内容订阅与整理工具：今日页只展示你主动选择的来源，发现页则通过人工合集帮助你扩圈，不把推荐偷偷混进订阅流。

完整的用户指南、能力边界、项目结构和 API 说明见[在线文档](https://billshiyaozhang.github.io/our-choice/)或仓库内的 [`docs/`](./docs/)。本地开发时也可访问 [http://localhost:3000/docs/](http://localhost:3000/docs/)。

## 已实现

- 有限的“今日”收件箱，支持类型筛选、未读筛选、搜索、稍后看与安静阅读
- RSS / Atom / 播客订阅识别、网站 Feed 自动发现与按需刷新
- B站创作者主页链接模式（不依赖不稳定的非公开接口）
- 订阅暂停、移除、单源刷新与最多 3 路并发刷新
- 本地合集创建、收录、移除与订阅精选合集
- 设备内发现偏好、不感兴趣与明确的推荐原因
- 浏览器本地持久化、跨标签页同步、离线提示、JSON 导入导出
- 桌面、平板和移动端响应式布局，键盘焦点、弹窗焦点约束与减少动效支持

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

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

仓库包含 `.devcontainer/devcontainer.json`。在支持 Dev Containers 的编辑器中打开后，依赖会自动安装，并转发 `3000` 端口。

## 数据与隐私

- 订阅、已读状态、合集和发现偏好保存在当前浏览器的 `localStorage` 中。
- 清理浏览器站点数据会删除本地内容；可在“设置 → 数据与隐私”中导出 JSON 备份。
- RSS 由本地服务端路由按需请求，解决浏览器 CORS 限制；请求时来源站点仍会收到正常网络访问。
- B站首版使用链接模式。如有自建 RSSHub 等转换地址，可作为普通 RSS 添加。
- 源抓取限制协议、端口、重定向次数、响应时间和体积，并拒绝本地网络地址。

## 验证

```bash
npm run lint
npm test
```

`npm test` 会完成生产构建，并验证首页渲染、本地优先约束、URL 安全校验、B站链接模式和文档站集成。

## 文档维护与发布

文档源文件位于 `docs/`。`npm run dev` 和 `npm run build` 会先将它同步到 `public/docs/`，不要直接修改生成目录。

GitHub Actions 会在 `main` 分支的文档发生变化后把 `docs/` 发布到 GitHub Pages。仓库的 Pages 发布源需要设置为 **GitHub Actions**；整个流程不使用 OpenAI Sites。
