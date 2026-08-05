# macOS 本地应用与浏览器助手分发规范

## 目标

在不替换现有 Web 产品和 Docker 启动方式的前提下，增加一个可独立运行的 macOS 本地应用，并用一个 PKG 安装程序交付应用、网站运行时和 Safari Web Extension。

最终发行物必须满足：

- `npm run dev`、`npm run build`、`npm run start` 与 `docker compose up --build` 保持可用；
- Mac 应用不要求用户预装 Node.js 或 Docker；
- 应用继续运行现有 Vinext 的 `dist/client`、`dist/server` 和 `/api/source-preview`，不维护另一套产品实现；
- Chrome/Edge 与 Safari 共用浏览器助手的清洗、扫描、队列和弹窗代码；
- 浏览器助手能把待处理内容送入 Mac 应用，而不是送入另一个浏览器各自隔离的 `localStorage`；
- 安装程序把 Safari 扩展随主应用一并安装，并提供打开 Safari 扩展设置的入口；
- 发行构建支持 Apple Silicon 与 Intel，并能完成签名、公证和安装验证。

## 平台边界

Safari 和 Chrome 都不允许普通消费级安装程序静默启用扩展。PKG 可以安装主应用以及其中的 Safari Web Extension，但用户仍须在 Safari 设置中明确启用并授予网站权限。Chrome 正式自动注册要求扩展先发布到 Chrome Web Store，macOS 用户仍会看到启用确认；企业管理员可以另外使用浏览器策略。

因此本项目对“一键安装”的定义是：一个 PKG 将所有必需文件安装到 `/Applications`，首次启动提供扩展启用引导；不绕过浏览器的用户授权。

## 运行架构

```text
Our Choice.app
├── 原生 Swift / WKWebView 外壳
├── 内置 Node 22 运行时
├── Vinext production server 运行时
├── Web 构建产物 dist/client + dist/server
├── Chrome/Edge 扩展发布副本
└── Contents/PlugIns/Our Choice Safari Extension.appex
```

应用启动后：

1. 只在 loopback 地址启动 Vinext 内部服务，内部端口由系统分配；
2. 桌面代理优先绑定 `http://127.0.0.1:3000`；若该端口已被 Docker、Dev Container 或其他进程占用，则依次尝试 3001...3031，提供健康检查和浏览器助手队列，再把其余请求转发给 Vinext；
3. 等待健康检查成功后由 WKWebView 打开同一地址；
4. 应用退出时只终止自己启动的进程，不停止 Docker 或其他用户进程；macOS 的终止回复必须
   延后到内置 Node 真正退出，正常终止超过 3 秒时发送 `SIGKILL`，然后才允许宿主 App 退出；
5. 自动端口范围全部被占用，或显式 `OUR_CHOICE_PORT` 被占用时显示明确错误，不结束或覆盖任何已有进程。

主应用启动内置 Node 时必须把自身 PID 作为不可变的 `OUR_CHOICE_PARENT_PID` 传给子进程。
Node 入口在服务整个生命周期内监测实际父 PID；若宿主被 Force Quit、`SIGKILL` 或崩溃而来不及
执行 AppKit 终止回调，实际父 PID 一旦不再等于启动时声明的 PID，Node 必须立即进入与
`SIGTERM` 相同的有序关闭流程，并设置最多 3 秒的强制退出上限。监测只作用于直接执行的桌面
入口，不得改变测试或其他代码通过 `import` 使用 `startDesktopServer()` 的行为。缺失或非法的
父 PID 配置视为没有宿主监测，以保持 Docker 和独立运行时的兼容性。
普通 `SIGINT`/`SIGTERM` 先发起的有序关闭不得在服务真正关闭前撤销父进程监测。若关闭仍在进行时宿主消失，同一次关闭必须可升级为“父进程退出”模式，从升级时起启动唯一的 3 秒强制退出计时器；重复信号不得重置该上限。有序关闭完成后才停止监测并取消强制计时器。

3000 是首选兼容端口，不是用户需要手工同步的配置。未传入 `OUR_CHOICE_PORT` 时，安装后的普通 Finder 启动必须在 3000...3031 中选择第一个可用端口，使 Mac 应用可以和占用 3000 的 Docker/Dev Container 并存。扩展先探测已记住的 loopback 地址，再并行探测该固定范围的 `GET /__our_choice/desktop/health`；只接受产品标识精确为 `our-choice-desktop` 的响应，并把发现的规范 `127.0.0.1` 地址原子保存后用于投递、队列重试和打开交接页面。用户无需在扩展和应用之间抄写端口号。

直接启动 App 仍可显式传入 `OUR_CHOICE_PORT` 覆盖桌面代理端口；值必须是 `0...65535` 的十进制整数，`0` 表示让系统分配临时端口。显式覆盖必须精确使用该端口，不回退到自动范围；随机端口和范围之外的固定端口只用于 GUI 或专项开发验收，扩展的自动发现不保证找到它们。扩展仍可在高级连接设置中保存带显式 `1...65535` 端口、无凭据/路径/查询/片段的 `http://localhost:<port>` 或 `http://127.0.0.1:<port>`；探测时优先保留该地址。Manifest 的最小网页通信桥匹配两个 loopback host 的任意端口；Mac 原生模式使用短期会话，普通 Docker/浏览器网页模式的桥仍须通过配对码鉴权，不能因扩大端口兼容范围而读取其他页面数据或放宽桌面端点。

