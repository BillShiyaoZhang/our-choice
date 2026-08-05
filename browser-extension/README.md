# 自选助手

“自选助手”把当前网页、来源候选和 B站关注列表发送到本机运行的“自选”。扩展不会读取或保存密码、Cookie、访问令牌，也不会调用平台未公开接口。

## Chrome / Edge 手动安装（默认）

Chrome/Edge 默认不依赖 Chrome Web Store。源码开发时：

1. 在项目根目录运行 `npm run dev`，确认可以打开 `http://localhost:3000`。
2. 运行 `npm run extensions:build`，生成 Chrome 与 Safari 的共源扩展资源。
3. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）并启用开发者模式。
4. 选择“加载已解压的扩展程序”，选择 `build/browser-extensions/chrome/` 目录。
5. 打开安装版 Mac 应用；扩展会自动发现端口并建立本机会话，不需要配对码。
6. 只有 Docker / 普通浏览器网页模式需要在“自选 → 设置 → 浏览器助手”生成配对码，并在扩展高级连接设置中保存；使用 3000...3031 之外的专项开发端口时也可在这里覆盖地址。

若通过 PKG 安装了 Mac 应用，第 4 步改为选择 `/Applications/Our Choice.app/Contents/Resources/browser-extension/chrome`。安装程序会把这份资源放进 App，但不会修改 Chrome/Edge 设置或绕过用户确认。

## Chrome Web Store 发布包（未来可选）

macOS 正式发布默认使用上述 `manual` 模式，不需要 Chrome Web Store 开发者账号。只有日后希望启用 Chrome 官方 External Extensions 注册时，才需要走可选的 `store` 模式。开发加载目录与商店上传物分开生成；提交版本 `0.2.0` 时运行：

```bash
npm run extensions:package:chrome -- --expected-version 0.2.0
npm run extensions:verify-package:chrome -- \
  build/browser-extensions/Our-Choice-Chrome-0.2.0.zip \
  --expected-version 0.2.0
```

只上传 `Our-Choice-Chrome-0.2.0.zip`，不要上传外层目录、Safari 产物、`.sha256`、`.crx` 或任何私钥。每次商店更新都必须先提高 `manifest.json` 的版本。只有商店 item 已公开发布、部署比例大于 0 且版本与 Manifest 一致后，才可配置 `OUR_CHOICE_CHROME_EXTENSION_ID` 并使用 `store` 模式；隐私政策、权限理由、测试步骤和公开发布门禁见 [`docs/store/chrome-web-store.md`](../docs/store/chrome-web-store.md)。

## Safari 安装

正式 PKG 会把 Safari Web Extension 随“自选”主应用安装。首次启动后，从应用菜单打开“Safari → 设置 → 扩展”，启用“自选助手”并按 Safari 提示授予本地网站访问权限。Safari 的安全机制要求用户亲自启用扩展，安装程序不会绕过这一步。

本机 unsigned App/PKG 还需要先打开“Safari → 设置 → 高级”并启用“显示开发者功能”，再从菜单栏“开发”菜单选择“允许未签名扩展”；该允许会在 Safari 每次退出后重置。之后再到“Safari → 设置 → 扩展”启用并授权。正式 Developer ID 签名版不需要“允许未签名扩展”，但仍需用户在扩展设置中启用和授权。

Safari 与 Chrome / Edge 使用同一套 `browser-extension/` 业务源码；`build/browser-extensions/safari/` 是供 macOS 打包流程转换并嵌入主应用的资源目录，不需要手工维护另一份扩展。

扩展先验证上次成功地址，再并行探测 `http://127.0.0.1:3000` 至 `:3031`；只有健康响应的产品标识为 `our-choice-desktop` 才会记住该地址。因此 Docker 保持占用 3000 时，Mac App 可以自动使用 3001，用户不需要同步端口。安装版 Mac App 的健康响应还会向扩展提供当次进程的短期会话，应用重启后扩展收到 401 会自动刷新并重试一次。连接设置仍接受 `http://localhost:<固定端口>` 或 `http://127.0.0.1:<固定端口>` 作为高级覆盖；端口必须明确写出并位于 `1...65535`，地址不得包含用户名、密码、路径、查询或片段。随机端口 `0` 只适合主应用 GUI 验收，扩展无法自动发现。Docker / 网页模式配对码分别保存在应用与扩展的本地存储中，不进入备份。
完整的数据类别、保留与删除说明见 [`docs/browser-extension-privacy.html`](../docs/browser-extension-privacy.html)。

## 收藏与订阅

- “稍后看”会把当前页面发送到系统合集“稍后再看”。
- “收藏到合集”会在自选确认页面中要求选择一个本地合集。
- “订阅这个来源”优先提交页面声明的 RSS/Atom，否则提交当前规范页面给自选已有的来源识别流程。

## B站关注导入

1. 打开 B站个人空间里的“全部关注”页。
2. 点击“自动扫描全部关注”；页面右上角会显示页数和累计账号数，关闭扩展弹窗不会中断同页扫描。
3. 扩展逐页读取公开 MID、昵称与头像，到达末页后自动发送；也可取消并保留已扫描结果。
4. 在自选中从 UP 主主页可发现的 9 类固定来源中多选本次范围，再预览、排除重复项并确认；同一组来源类型会应用到本次导入的所有 UP 主。相对上次快照不再出现的账号只用于提示，不会自动删除订阅。

固定范围包括 UP 主图文、投币视频、动态、粉丝、关注用户、点赞视频、用户追番列表、默认收藏夹和投稿，默认只选择投稿；浏览器助手的单个来源与批量来源都使用这套多选项。粉丝与关注用户需要登录 UID 及自建 RSSHub 的 B站 Cookie 配置；投币、点赞、追番与收藏夹受目标用户公开设置影响。频道合集、非默认收藏夹等还需要额外的频道或收藏夹 ID，无法仅从一批 UP 主主页推导，因此不在这里提供。

自动扫描遇到登录失效、验证码、重复页面、翻页超时或 200 页安全上限会停止，并保留已经扫描的账号。页面改版导致自动翻页不可用时，仍可使用“开始新一轮 / 扫描本页 / 完成并发送”手动完成。

“完成并发送”会优先使用 Mac 应用自动会话；Docker / 网页模式才需要先在扩展连接设置中保存配对码。Mac 应用在线时内容会直接进入其确认队列，不额外打开浏览器；桌面直投不可用时才会打开网站的“来自浏览器助手”确认窗口。来源只有在自选中点击“确认导入”后才会进入订阅列表。若两种连接都不可用，本轮扫描会原样保留，不会丢失。

页面改版可能影响 DOM 识别；扫描结果始终需要用户确认。扩展只读取页面中已经显示的公开名称、头像、MID 和主页 URL。

## 恢复

发现 Mac 应用并取得短期会话后，扩展会优先把内容直接投递到本机桌面队列。本地通信暂时不可用时，内容仍保存在扩展的 `storage.local` 队列中，并保留原有网页桥接流程；下次读取连接设置或再次发送内容时会自动续连、重试并清除已经送达的本地副本。

也可以在扩展底部选择“导出待处理 JSON”。文件只包含待处理的公开页面元数据，不包含配对码或平台凭据。
