# Chrome Web Store 上架清单

本清单只用于未来可选的 Chrome `store` 交付模式。当前 macOS 正式 PKG 默认使用 `manual` 模式：安装程序把扩展资源放入 `/Applications/Our Choice.app/Contents/Resources/browser-extension/chrome`，用户在 `chrome://extensions` 启用开发者模式后选择“加载已解压的扩展程序”。因此 Apple Developer 签名、公证与正式 Mac 发布不需要 Chrome Web Store 开发者账号、扩展 ID 或 OAuth 凭据。

## 可上传产物

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run extensions:package:chrome -- --expected-version 0.2.0
npm run extensions:verify-package:chrome -- \
  build/browser-extensions/Our-Choice-Chrome-0.2.0.zip \
  --expected-version 0.2.0
```

上传 `build/browser-extensions/Our-Choice-Chrome-0.2.0.zip`。不要上传源码目录、Safari 目录、`.crx`、私钥或 `.sha256`。ZIP 根目录直接包含 `manifest.json`。

## 商店资料

- 名称：`自选助手`
- 单一用途：把用户主动选择的当前网页、来源或 Bilibili 公开关注列表发送到用户自己运行的“自选”内容订阅应用中确认。
- 简短说明：由 `manifest.json` 的 `description` 提供。
- 详细说明：

  > 自选助手是本地优先的“自选”配套扩展。点击扩展即可把当前网页加入稍后看或合集、识别并订阅当前来源；在 Bilibili 全部关注页中，还可以由用户主动启动逐页扫描，再把公开账号列表送回自选确认。扩展不读取 Cookie、密码或完整浏览历史；连接、队列与扫描快照保存在本机，数据只发送到 localhost 上由用户运行的自选应用。

- 分类：Productivity
- 语言：中文（简体）
- 项目主页：`https://billshiyaozhang.github.io/our-choice/`
- 隐私政策：`https://billshiyaozhang.github.io/our-choice/browser-extension-privacy.html`
- 支持页面：`https://github.com/BillShiyaoZhang/our-choice/issues`

## 发布前公开页面与图像验收

- 至少上传一张 1280×800 或 640×400 的真实扩展截图，展示扩展弹窗、连接设置、当前页面操作或 Bilibili 扫描体验，不得声称尚未提供的云同步或静默安装能力。
- 上传一张 440×280 的 small promo，内容与扩展品牌和真实功能一致。
- ZIP 内的 128×128 商店图标使用中央 96×96 的实际图形，四周各保留 16 像素透明留白；不能用没有 alpha 通道的满底方图代替。
- 仓库内的提交素材固定为 `docs/store/assets/chrome-extension-screenshot-1280x800.png` 与 `docs/store/assets/chrome-small-promo-440x280.png`；商店图标直接使用 ZIP 内的 `icons/icon-128.png`。发布前由测试校验尺寸和图标透明边框。

隐私政策必须先随 `docs/` 推送到 `main` 并完成 GitHub Pages 部署。提交前从公网运行：

```bash
curl --fail --silent --show-error --location --output /dev/null --write-out '%{http_code}\n' https://billshiyaozhang.github.io/our-choice/browser-extension-privacy.html
```

命令必须返回 HTTP 200。随后还要在无登录浏览器中打开该 URL，确认正文是与待提交版本一致的“自选助手浏览器扩展隐私政策”；404、重定向到错误页面或旧正文都不得提交。

## 权限理由

- `activeTab`：用户点击扩展后读取当前标签页的 URL、标题、公开页面元数据和用户选中文字；不在后台读取其他标签页。
- `scripting`：打开扩展弹窗时，在用户主动选择的活动页注入本地页面检查器，以读取 URL、标题、公开元数据和选中文字并渲染预览；用户启动 Bilibili 关注扫描时，再读取已渲染的公开账号卡片并执行翻页。它不在后台检查其他标签页，不注入广告或修改搜索设置。
- `storage`：在当前浏览器本地保存 loopback 连接设置、安装版 Mac 应用的短期会话、可选的 Docker / 网页模式配对码、最多 500 个待处理项目和关注扫描快照。
- `http://localhost/*` 与 `http://127.0.0.1/*`：把数据交给用户同一台设备上的“自选”网站或 Mac 应用，并在本地应用页面完成队列确认。