主应用不得仅因为 `OUR_CHOICE_PORT=0` 就信任 Node 返回的任意 URL。ready 消息仍必须声明 `127.0.0.1`、有效的正整数端口和无凭据的 `http` URL；固定端口覆盖时返回端口必须精确匹配请求值，临时端口覆盖时 URL 端口必须与 ready 数字一致。每次启动必须把其请求端口和 stdout 行解析缓冲区隔离在该启动代次内；文件句柄回调不得直接读写 AppKit 状态，旧代次的延迟输出不得写日志、触发健康检查或与新代次的请求端口组合校验。WKWebView 的主 frame 只允许在当前已通过健康检查的规范来源 `http://127.0.0.1:<port>` 内导航并接受响应；相同端口的 `http://localhost:<port>`、`http://[::1]:<port>` 和其他本地服务均不属于产品主 frame，不能因开发覆盖而放宽。为保留现有 `EmbeddedViewer` 能力，只在 WebView 的当前主页仍是上述已验证产品来源时，允许非 main frame 加载无 userinfo 且带 host 的 `http:`/`https:` URL 及其响应。外部 main-frame 导航和新窗口仍只在系统默认浏览器打开；外部下载、带凭据 URL 和非 HTTP(S) 子 frame 必须拒绝。

Node 子进程的可写数据、配对信息和日志必须位于 `~/Library/Application Support/Our Choice/`，不得写入签名后的应用包。

## 本地助手传输

现有浏览器网页模式继续使用 content script 与 `window.postMessage`。Mac 应用模式增加同源代理上的私有端点：

- `GET /__our_choice/desktop/health`：向普通请求返回固定产品标识和版本；扩展探测必须额外发送固定的非安全凭据请求头 `x-our-choice-extension-session: request`，服务端只在该标记存在且 Origin 是浏览器扩展协议或浏览器没有发送 Origin 时返回当前进程的短期扩展会话；
- `POST /__our_choice/assistant/pair`：由同源且持有当次原生 bootstrap secret 的宿主 WKWebView 页面登记或撤销配对码；
- `POST /__our_choice/assistant/enqueue`：由浏览器扩展提交经过清洗的单个队列项；
- `GET /__our_choice/assistant/queue`：由产品页面读取队列；
- `POST /__our_choice/assistant/ack`：产品页面在成功处理后确认队列项。

安全与可靠性要求：

- 桌面代理只能绑定 `127.0.0.1`；
- 配对端点只接受产品自身的 loopback Origin，且必须校验宿主每次启动新生成的高熵 bootstrap secret；该 secret 只能位于内置 Node 进程内存和 main-frame-only WKWebView 注入中，不得持久化、记录或返回给普通浏览器页面；
- Mac 原生模式每次 Node 进程启动生成独立的高熵扩展会话。Chrome/Safari 的后台 GET 在不同版本中可能省略 Origin，因此健康端点用显式请求头区分扩展探测：没有该标记的普通请求只得到产品标识；带标记但声明普通 HTTP Origin 的请求仍不得取得会话；带标记且 Origin 是 `chrome-extension:`、`safari-web-extension:`、`moz-extension:` 或缺失时才返回会话。跨域 OPTIONS 只允许扩展协议 Origin、GET 与该请求头，普通网页的预检必须拒绝。会话不得进入 URL、日志或桌面状态文件，扩展可在自己的本地配置中暂存以跨 Service Worker 休眠续用，应用重启后旧值立即失效并被新值覆盖；
- 扩展自动发现端口时同时取得短期会话并原子更新本地连接配置，桌面请求优先携带短期会话；收到 401 后必须重新探测并只在会话确实刷新时重试一次。无法取得短期会话的 Docker/普通网页模式继续支持用户配对码，磁盘只保存配对码的带盐哈希；
- 原生 WKWebView 读取和确认桌面队列时使用只注入 main frame 的 bootstrap secret，不要求创建或复制配对码；普通浏览器页面不能使用该路径；
- CORS 只允许 `chrome-extension:`、`safari-web-extension:`、`moz-extension:` 和产品自身 loopback Origin；
- 请求体上限为 1 MiB，队列上限为 500 项；
- 队列使用临时文件加原子替换持久化；重复 ID 不重复入队；不支持或畸形的队列项在写盘前拒绝，损坏的状态文件隔离为 `.corrupt-*` 后不阻断网站启动；
- 桌面传输不可用时，扩展保留现有 `storage.local` 队列和网页桥作为降级，不能丢内容；
- 原生产品页面在 bootstrap 会话建立后轮询桌面队列；普通浏览器页面仍只在配对后轮询。两者都只在导入成功后 ACK；只有桌面端确认成功才从界面移除项目，确认失败时保留队列并提示重试。

## 浏览器扩展共源策略

`browser-extension/` 继续作为唯一源码目录。扩展通过一个很薄的 API 适配层选择 `globalThis.browser` 或 `globalThis.chrome`，业务文件不直接绑定单一浏览器命名空间。

Chrome 和 Safari 产物都使用 Manifest V3，并仅申请：

