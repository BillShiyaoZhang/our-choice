# 浏览器扩展发布规格

## 目标

Chrome/Edge 与 Safari 继续共用 `browser-extension/` 的 Manifest V3 业务源码。macOS PKG 默认使用 `manual` Chrome 交付模式：把可手动加载的 Chrome/Edge 目录安装到 `Our Choice.app/Contents/Resources/browser-extension/chrome`，不要求 Chrome Web Store 账号、扩展 ID 或 OAuth 凭据，也不写入 Chrome 配置。用户在 `chrome://extensions` 或 `edge://extensions` 启用开发者模式后，以“加载已解压的扩展程序”选择该目录。

仓库还必须能生成一个可直接上传 Chrome Web Store 的 ZIP。商店上架是未来可选的 `store` 模式；只有扩展已经公开发布并通过发布门禁时，PKG 才可使用 Chrome 官方 External Extensions 机制注册同一个扩展。安装器在任何模式下都不得静默启用扩展或绕过浏览器授权。

Safari 不使用该 ZIP。Safari 版本继续由 macOS Xcode/PKG 流程把同一组 WebExtension 资源转换成 `.appex` 并嵌入宿主 App。

## 构建目录

`npm run extensions:build` 每次运行必须先删除自己管理的 `build/browser-extensions/chrome` 与 `build/browser-extensions/safari` 目录，再从 `browser-extension/` 复制资源。这样旧版本残留文件不会进入开发加载目录、Safari `.appex` 或商店 ZIP。

源目录和生成目录中的资源根、子目录及文件都必须是普通目录或普通文件；发现符号链接、socket 或其他特殊文件时构建失败。`.DS_Store` 与源码说明 `README.md` 不进入浏览器产物。

## Chrome Web Store ZIP

运行：

```bash
npm run extensions:package:chrome
```

发布或 CI 可额外传入 `--expected-version <版本>`；它必须与源码 Manifest 完全相同，否则在写 ZIP 前失败。命令行选项同时支持 `--key value` 与 `--key=value` 两种写法；内联值中的后续 `=` 属于值本身，不能被截断。版本只在 `browser-extension/manifest.json` 中维护，打包脚本不得临时改写。

命令先重新构建共源资源，再从 `build/browser-extensions/chrome` 生成：

```text
build/browser-extensions/Our-Choice-Chrome-<manifest.version>.zip
```

ZIP 必须满足：

- `manifest.json` 直接位于 ZIP 根目录，不能再包一层 `chrome/` 文件夹；
- 条目与刚构建的 Chrome 目录普通文件树逐项完全一致，没有重复路径、绝对路径、`..`、反斜杠、目录条目、符号链接、隐藏元数据或未声明残留文件；
- `manifest_version` 为 3，版本由一至四段 `0..65535` 的十进制整数组成，非零段没有前导零；
- 名称、描述、图标、popup、service worker 与 content script 引用存在且大小写完全一致；
- 权限继续精确限制为 `activeTab`、`scripting`、`storage` 与两个 loopback host；
- HTML/JavaScript 不引用远程执行代码，也不使用 `eval`、`new Function` 或远程 `importScripts`；
- ZIP 通过完整性测试，并输出字节数、扩展版本和 SHA-256，同时生成同名 `.sha256` 文件。

`npm run extensions:verify-package:chrome` 必须把最终 ZIP 解压到临时目录，从 ZIP 自身复验上述约束，并逐文件比较 ZIP 与 Chrome 构建目录。校验器不能只检查打包前源码。

## 商店资料与隐私披露

仓库公开提供独立的 `docs/browser-extension-privacy.html`。它必须准确说明：用户打开扩展弹窗时，扩展即在活动页检查 URL、标题、公开页面元数据、选中文字和当前可见的 Bilibili 公开候选信息，以便渲染预览、判断可用操作并准备扫描；这些临时检查结果只有在用户继续执行收藏、订阅或扫描时才会保存或交给本机应用。短期原生会话、可选网页配对码、队列和扫描快照只保存在本机；数据只通过 `localhost` / `127.0.0.1` 交给用户自己的“自选”应用，不出售、不用于广告、分析或第三方共享，并说明保留、删除和联系方法。

`docs/store/chrome-web-store.md` 保存可复制到开发者后台的单一用途、权限理由、数据声明和审核测试步骤。`scripting` 的理由必须同时覆盖打开弹窗时注入普通活动页检查器，以及用户启动的 Bilibili 关注扫描。数据类别必须包括 Website content、Authentication information、User activity，以及 Bilibili 公开昵称和 MID/账号标识对应的 Personally identifiable information，并明确认证 Limited Use。首次上传后，后台分配的 32 位商店 ID 仍不能单独启用 `store` 模式；必须先证明 item 已公开发布、部署比例大于 0 且公开版本与源 Manifest 一致，才可把 ID 配置为 `OUR_CHOICE_CHROME_EXTENSION_ID`。不得把开发者私钥、Cookie、API token 或商店凭据写入仓库或 ZIP。

商店提交前必须准备至少一张真实扩展界面的 1280×800 或 640×400 截图、一张 440×280 small promo，以及一枚 128×128 商店图标，其实际图形限制在中央 96×96，四周各保留 16 像素透明留白。截图、宣传图和描述不得展示尚未提供的功能。
本项目把验收用截图和宣传图分别固定在 `docs/store/assets/chrome-extension-screenshot-1280x800.png` 与 `docs/store/assets/chrome-small-promo-440x280.png`，并直接校验 ZIP 内的 `icons/icon-128.png` 透明边框。

