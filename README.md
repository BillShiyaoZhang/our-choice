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
- 可选的 Manifest V3“自选助手”：收藏当前网页、订阅页面来源、通过逐页扫描批量导入 B站关注并比较增量差异
- 原生 macOS 外壳：内置现有网站、Node/Vinext 本地运行时与 Safari Web Extension 打包流程
- 内嵌来源在浏览器与平台允许第三方 Cookie / Storage Access 时可复用登录会话；应用不读取或保存密码、Cookie
- 桌面、平板和移动端响应式布局，键盘焦点、弹窗焦点约束与减少动效支持

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。添加订阅时直接使用统一的“链接或 RSS”输入；同一链接发现多个 RSSHub 范围时可多选，并作为一个来源统一刷新和管理。点击来源可按视频、文章、播客查看其全部内容；来源的名称、说明、内容范围与 Bilibili 视频打开方式可在“订阅 → 设置”中修改。

## 浏览器助手

仓库中的 [`browser-extension/`](./browser-extension/) 是 Chrome/Edge 与 Safari 共用的 Manifest V3 源码。Chrome/Edge 默认采用手动安装，不需要 Chrome Web Store 账号：源码开发时先运行 `npm run extensions:build`，再到 `chrome://extensions`（Edge 为 `edge://extensions`）启用开发者模式并选择“加载已解压的扩展程序”，指向 `build/browser-extensions/chrome/`。通过 PKG 安装 Mac 应用后，选择的目录则是 `/Applications/Our Choice.app/Contents/Resources/browser-extension/chrome`。安装版 Mac 应用运行后，扩展会自动发现端口并建立短期本机会话，不要求用户复制配对码；只有 Docker / 普通浏览器网页模式保留手工配对作为兼容回退。扩展使用用户主动点击获得的当前标签页权限，可以把网页加入稍后看或合集、识别并订阅当前来源，也能在 B站关注页中逐页执行“扫描本页”后批量导入。它不申请 Cookie、历史记录或全站常驻读取权限。

准备 Chrome Web Store 首次上传或更新时，运行：

```bash
npm run extensions:package:chrome -- --expected-version 0.2.0
npm run extensions:verify-package:chrome -- \
  build/browser-extensions/Our-Choice-Chrome-0.2.0.zip \
  --expected-version 0.2.0
```

产物为根目录直接包含 `manifest.json` 的版本化 ZIP 和对应 `.sha256`。构建会先清除旧扩展目录，独立校验器再从最终 ZIP 检查精确文件树、Manifest、最小权限、图标、远程代码、路径穿越与字节一致性。Chrome Web Store 是未来可选的 `store` 交付模式，不是 macOS 正式发布的前置条件；默认 `manual` 模式始终把可手动加载的 Chrome/Edge 资源放在 App 内。若日后完成商店公开发布，可按 [`docs/store/chrome-web-store.md`](./docs/store/chrome-web-store.md) 验收隐私政策与公开部署，再把 32 位商店 ID 配置为 `OUR_CHOICE_CHROME_EXTENSION_ID`，让 `store` 模式的 PKG 写入 Chrome 官方外部注册文件。

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

## macOS 本地应用

Mac 版保留同一套网站实现：原生 Swift/WKWebView 外壳在回环地址启动内置 Node 22 与 Vinext 生产产物，因此运行应用不要求预装 Node.js、Docker，也不会维护另一份来源解析逻辑。浏览器助手通过每次应用启动重新生成的短期会话保护本地队列，把 Chrome、Edge 或 Safari 中主动选择的内容交给 Mac 应用；Docker / 网页模式仍可使用手工配对，浏览器之间隔离的 `localStorage` 不会被当作共享数据库。

在当前 Mac 架构上构建可直接运行的开发应用：

```bash
npm run mac:build
npm run mac:smoke
open "build/macos/Our Choice.app"
```

安装完整 Xcode 后，即使还没有 Apple Developer 证书，也可以先真实转换并无签名编译 Universal Safari `.appex`：

```bash
npm run mac:safari:check
```