- `activeTab`、`scripting`、`storage`；
- `http://localhost/*` 与 `http://127.0.0.1/*` 的 loopback host permission，用于向桌面代理投递；
- 两个 loopback host 任意端口上的最小 content script，用于 Docker/浏览器网页模式与自动发现后的 Mac 交接页面；网页桥消息仍需配对码鉴权，原生短期会话不得暴露给 content script 或产品网页。

Manifest 必须声明 16、32、48、128 像素扩展图标，Chrome 与 Safari 产物复制同一组资源。Safari 产物由 `safari-web-extension-packager` 生成 macOS extension target；构建流程只编译该 extension target，避免生成器临时宿主 App 的 Bundle ID 参与最终产品校验，构建出的 `.appex` 再嵌入真正的 `Our Choice.app/Contents/PlugIns`。JS、HTML、CSS、图标和 Manifest 从同一个生成目录取得，不手工维护一份 Safari 副本。

Safari 转换器会给 extension target 自行追加 `Extension`，因此传给转换器的宿主名必须固定为
`Our Choice Safari`，让最终内部 `CFBundleName` 精确成为 `Our Choice Safari Extension`，不得出现
重复的 “Extension Extension”。构建时再通过 Info.plist build setting 把用户可见的
`CFBundleDisplayName` 固定为“自选助手”。本地与正式验证器都必须从最终 PKG Payload 读取并
精确校验这两个键；`CFBundleExecutable` 仍可使用 Xcode 的内部产物名。

## 原生外壳行为

- 应用不携带 storyboard 或 main nib，因此 Swift 入口必须显式取得 `NSApplication.shared`、创建并设置 `OurChoiceApplicationDelegate`，并在 `application.run()` 整个事件循环期间强引用该 delegate；不得只依赖 `@main`/`NSApplicationMain` 等待不存在的 nib 实例化 delegate。Swift 类型检查和内置 Node 烟测不能替代一次真实 GUI 冷启动验收；验收必须证明窗口创建、健康端点就绪、WKWebView 加载及正常退出后无孤儿 Node；
- 主应用必须携带与现有绿色、米白和橙色品牌体系一致的原生 `OurChoice.icns`，`Info.plist` 的 `CFBundleIconFile` 必须精确引用该文件。本地与正式 PKG 验证器必须从最终 Payload 读取并解析 ICNS 容器，要求至少包含 16、32、128、256、512 与 1024 像素表示；只有源图或源码声明不能代替最终安装包验证；
- WKWebView 使用持久网站数据存储；应用升级不得清空用户数据；
- AppKit 版 WKWebView 必须在 document start 给页面标记原生宿主环境；该环境使用占满 WebView 的独立 `.app-column` 纵向滚动容器，使滚轮、触控板和键盘可以滚动并自动显示滚动条。普通浏览器和 Docker 页面继续使用文档根滚动，不得受原生专用 CSS 影响。打开模态窗口期间应锁定实际滚动容器，关闭后恢复原值；不得用永久的全局 `overflow: hidden` 截断普通页面；
- 加载期间显示原生状态，启动失败时展示可操作错误；
- `window.open` 与新窗口外部链接交给系统默认浏览器；
- 文件选择使用原生打开面板，下载使用原生保存位置；
- 提供重新加载、打开数据目录和打开 Safari 扩展设置菜单；
- 注册稳定 bundle identifier 和应用版本；
- App Transport Security 只为 loopback HTTP 开放，不放宽任意明文网络访问。

首次成功加载产品页面后，主应用必须显示一次浏览器扩展启用引导。引导按版本写入
`UserDefaults`，同一引导版本之后不再自动弹出；服务启动失败时不得用引导覆盖错误界面。
若成功导航回调排队后应用已进入终止流程，也不得再显示引导。
引导使用的模态窗口不得阻止应用终止；即使引导仍打开，用户选择退出也必须进入既有的
Node 子进程清理流程并最终退出，不能由 AppKit 以“用户取消”拒绝退出。
引导必须说明 Safari 扩展已随 App 安装但仍需用户在“Safari → 设置 → 扩展”中启用和授权；同时要明确指出，若当前安装的是本机 unsigned 测试包，用户还须先在“Safari → 设置 → 高级”启用“显示开发者功能”，再从菜单栏“开发”菜单选择“允许未签名扩展”，且 Safari 每次退出后都需要重新允许。正式 Developer ID 签名版无需允许未签名扩展，但仍需用户启用和授权。引导也必须说明
Chrome/Edge 默认通过“加载已解压的扩展程序”使用随 App 携带的
`Contents/Resources/browser-extension/chrome`，不要求商店账号；未来只有选择 `store` 模式时才依赖已公开发布的 Chrome Web Store ID。引导提供“打开 Safari 扩展设置”、
“打开 Chrome 扩展目录”和“完成”三个选择；无论用户选择哪个操作，都把该引导版本标记为已显示。

应用菜单必须始终保留“浏览器扩展安装说明…”和“打开 Chrome 扩展目录”入口，使用户可以重新
打开引导或在 Finder 中定位内置 Chrome 资源。Chrome 目录必须从 `Bundle.main.resourceURL`
解析，存在且是目录时才允许打开；缺失或无法打开时展示可操作错误，禁止退回到开发仓库路径。
应用不得自动更改浏览器偏好设置、启用扩展或绕过 Safari/Chrome 的用户确认。
每次宿主启动时必须用当前 App bundle URL 刷新 LaunchServices 注册，使安装程序覆盖升级后的内嵌
`.appex` 能被 PlugInKit 重新索引。打开 Safari 扩展设置前先通过
`SFSafariExtensionManager` 检查精确扩展标识；若系统尚未发现扩展，应短暂重试注册/状态检查，
再给出包含“允许未签名扩展”的可操作诊断，不能只把用户送到一个不存在该扩展的设置页。