后续上传必须提高 `manifest.version`，并包含完整的已变更和未变更文件。开发者后台中的隐私政策 URL 使用 GitHub Pages 发布地址：

```text
https://billshiyaozhang.github.io/our-choice/browser-extension-privacy.html
```

推送到 `main` 并完成 GitHub Pages 部署后，提交者必须从公网重新请求该精确 URL；只有返回 HTTP 200 且正文是当前隐私政策时才能提交商店，重定向终点、404 或旧缓存都不算通过。

## 无凭据 CI 打包

`.github/workflows/chrome-extension-package.yml` 提供只允许从 `main` 手动触发的打包任务。调用者必须输入期望扩展版本；任务使用固定 commit 的 checkout/setup-node/upload-artifact actions，运行 `npm ci`、Lint、扩展专项测试、打包和独立复验，再上传版本化 ZIP 与 `.sha256`。该任务不读取 Chrome 或 Apple 凭据，也不自动提交商店，首次上架仍由开发者在 Dashboard 人工完成。

## 可选 `store` 模式发布门禁

32 位扩展 ID 只能证明格式正确，不能证明商店上已有可向公众分发的当前版本。默认 `manual` macOS 发布不运行该门禁，也不读取任何 Chrome 凭据。只有操作者明确选择 `store` 模式时，才必须在使用 Apple 签名凭据前、且在独立的无 Apple 凭据环境中运行：

```bash
node scripts/verify-chrome-web-store-publication.mjs
```

门禁只调用 Chrome Web Store API v2 的官方
[`publishers.items.fetchStatus`](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus)
端点。它从 `browser-extension/manifest.json` 读取期望版本，并从环境变量读取：

- `OUR_CHOICE_CHROME_EXTENSION_ID`：32 位 `[a-p]` 商店扩展 ID；
- `OUR_CHOICE_CHROME_WEB_STORE_PUBLISHER_ID`：Developer Dashboard 的 Publisher > Settings 中显示的 publisher ID；
- 凭据二选一：由发布环境注入的短期
  `OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN`，或 OAuth 刷新凭据
  `OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID`、`OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET`与
  `OUR_CHOICE_CHROME_WEB_STORE_REFRESH_TOKEN`。

后一种凭据按 Chrome 官方
[使用 API 指南](https://developer.chrome.com/docs/webstore/using-api)先在 Google OAuth token
端点换取具有 `https://www.googleapis.com/auth/chromewebstore.readonly` 或
`https://www.googleapis.com/auth/chromewebstore` scope 的短期 bearer token。两种模式不得同时配置，刷新模式不得缺少任一字段。凭据只能出现在请求 header/body 中，不得进入 URL、标准输出、错误信息或 HTTP 响应诊断。CLI 不提供可改写 API/token endpoint 的参数或环境变量，避免把 bearer token 发送到非 Google 主机；测试只通过导出函数的显式依赖注入访问本地 mock HTTP 服务。

`fetchStatus` 响应必须同时满足：

- `name` 和 `itemId` 精确指向所请求的 publisher/extension，`takenDown` 和 `warned` 都不是 `true`；
- 存在 `publishedItemRevisionStatus`，且 `state` 精确为
  [`PUBLISHED`](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/ItemState)；
  `PUBLISHED_TO_TESTERS`、`STAGED`、`PENDING_REVIEW` 或仅存在
  `submittedItemRevisionStatus` 都不算公开发布；
- `publishedItemRevisionStatus.distributionChannels` 是非空数组，每个通道的
  `crxVersion` 都与源 Manifest 版本完全相同，`deployPercentage` 是
  `0..100` 的整数，且至少一个通道大于 0。

在 `store` 模式中，缺少凭据、超时、重定向、非 2xx、非 JSON、身份不一致、结构未知、非公开状态、下架/警告、零流量或版本不一致一律 fail closed。成功时只输出不含凭据的 extension ID、Manifest/商店版本、状态和部署比例。门禁使用的 OAuth 不得与 Apple 签名/公证凭据进入同一个 runner，也不得使 `manual` 模式变成依赖商店的发布路径。

## 验收标准

- 重复运行构建会移除预先注入的旧文件；
- ZIP 文件名包含 Manifest 版本，根目录直接包含 `manifest.json`；
- 独立校验器拒绝嵌套根目录、额外条目、重复/穿越路径、符号链接、缺失引用、非法版本和远程代码；
- 校验器对最终 ZIP 与构建目录逐文件做字节级比较；
- GitHub Pages 上的隐私政策精确 URL 返回 HTTP 200，正文与待提交版本一致；
- 商店资料包含合规的 1280×800 或 640×400 截图、440×280 small promo 和带透明留白的 128×128 图标；
- 手动 CI 在版本不匹配、测试失败、ZIP 校验失败或 checksum 缺失时不上传 artifact；
- 未配置 Chrome Web Store ID 时，默认 `mac:package`、正式 macOS verifier 与 release workflow 必须使用明确的 `manual` 模式：App 内携带可手动加载的 Chrome/Edge 目录，PKG Payload 不含 `/Library` Chrome External Extensions 注册内容；这仍是可签名、公证和正式发布的完整 macOS 产物。
- 一旦提供 `OUR_CHOICE_CHROME_EXTENSION_ID`，格式非法必须在改写 App/PKG 产物前失败；`store` verifier 还必须拒绝缺失、重复或指向非官方更新地址的注册文件。
- 可选 Chrome Web Store 发布门禁必须从 API v2 的已发布修订证明扩展已公开部署、部署比例大于 0，且所有已发布通道版本与源 Manifest 完全相同；只有待审、测试者版本或正确 ID 不得通过。