不申请 cookies、history、webRequest、tabs 或全站 host 权限。扩展业务代码全部位于 ZIP 内，不使用远程脚本、`eval` 或 `new Function`。

## 隐私后台声明

单一用途填写上述描述。按实际行为声明会处理：

- Website content：URL、标题、公开页面元数据、选中文字和 Bilibili 公开账号信息；
- Authentication information：安装版 Mac 应用每次启动生成、只用于同机通信的短期会话，以及用户可选生成、只用于 Docker / 网页模式鉴权的配对码；
- User activity：用户打开弹窗时检查的当前活动页，以及用户主动扫描、收藏或订阅的页面；不收集完整浏览历史；
- Personally identifiable information：Bilibili 公开昵称及 MID/账号标识；只用于生成用户请求的待确认来源，不用于识别扩展用户、画像或跨站跟踪。

数据只在本机处理和保存，不出售，不用于广告或分析，不转移给第三方。后台必须完成 Limited Use 认证，并保证这些勾选项、权限理由、商店说明、隐私政策和扩展实际行为完全一致。隐私政策必须在提交前已经通过 GitHub Pages 公开访问并通过上述 HTTP 200 验收。

## 审核测试步骤

1. 运行 Mac App，或在源码仓库运行 `docker compose up --build`，确认 `http://localhost:3000` 可访问。
2. 保持安装版 Mac 应用运行；扩展应自动发现端口并显示“Mac 应用已自动连接”。
3. Docker / 网页模式专项审核时，在“设置 → 浏览器助手”生成配对码，并在扩展高级连接设置中保存。
4. 打开任意公开网页，验证“稍后看”“收藏到合集”和“订阅这个来源”。
5. 打开 Bilibili 的“全部关注”页，验证手动或自动扫描；扫描只读取页面可见的公开账号资料，最终导入仍需在自选中确认。
6. 暂停本地应用，验证项目保留在扩展本地队列；恢复后重新投递并从队列移除。

审核备注应明确说明配套应用必须运行在 loopback 3000 端口，并提供可复现的 Docker 命令；不提供或上传任何真实平台账号、Cookie 或访问令牌。

## 首次发布与可选 Mac PKG `store` 模式

1. 在 Chrome Web Store Developer Dashboard 新建 item，上传 ZIP，填写商店资料、隐私声明、截图与测试步骤。
2. 先选择受信任测试者或延迟发布，完成审核与功能验证。
3. 记录后台分配的 32 位扩展 ID。该 ID 是公开配置，不是秘密。
4. 把 item 正式公开发布；仅分配了 ID、处于待审状态或只向测试者发布都不满足 Mac `store` 模式。
5. 使用独立的 Chrome 发布环境运行 `node scripts/verify-chrome-web-store-publication.mjs`，通过 API v2 证明状态为 `PUBLISHED`、至少一个公开通道的部署比例大于 0，且所有公开 CRX 版本与 `browser-extension/manifest.json` 完全一致。
6. 只有上述门禁通过后，才把 `OUR_CHOICE_CHROME_EXTENSION_ID` 设置为该 ID 并选择 `store` 模式。PKG 校验器必须要求唯一的 Chrome 外部注册 JSON 且只指向 Chrome Web Store 官方更新地址。
7. Chrome 安装后仍可能要求用户确认启用；不得尝试绕过浏览器授权。

当前手动触发的 macOS 正式 release workflow 固定使用 `manual` 模式，不读取 Chrome 凭据。若将来为 `store` 模式增加自动化，Chrome OAuth 门禁必须在独立 fresh runner 中完成，不能与 Apple Developer ID 证书或公证 key 共用环境。

后续更新必须先提高 `browser-extension/manifest.json` 的版本，重新生成并验证完整 ZIP，再上传到同一个商店 item。开发者私钥、Chrome API token 和登录凭据不得进入仓库、ZIP 或 CI artifact。