关闭最后一个窗口不等同于退出，后台本地助手继续服务；用户选择“退出自选”或按下 ⌘Q 时才停止
内置服务。重试启动和应用退出可能同时请求停止服务，停止逻辑必须合并这些请求并在同一子进程
退出后通知全部等待者；不得在进程退出前清除唯一的停止状态，避免宿主先退出后留下孤儿 Node。

WebView、Chrome、Safari 与 Docker 站点的产品 `localStorage` 仍分别隔离。浏览器助手队列通过上述本地传输进入 Mac WebView；完整产品数据继续通过现有 JSON 导入/导出显式迁移，不在本次改动中改为中心数据库。

## 构建和安装

开发构建流程：

1. `npm run build` 生成现有网站产物；
2. `npm run extensions:build` 生成 Chrome 与 Safari 共源资源；
3. `npm run mac:build` 编译原生外壳，复制 Web/Vinext/Node 运行时并生成 `.app`；
4. `npm run mac:smoke` 必须从生成的 `.app` 内启动其内置 Node、Vinext 与 Web 产物，且只接受 ready 消息中的规范地址 `http://127.0.0.1:<port>`；地址含凭据、路径、查询、片段、其他 host 或与 ready 数字不一致的端口都必须失败。验证健康端点、首页和 API 错误契约后发送 `SIGTERM`；内置运行时必须以状态码 0、无终止信号退出，若 3 秒后需要 `SIGKILL` 则烟测失败；
5. `npm run mac:safari:check` 在完整 Xcode 环境中把共源目录转换为临时 Xcode 项目，只编译 Safari extension target，并在不读取签名身份的情况下验证 Universal `.appex`、Bundle ID、版本、扩展点和内嵌资源；临时生成器宿主的 Bundle ID 不得阻断该检查；
6. `npm run mac:safari:build-local` 使用 Xcode 的 “Sign to Run Locally” 路径构建同一 `.appex`，要求并验证 `com.apple.security.app-sandbox=true`，在复制时保留扩展 entitlement，再嵌入当前架构开发 App、更新扩展 Bundle ID 并做 ad-hoc 深度签名验证；脚本还须通过 LaunchServices 注册 App，并以精确 Bundle ID 和路径验证 PlugInKit 已接受该扩展。该产物仅用于本机 Safari“允许未签名扩展”测试，不得作为正式发行物；
7. `npm run mac:package` 允许两种 Chrome 交付模式。未配置 `OUR_CHOICE_CHROME_EXTENSION_ID` 时默认为 `manual`：PKG 只把 Chrome/Edge 扩展资源放入 App，由应用引导用户“加载已解压的扩展程序”，不写入 `/Library` Chrome External Extensions。配置已公开发布的 32 位 `[a-p]` ID 时才启用 `store` 官方外部注册；一旦提供的 ID 格式错误，必须在网站/主应用构建前 fail closed。随后在任何发行证书或公证 key 可用之前完成 Universal 主程序、Universal Node 和 Release Safari `.appex` 的构建与烟测。Safari 预构建必须禁用 Xcode 自动签名和 base entitlement 注入，再用仓库内受审计的最小 entitlement 文件做 ad-hoc Hardened Runtime 签名；该文件只能启用 App Sandbox，不能启用 `get-task-allow`。验证必须逐架构证明 App Sandbox 启用且 `get-task-allow` 不存在；共源根目录与实际 `Contents/Resources` 都必须是非符号链接目录并逐文件相同。预构建 App 以完整文件树摘要冻结；正式打包器必须先把候选 App 复制到 mode 0700 的私有工作目录，再对这份即将签名的副本复验摘要，后续只能签名和打包该副本，不得先验证一份路径再改签另一份路径。它也不得再次调用 npm、Swift 编译器、Xcode 构建、扩展转换器或应用内运行时。准备、打包与验证脚本的参数解析必须 fail closed：未知或重复参数、布尔参数携带值、选项缺值均须在修改产物前失败；
8. 凭据可用期间只允许执行候选件摘要复验、系统签名/打包工具、结构与签名验证以及 Apple 公证。用 Developer ID 重签名 Safari `.appex` 时必须显式传入仓库受审计的 `macos/App/SafariExtension.entitlements`，禁止使用 `--preserve-metadata` 继承 ad-hoc 签名的 identifier、entitlements、requirements 或 flags；bundle identifier 来自已冻结且已验证的扩展包，Hardened Runtime flags 必须由新的 Developer ID 签名重新生成。PKG 签名后、提交 Apple 之前先用 `--allow-unnotarized --defer-runtime-smoke` 完成 Payload/BOM 与签名预检；`--defer-runtime-smoke` 必须与 `--allow-unnotarized` 同时使用，成功结果明确输出 `runtimeVerified: false`，不能被视为最终验收。预检通过后才提交公证并 staple ticket。为避免受限或高延迟网络让 S3 Transfer Acceleration 的 multipart upload 在完成前超时，正式 `notarytool submit` 必须显式使用 `--no-s3-acceleration`。打包器必须在目标目录生成唯一临时 PKG；该临时文件在隐藏前缀和唯一后缀之外仍必须以 `.pkg` 结尾，使 Apple `stapler` 能按安装包类型处理。所有步骤成功后才通过同卷 `rename` 原子替换最终文件；失败时删除临时文件，不得把半成品写成正式文件名。`notarytool` 原始日志只能短暂存在于 mode 0700 的私有临时目录；可保留的稳定诊断必须先移除 key 路径、key ID、issuer、profile 等敏感信息并设置为 0600，随后删除原始日志；
9. 只有删除临时 keychain、P12 与 `.p8` 后，才运行默认的完整验证器。自动化正式发行必须在新的、从未持有 Apple 凭据的 runner 上执行该验证；不能在删除凭据后继续复用同一 runner 启动候选 App/Node。默认验证器必须从最终 PKG 展开、执行应用内运行时烟测并检查 staple/Gatekeeper，且给烟测子进程构造最小环境，不能传入公证、证书、密码、keychain、`NODE_OPTIONS` 或其他调用者环境。它必须对每个 Mach-O slice 使用精确 entitlement 白名单：主 App 为空，Safari `.appex` 只允许 `com.apple.security.app-sandbox=true`，内置 Node 只允许 `com.apple.security.cs.allow-jit=true` 与 `com.apple.security.cs.allow-unsigned-executable-memory=true`；多余、缺失或值错误都失败。验证器还必须显式区分 `store` 与 `manual` Chrome 模式：前者要求唯一且匹配的 External Extensions JSON，后者要求 Payload 完全没有 `/Library` 树且 App 内仍携带可手动加载的 Chrome 资源。`--allow-unnotarized` 只跳过公证、staple 与 Gatekeeper，不能隐式跳过运行时或改变 Chrome 模式。只有显式传入 `--skip-notarization` 才允许生成签名但未公证的开发预检包；其默认文件名固定为 `Our-Choice-signed-unnotarized.pkg`，不得占用 `Our-Choice.pkg`。