该检查只在临时目录生成 Xcode 项目和扩展产物，不修改开发 App，也不生成可能被误认为正式发行物的 PKG。
如果系统是 Beta 且安装了配套的 Xcode Beta，可在不改全局选择的情况下运行：

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer npm run mac:safari:check
```

要在本机 Safari 中继续验证嵌入式扩展，可生成一个由 Xcode “Sign to Run Locally” 签名、含 App Sandbox entitlement 的开发 `.appex`。命令会把它嵌入 App，并验证 LaunchServices/PlugInKit 已识别正确路径：

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer npm run mac:safari:build-local
open "build/macos/Our Choice.app"
```

随后打开“Safari → 设置 → 高级”，启用“显示开发者功能”，再从菜单栏“开发”菜单选择“允许未签名扩展”；该允许会在每次退出 Safari 后重置。最后到“Safari → 设置 → 扩展”启用“自选助手”并授予网站权限。该 App 仅供本机测试，不具备 Developer ID、公证或对外分发资格。

没有 Developer ID 证书时，也可以生成一个只供当前 Mac 验证安装流程的 unsigned PKG：

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer npm run mac:package-local
open build/macos/Our-Choice-local-unsigned.pkg
```

产物为 `build/macos/Our-Choice-local-unsigned.pkg`。它会安装到 `/Applications/Our Choice.app`，因此可能覆盖同名正式 App；只支持构建它的当前 Mac 架构，也没有 Installer 签名或公证，只能本机测试，不能上传或分发。命令会自动展开最终 PKG，复验架构声明、ad-hoc App、Safari 扩展、内置网站运行时并执行冒烟测试。安装后先启动宿主 App，再按上一段步骤允许未签名扩展、启用并授权；Chrome/Edge 则在扩展管理页启用开发者模式，以“加载已解压的扩展程序”选择 App 内的 `Contents/Resources/browser-extension/chrome`。

构建含 Safari Web Extension 的单一 PKG 安装程序需要完整 Xcode 与 Apple 签名身份：

```bash
export OUR_CHOICE_NODE_ARM64=/path/to/node-v22-darwin-arm64/bin/node
export OUR_CHOICE_NODE_X64=/path/to/node-v22-darwin-x64/bin/node
export OUR_CHOICE_APP_SIGN_IDENTITY="Developer ID Application: Example (TEAMID)"
export OUR_CHOICE_INSTALLER_SIGN_IDENTITY="Developer ID Installer: Example (TEAMID)"
export OUR_CHOICE_DEVELOPMENT_TEAM=TEAMID
export OUR_CHOICE_NOTARY_PROFILE=our-choice-notary
npm run mac:package
```

发行脚本会把网站构建、最小 Vinext 运行时、双架构 Node、浏览器助手和 Safari `.appex` 放进同一个 `Our Choice.app`，再生成安装到 `/Applications` 的 PKG。Apple Developer 账号的后续手工配置清单是：

1. 在 Apple Developer 中创建或下载 `Developer ID Application` 与 `Developer ID Installer` 证书，并连同私钥导入构建机钥匙串；
2. 记录 Team ID，把两类签名身份分别配置为 `OUR_CHOICE_APP_SIGN_IDENTITY` 与 `OUR_CHOICE_INSTALLER_SIGN_IDENTITY`；
3. 创建用于公证的 App Store Connect API key，或用 `xcrun notarytool store-credentials` 保存本机 profile；
4. 将证书、密码和公证 key 配置到受保护的 `macos-release` environment，再运行本机打包命令或手动触发正式 workflow。

这套 Apple 签名与公证流程不要求 Chrome Web Store 账号。详细环境变量、签名步骤与验收标准见 [`docs/spec/macos-local-app.md`](./docs/spec/macos-local-app.md)。

本地验证签名链但暂不公证时，必须显式运行 `npm run mac:package -- --skip-notarization`；它固定生成 `Our-Choice-signed-unnotarized.pkg`，不得当作正式产物。默认 `npm run mac:package` 与正式 release workflow 都使用 Chrome `manual` 模式，不要求扩展 ID；只有日后明确选择 `store` 模式时，才设置已公开发布的 `OUR_CHOICE_CHROME_EXTENSION_ID` 并运行 Chrome Web Store 公开发布门禁。

仓库还提供手动触发的 GitHub Actions 正式发行入口。配置受保护的 `macos-release` environment 后，工作流会先在无凭据 runner 中构建并冻结候选 App，再在隔离 runner 中临时导入两类 Developer ID 证书并完成签名、公证和 staple，最后由新的无凭据 runner 展开验收后才发布 `Our-Choice.pkg` artifact。默认 workflow 携带 Chrome/Edge 手动安装资源，不读取 Chrome 凭据。所需 Apple secrets、variables 与 App Store Connect API key 方式见 [`docs/spec/macos-local-app.md`](./docs/spec/macos-local-app.md#自动化正式发行)。

Safari 扩展会随应用安装，但 Apple 要求用户在“Safari → 设置 → 扩展”中亲自启用并授予权限，应用菜单提供直达入口；正式 Developer ID 签名版不需要“允许未签名扩展”。Chrome 在 macOS 上同样不允许安装器静默启用本地 CRX，因此默认让用户从 App 资源中手动“加载已解压的扩展程序”。未来发布到 Chrome Web Store 后可以选择官方外部注册，企业环境也可使用管理员策略，但浏览器仍可能要求用户确认启用。

当前 Safari 27 还可以直接测试共源目录：运行 `npm run extensions:build`，在“Safari → 设置 → 开发者 → 添加临时扩展”中选择 `build/browser-extensions/safari`。这种临时扩展会在退出 Safari 或 24 小时后移除，不能替代正式 `.appex` 和 PKG 验收。

Mac 应用优先使用 3000；若 Docker 或 Dev Container 已占用该端口，会自动尝试 3001...3031。Chrome/Safari 助手会通过健康检查自动发现应用端口，不需要用户在两边同步填写。产品数据仍按 WebView/浏览器分别保存在本机，可继续用设置中的 JSON 导入导出显式迁移。

若只需在 Docker/Dev Container 仍占用 3000 时验收开发版 Mac GUI，可以直接给 App 可执行文件指定固定开发端口，例如 `OUR_CHOICE_PORT=3100 "build/macos/Our Choice.app/Contents/MacOS/Our Choice"`。这不会改变 Finder 正常启动的 3000 默认值；如需同时测试浏览器助手，还要在扩展“连接设置”中填入同一端口。也可使用 `OUR_CHOICE_PORT=0` 让系统分配临时端口，但该模式只适合主应用 GUI 验收。

## Docker

```bash
docker compose up --build
```

打开 [http://localhost:3000](http://localhost:3000)。容器只运行本地站点，不包含 OpenAI Sites 部署配置。

## Dev Container

仓库包含 Compose 驱动的 Dev Container。在支持 Dev Containers 的编辑器中重新打开仓库后：

- `workspace` 开发容器挂载当前源码并自动执行 `npm ci`
- 独立的 RSSHub sidecar 自动启动
- Cloudflare 本地 Worker 会收到 `RSSHUB_BASE_URL=http://rsshub:1200` binding，并访问 RSSHub
- 开发服务器监听容器网络；Compose 将其发布到宿主机回环地址，编辑器也自动转发 `3000` 端口，因此可直接打开 `http://localhost:3000`

宿主机端口默认是 `3000`；若被占用，可在启动容器前设置 `APP_PORT`，然后用对应端口访问。若需启用 RSSHub 访问密钥或平台抓取凭据，请在启动编辑器前给宿主机设置 `RSSHUB_ACCESS_KEY`、`BILIBILI_COOKIE_1`、`ZHIHU_COOKIES`、`XIAOHONGSHU_COOKIE`、`WEIBO_COOKIES` 或 `XIMALAYA_TOKEN`。它们只传给本地 Worker/RSSHub sidecar，不进入浏览器或导出数据。修改 `.devcontainer/` 后需执行 **Dev Containers: Rebuild Container**。

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