本机开发构建可以使用当前架构的 Node 可执行文件。Universal 发行构建必须提供 arm64 与 x86_64 的 Node 22 官方运行时并用 `lipo` 合并，且对每个 Mach-O 验证架构。

桌面 Node 入口必须用文件系统真实路径判断当前模块是否为主程序，不能直接比较未经规范化的 `process.argv[1]` 与 `import.meta.url`。这样从 PKG 展开到 macOS 的 `/var` → `/private/var` 路径别名或经符号链接启动时，运行时仍会真正启动而不是误判为被导入后静默退出。

原生 App 启动内置 Node 时必须从空字典构造最小环境，只传入固定系统 `PATH`、当前用户的 `HOME`/临时目录、稳定 locale、显式的 `NODE_ENV`/`OUR_CHOICE_*` 运行参数，以及用户为已有 RSSHub 服务显式设置的 `RSSHUB_BASE_URL`/`RSSHUB_ACCESS_KEY`。这两个 RSSHub 变量是唯一允许从父环境复制的业务配置；不得全量复制 `ProcessInfo.processInfo.environment`，以避免把签名、公证、密码、keychain、`NODE_OPTIONS`、`DYLD_*` 或调试注入变量传给内置服务。

### 无证书本机测试安装包

没有 Apple Developer 证书时，`npm run mac:package-local` 必须先执行完整的 `mac:safari:build-local`，再把当前架构、ad-hoc 签名的 App 和 Xcode “Sign to Run Locally” Safari `.appex` 放入一个独立的 unsigned PKG：`build/macos/Our-Choice-local-unsigned.pkg`。该命令与正式 `mac:package` 使用不同脚本、component ID、文件名和验证器；不得给正式脚本增加可组合的 unsigned/local 降级开关，也不得覆盖 `Our-Choice.pkg`。

本机 PKG 仍以 `/Applications/Our Choice.app` 为唯一 Payload，禁止安装脚本和额外 `/Library` 内容，因此会覆盖同名已安装 App。它只携带 App 内的 Chrome 手动安装资源；没有 Chrome Web Store ID 时不得写入 Chrome External Extensions。Safari `.appex` 会随宿主 App 一起安装，但安装后必须先首次启动宿主 App 让系统发现扩展，再由用户允许未签名扩展、启用并授权。因为主应用与 Node 只构建当前 Mac 架构，`productbuild` 必须通过 product requirements 把最终 Distribution 的 `hostArchitectures` 精确限制为当前架构，并声明与 App 一致的最低 macOS 13.0；不得沿用默认的 `x86_64,arm64` 双架构声明。因为 PKG 本身无 Installer 签名、公证或来源完整性，只能用于当前开发 Mac，不得上传、重命名或对外分发。

独立的 `mac:verify-package-local` 必须从最终 PKG 展开验证，而不是只检查源 App：要求 `pkgutil` 明确报告 `Status: no signature`，最终 Distribution 的 `hostArchitectures` 精确等于当前架构，且 `allowed-os-versions` 中恰好一个 `<os-version>` 的真实 `min` 属性精确等于 `13.0`。Distribution 的元素名与属性名必须严格匹配，`data-hostArchitectures`、`data-min` 或带前后缀的伪元素/伪属性不得被当成真实约束。验证器还必须从最终 Payload 内主 App 与 Safari `.appex` 的 `Info.plist` 分别读取 `LSMinimumSystemVersion`，要求两者与 Distribution 的 `min` 精确一致并同为 `13.0`，并在成功结果中输出 `minimumSystemVersion`。component 使用 local 专属 ID、`install-location="/"`、`relocatable="false"`，且 Payload/BOM 只包含预期 App。展开后的 App、Node 与 `.appex` 必须全部为 ad-hoc + Hardened Runtime、无 Team/Authority/timestamp；App 与 Node 只能包含当前构建架构，`.appex` 仍为 Universal，并保留 Node JIT 与 Safari App Sandbox / `get-task-allow` entitlement。签名身份、runtime flag 与 entitlement 必须用 `codesign --arch` 对每个 Mach-O 架构片段分别读取和检查，不能只依赖宿主机器默认展示的 slice。最后还须逐文件复验 Safari 资源并从展开 App 运行桌面烟测。正式验证器必须继续拒绝 unsigned/ad-hoc 产物。

Distribution 与 component `PackageInfo` 必须按 XML 文档结构解析，禁止用原始文本正则搜索标签或属性。解析器必须拒绝 `DOCTYPE` 与命名空间重映射，忽略注释与 CDATA 文本中的伪标签，并要求 Distribution 根元素为 `installer-gui-script`：唯一的 `options` 与 `volume-check` 必须是根元素直属子元素，唯一的 `allowed-os-versions` 必须直属 `volume-check`，唯一的 `os-version` 必须直属 `allowed-os-versions`。`PackageInfo` 根元素必须精确为 `pkg-info`，`install-location`、`relocatable` 和本机 component `identifier` 必须读取根元素上的同名真实属性；`data-install-location`、`data-relocatable`、`data-identifier` 或注释中的文本不得替代真实属性。

最低系统版本约束只有位于唯一 `volume-check` 的唯一 `allowed-os-versions` 内才有效；本机验证器不得接受放在其他元素中的同名声明。

Safari 27 及以后可在不生成 Xcode 项目的情况下做临时兼容性测试：先运行 `npm run extensions:build`，再在 Safari“设置 → 开发者 → 添加临时扩展”中选择 `build/browser-extensions/safari`。临时扩展会在退出 Safari 或 24 小时后被移除，只用于验证 WebExtensions 页面能力；App 通信、正式安装和分发仍必须通过包含 `.appex` 的 Xcode/PKG 路径验收。

正式发行需要完整 Xcode、Apple Developer Program、`Developer ID Application` 和 `Developer ID Installer` 身份。只有 Command Line Tools 时应仍能构建并冒烟测试当前架构的未公证 Mac 应用，但 Safari 扩展打包必须给出清楚的缺失 Xcode 错误。

发行环境变量：

- `OUR_CHOICE_NODE_ARM64`：官方 Node 22 arm64 可执行文件；
- `OUR_CHOICE_NODE_X64`：同版本的官方 Node 22 x86_64 可执行文件；
- `OUR_CHOICE_APP_SIGN_IDENTITY`：钥匙串中的 `Developer ID Application` 身份；
- `OUR_CHOICE_INSTALLER_SIGN_IDENTITY`：钥匙串中的 `Developer ID Installer` 身份；
- `OUR_CHOICE_DEVELOPMENT_TEAM`：Apple Developer Team ID；
- `OUR_CHOICE_BUILD_VERSION`：可选的数字点分构建号；本地默认从 `package.json` 版本派生，正式 workflow 使用单调递增的 GitHub run number 与 attempt；
- `OUR_CHOICE_NOTARY_PROFILE`：已通过 `notarytool store-credentials` 保存的钥匙串 profile；
- `OUR_CHOICE_NOTARY_KEY_PATH`、`OUR_CHOICE_NOTARY_KEY_ID`：直接公证使用的 App Store Connect API key；Team API Key 还必须设置 `OUR_CHOICE_NOTARY_ISSUER_ID`，Individual API Key 则不得设置 issuer。直接 key 方式与 `OUR_CHOICE_NOTARY_PROFILE` 二选一；
- `OUR_CHOICE_CHROME_EXTENSION_ID`：可选，仅在扩展已公开发布到 Chrome Web Store 后设置为 32 位 `[a-p]` ID。未设置时，unsigned 包、签名未公证预检包和正式已公证 PKG 均可使用明确的 `manual` 模式：不修改 Chrome，只在 App 资源中携带手动安装副本。设置时启用 `store` 模式，打包器必须在改写任何 App/PKG 产物之前拒绝错误格式，操作者必须另行运行 Chrome Web Store 公开发布门禁。

主应用与 Safari `.appex` 必须使用相同的营销版本和构建版本；PKG 禁止 bundle relocation。正式 `productbuild` 必须传入 product requirements，让最终 Distribution 的 `hostArchitectures` 只包含 `x86_64` 与 `arm64`，并在唯一的 `allowed-os-versions` 中恰好声明一个 `<os-version min="13.0">`。正式验证器必须从最终 Distribution 读取该真实 `min` 属性，再从最终 Payload 内主 App 与 Safari `.appex` 的 `Info.plist` 分别读取 `LSMinimumSystemVersion`，要求三者精确一致并同为 `13.0`，成功输出 `minimumSystemVersion`；伪元素或 `data-min` 等伪属性必须拒绝。正式产物需要展开最终 PKG，并要求恰好一个无安装脚本的 component、`install-location="/"`、`relocatable="false"`。该 component 的 Payload 始终包含 `/Applications/Our Choice.app`；`store` 模式还必须恰好包含唯一的 `/Library/Application Support/Google/Chrome/External Extensions/<OUR_CHOICE_CHROME_EXTENSION_ID>.json`，`manual` 模式则必须完全省略 `/Library` 树。任何其他顶层目录、额外注册 JSON 或安装内容都必须拒绝，不能仅按文件名递归命中预期文件。验证还必须逐文件比对嵌入 `.appex/Contents/Resources` 与 App 中携带的 Safari 共源产物，并覆盖主应用、Safari `.appex` 和内置 Node 的 Developer ID Application 身份、可信时间戳、Hardened Runtime、相同 Team ID、Safari App Sandbox entitlement、Node JIT entitlements、Universal 架构，以及 Installer 身份、公证、staple 和 Gatekeeper；正式主应用、Safari `.appex` 与内置 Node 的 `com.apple.security.get-task-allow` 都必须为 false 或不存在，不能把本机开发 entitlement 带入发行包。所有代码签名元数据与 entitlement 都必须通过 `codesign --arch` 对 Universal Mach-O 的每个 slice 分别复验。最后从展开后的 App 内再次运行桌面烟测。`store` 模式的 Chrome 注册目录链和 JSON 必须在写入后显式设置为 0755/0644，不得受调用者 `umask` 影响；BOM 中还必须是 root 所有、不可组/全局写、无符号链接。Chrome 仍会要求用户确认启用，安装程序不得绕过该授权。

正式验证器同样只接受唯一 `volume-check` 内的最低版本声明，避免无效位置的 XML 让安装前系统版本限制形同虚设。
正式验证器对 Distribution 与 `PackageInfo` 使用与本机验证器相同的结构化 XML 规则；注释、CDATA、错误嵌套和带前缀的伪属性都不得满足发行约束。

### 自动化正式发行

`.github/workflows/macos-release.yml` 是只允许手动触发的正式发行入口，使用固定的 `macos-26-intel` runner 与显式固定的正式 Xcode 26.6 路径。工作流必须保持 `contents: read` 最小权限，每次 checkout 都锁定同一 `${{ github.sha }}` 并禁用持久化 Git 凭据，且用 fresh runner 形成以下边界：

1. `build_candidate` 不关联任何 GitHub Environment，也不注入 secret。它固定使用 Node 22.23.1，断言 Xcode 26.6，执行全量测试与静态检查；从 `nodejs.org` 下载 arm64/x86_64 Node 后，必须分别匹配仓库内审查并锁定的 SHA-256，不能信任与归档同时下载的同源摘要。只有这个 runner 允许执行 `npm ci`、npm 脚本、Xcode/Swift 构建与候选 App/Node 烟测。它必须明确运行 `npm run mac:build` 后再发行预构建，把 prepared App 与文件树摘要放入归档，生成归档 SHA-256 并上传短期不可变候选 artifact。当前 workflow 明确构建 `manual` Chrome 模式，不需要 Chrome Web Store 账号或凭据。
2. `apple_sign` 依赖 `build_candidate`，使用新 runner 与独立受保护的 `macos-release` Environment，只注入 Apple 签名/公证凭据。它不安装 npm 依赖，在导入凭据前下载同次 run 的候选 artifact、复验归档 SHA/路径与文件树摘要，且绝不执行其中的 App/Node。凭据可用期间只直接调用 `package-macos.mjs --manual-chrome-install` 及 Apple 系统签名/打包/公证工具，不得运行 npm、prepare、Swift/Xcode 或运行时烟测。完成后无论成败都 fail closed 地恢复 keychain 并删除 P12/`.p8`；只有清理成功后才上传名称不占用 `Our-Choice.pkg` 的 signed/notarized candidate 或已脱敏公证诊断。
3. `verify_candidate` 在新的无 Environment、无 secret runner 上下载签名候选包，以 `manual` Chrome 模式运行包含嵌入 App/Node 烟测、staple 与 Gatekeeper 的默认完整验证，只上传该不可变候选包的 SHA-256 attestation。
4. `publish` 再使用一个新的无 secret runner，重新下载原始 signed/notarized candidate 与验证 attestation，要求 SHA-256 精确一致后才重命名为 `Our-Choice.pkg`、生成最终 SHA-256 并上传正式 artifact。这使得任何被验证过程启动的候选运行时都不能触及凭据或要发布的本地文件副本。

所有 GitHub Actions 使用经核验的完整 commit SHA。第三方 artifact action 不得在任何凭据清理之前运行。

`macos-release` environment 只需要以下 Apple secrets：

- `MACOS_APPLICATION_CERTIFICATE_BASE64` 与 `MACOS_APPLICATION_CERTIFICATE_PASSWORD`；
- `MACOS_INSTALLER_CERTIFICATE_BASE64` 与 `MACOS_INSTALLER_CERTIFICATE_PASSWORD`；
- `MACOS_KEYCHAIN_PASSWORD`；
- Team API Key 对应的 `APPLE_NOTARY_KEY_BASE64`、`APPLE_NOTARY_KEY_ID` 与 `APPLE_NOTARY_ISSUER_ID`；

如果日后改为 `store` Chrome 模式，必须在独立 fresh runner/受保护 Environment 中仅注入 Chrome Web Store OAuth，调用 API v2 `fetchStatus` 证明 item 已公开发布、部署比例大于 0 且公开 CRX 版本与冻结候选件内 Manifest 一致。该可选门禁不得与 Apple 凭据或 npm/候选运行时共用 runner。

在 macOS Beta 上做本机验收时可以保留系统的全局 `xcode-select`，并仅对项目命令显式指定配套 Xcode，例如 `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer npm run mac:safari:check`。正式发行 workflow 不使用 Beta Xcode。

仓库级 variables 只需要 `OUR_CHOICE_APP_SIGN_IDENTITY`、`OUR_CHOICE_INSTALLER_SIGN_IDENTITY` 与 `OUR_CHOICE_DEVELOPMENT_TEAM`。`macos-release` environment 必须配置 required reviewers 并禁止发起者自审；`main` 必须要求 PR、CODEOWNERS 审核且不得允许管理员绕过。批准者要核对 workflow run 的完整 commit SHA 后再放行，避免具有仓库写权限的人未经授权使用签名凭据。证书与 API key 不得写入仓库或 artifact。本地 `npm run mac:package` 的环境变量清理不是凭据安全边界；若必须在本机正式签名，应使用干净的临时 macOS 用户与专用临时 keychain，不能在日常开发账户中运行不受信任的仓库代码。

正式 artifact 发布前，还必须在干净的 Apple Silicon 与 Intel 测试机分别做真实安装/GUI 验收，而不只依赖展开 Payload 后的 Node smoke test：

```bash
sudo installer -pkg Our-Choice.pkg -target /
spctl --assess --type execute --verbose=4 "/Applications/Our Choice.app"
open -a "/Applications/Our Choice.app"
curl --fail http://127.0.0.1:3000/__our_choice/desktop/health
pluginkit -m -A -D -vv -i com.ourchoice.app.Extension
```

两台测试机都要确认窗口完成渲染、Safari 能发现并启用扩展、一次收藏和一次队列 ACK 成功。该人工门禁用于覆盖安装位置、主 Swift executable 启动、LaunchServices/PlugInKit 注册及真实 Safari 集成；通过后才能分发正式 PKG。

## Docker 兼容性

现有 Dockerfile 和 Compose 拓扑继续运行网站与独立 RSSHub 服务。Mac 应用不内置 Docker 或 RSSHub 镜像；未配置 RSSHub 时保持当前 link-only 降级。高级用户仍可通过 Docker 使用 RSSHub，并通过受支持的环境配置连接它。Docker 构建上下文必须排除本地 `build/` Mac App、浏览器产物与 PKG，避免桌面发行文件被复制进网站镜像或显著拖慢原有 Docker 构建。

## 验收标准

- 生产 Web 构建和现有全部测试通过；
- 桌面运行时能从开发 App 和最终 PKG 展开的 App 内启动首页和 `/api/source-preview`；
- 健康端点只在桌面代理存在，代理只监听 loopback；
- 配对、鉴权失败、入队、去重、重启恢复、读取和 ACK 有确定性测试；
- Chrome transport 不可用时仍保留扩展本地队列；桌面 transport 可用时不重复打开浏览器标签页；
- Chrome 与 Safari 构建产物使用同一业务源码且权限不超出 loopback；
- 完整 Xcode 环境下，`mac:safari:check` 不依赖 Developer ID 证书即可生成并验证 arm64、x86_64 双架构 `.appex`，且转换器不报告 Manifest 解析、缺图标或不支持字段错误；
- `mac:safari:build-local` 生成的开发 App 包含唯一的 `Contents/PlugIns/Our Choice Safari Extension.appex`，App 记录的扩展 ID 与 `.appex` 一致，扩展含已启用的 App Sandbox entitlement，ad-hoc 深度签名通过，且 LaunchServices 注册后 PlugInKit 对该 Bundle ID 只返回位于此 App 内的扩展；
- `mac:package-local` 生成文件名固定且醒目标记的 unsigned PKG，独立验证器从最终 Payload 证明 App、Node、Safari `.appex`、资源和运行时均未在打包中损坏，同时正式验证器仍会拒绝它；
- Swift 源码在支持的 macOS SDK 上通过类型检查；
- 当前架构 `.app` 能冷启动、渲染页面、导入/导出文件并正确打开外部链接；
- 完整 Xcode 环境下，Safari 扩展能被签名应用识别，启用后完成普通收藏与 B站扫描；
- PKG 在干净的 Apple Silicon 与 Intel Mac 上安装到 `/Applications`，Gatekeeper、公证和 staple 验证通过；
- 手动 macOS release workflow 在缺少任一 Apple secret、签名身份、Safari `.appex` 或验证结果时失败且不上传正式 artifact；默认 `manual` Chrome 模式不要求 Chrome Web Store ID，只有显式 `store` 模式才要求已公开发布的 ID 与独立门禁；
- `docker compose up --build` 仍能在 `http://localhost:3000` 提供现有网站。
