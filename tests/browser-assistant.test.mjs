import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";

const root = new URL("../", import.meta.url);
async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function extensionHelpers() {
  const context = { URL };
  context.globalThis = context;
  new Script(await text("browser-extension/shared.js")).runInNewContext(context);
  return context.OurChoiceExtension;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function backgroundHarness(initialStorage = {}) {
  const storage = plain(initialStorage);
  const createdTabs = [];
  const updatedTabs = [];
  const injectedScripts = [];
  const tabMessages = [];
  let runtimeListener = null;
  let tabUpdatedListener = null;
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, plain(values));
        },
      },
    },
    tabs: {
      async create(options) {
        createdTabs.push(plain(options));
        return { id: 91, windowId: 7, ...options };
      },
      async update(tabId, options) {
        updatedTabs.push({ tabId, options: plain(options) });
        return { id: tabId, windowId: 7, ...options };
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: plain(message) });
        return { ok: true };
      },
      onUpdated: {
        addListener(listener) {
          tabUpdatedListener = listener;
        },
      },
    },
    scripting: {
      async executeScript(options) {
        injectedScripts.push(plain(options));
      },
    },
    windows: { async update() {} },
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
    },
  };
  const context = {
    URL,
    chrome,
    crypto: webcrypto,
    importScripts() {},
    OurChoiceExtension: await extensionHelpers(),
  };
  context.globalThis = context;
  const source = `${await text("browser-extension/background.js")}\nglobalThis.__testHandleMessage = handleMessage;`;
  new Script(source).runInNewContext(context);
  assert.equal(typeof runtimeListener, "function");
  assert.equal(typeof tabUpdatedListener, "function");
  return {
    handleMessage: context.__testHandleMessage,
    storage,
    createdTabs,
    updatedTabs,
    injectedScripts,
    tabMessages,
    tabUpdatedListener,
  };
}

async function contentHarness() {
  let runtimeListener = null;
  const image = {
    currentSrc: "https://i0.hdslb.com/bfs/face/avatar.jpg@96w_96h.webp",
    src: "https://i0.hdslb.com/bfs/face/avatar.jpg@96w_96h.webp",
    getAttribute(name) {
      return name === "alt" ? "影视飓风" : null;
    },
  };
  const anchor = {
    href: "https://space.bilibili.com/946974",
    textContent: "影视飓风",
    parentElement: null,
    getAttribute(name) {
      return name === "title" ? "影视飓风" : null;
    },
  };
  const card = {
    parentElement: null,
    querySelectorAll(selector) {
      return selector.includes("space.bilibili.com") ? [anchor] : selector === "img" ? [image] : [];
    },
  };
  anchor.parentElement = card;
  const document = {
    querySelectorAll(selector) {
      return selector.includes("space.bilibili.com") ? [anchor] : [];
    },
  };
  const context = {
    URL,
    document,
    location: {
      href: "https://space.bilibili.com/123/relation/follow",
      hostname: "space.bilibili.com",
      pathname: "/123/relation/follow",
    },
    window: {},
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListener = listener;
          },
        },
      },
    },
    OurChoiceExtension: await extensionHelpers(),
  };
  context.globalThis = context;
  new Script(await text("browser-extension/content-script.js")).runInNewContext(context);
  assert.equal(typeof runtimeListener, "function");
  return runtimeListener;
}

test("browser assistant manifest keeps permissions narrow and bridges only local app origins", async () => {
  const manifest = JSON.parse(await text("browser-extension/manifest.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal("host_permissions" in manifest, false);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["http://localhost:3000/*", "http://127.0.0.1:3000/*"],
      js: ["app-bridge.js"],
      run_at: "document_start",
    },
  ]);
  assert.equal(manifest.background.service_worker, "background.js");

  const background = await text("browser-extension/background.js");
  const popup = await text("browser-extension/popup.js");
  assert.match(background, /importScripts\("shared\.js"\)/);
  assert.match(popup, /files:\s*\["shared\.js", "content-script\.js"\]/);
  await assert.rejects(text("browser-extension/shared.cjs"));

  for (const path of ["shared.js", "background.js", "content-script.js", "app-bridge.js", "popup.js"]) {
    const source = await text(`browser-extension/${path}`);
    assert.doesNotThrow(() => new Script(source), `${path} should parse`);
  }
});

test("browser assistant normalizes public URLs and Bilibili creator identities", async () => {
  const helpers = await extensionHelpers();

  assert.equal(
    helpers.normalizeHttpUrl(" https://example.com/read?id=1#comments "),
    "https://example.com/read?id=1",
  );
  assert.equal(helpers.normalizeHttpUrl("javascript:alert(1)"), null);
  assert.equal(
    helpers.canonicalBilibiliProfile("https://space.bilibili.com/946974/video?from=search"),
    "https://space.bilibili.com/946974",
  );
  assert.equal(helpers.canonicalBilibiliProfile("https://www.bilibili.com/video/BV1x"), null);

  assert.deepEqual(
    plain(helpers.dedupeBilibiliCandidates([
      { externalId: "946974", name: "B站 UP 主 946974", url: "https://space.bilibili.com/946974/video" },
      {
        externalId: "946974",
        name: "影视飓风",
        url: "https://space.bilibili.com/946974",
        imageUrl: "https://i0.hdslb.com/bfs/face/example.jpg@96w_96h.webp",
      },
      { externalId: "bad", name: "无效", url: "javascript:alert(1)" },
      { externalId: "2", name: "另一个 UP", url: "https://space.bilibili.com/2/" },
    ])),
    [
      { externalId: "2", name: "另一个 UP", url: "https://space.bilibili.com/2" },
      {
        externalId: "946974",
        name: "影视飓风",
        url: "https://space.bilibili.com/946974",
        imageUrl: "https://i0.hdslb.com/bfs/face/example.jpg@96w_96h.webp",
      },
    ],
  );
});

test("browser assistant follow snapshots report additive and non-destructive differences", async () => {
  const { diffFollowSnapshot } = await extensionHelpers();
  const previous = [
    { externalId: "1", name: "旧关注", url: "https://space.bilibili.com/1" },
    { externalId: "2", name: "保留", url: "https://space.bilibili.com/2" },
  ];
  const current = [
    { externalId: "2", name: "保留的新名称", url: "https://space.bilibili.com/2" },
    { externalId: "3", name: "新关注", url: "https://space.bilibili.com/3" },
  ];

  assert.deepEqual(plain(diffFollowSnapshot(previous, current)), {
    added: [current[1]],
    removed: [previous[0]],
    unchanged: [current[0]],
  });
});

test("browser assistant keeps a completed follow scan pending until pairing is configured", async () => {
  const current = [
    { externalId: "946974", name: "影视飓风", url: "https://space.bilibili.com/946974" },
  ];
  const harness = await backgroundHarness({
    ourChoiceBilibiliFollowV1: { active: true, current, previous: [] },
  });

  const response = await harness.handleMessage({ type: "OUR_CHOICE_FINISH_FOLLOW_SCAN" });

  assert.equal(response.ok, false);
  assert.match(response.error, /配对码/);
  assert.deepEqual(harness.storage.ourChoiceBilibiliFollowV1, {
    active: true,
    current,
    previous: [],
  });
  assert.equal(harness.storage.ourChoiceQueueV1, undefined);
  assert.deepEqual(harness.createdTabs, []);
});

test("browser assistant opens an explicit handoff URL after a paired follow scan", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: null,
    },
    ourChoiceBilibiliFollowV1: {
      active: true,
      current: [
        { externalId: "946974", name: "影视飓风", url: "https://space.bilibili.com/946974" },
      ],
      previous: [],
    },
  });

  const response = await harness.handleMessage({ type: "OUR_CHOICE_FINISH_FOLLOW_SCAN" });

  assert.equal(response.ok, true);
  assert.equal(harness.storage.ourChoiceQueueV1.length, 1);
  assert.deepEqual(harness.createdTabs, [{ url: "http://localhost:3000/#browser-assistant" }]);
});

test("browser assistant records automatic follow pages once and keeps resumable progress", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: null,
    },
  });

  const started = await harness.handleMessage({
    type: "OUR_CHOICE_BEGIN_AUTO_FOLLOW_SCAN",
    tabId: 44,
  });
  assert.equal(started.ok, true);
  assert.deepEqual(harness.storage.ourChoiceBilibiliFollowV1.auto, {
    running: true,
    tabId: 44,
    pagesScanned: 0,
    totalPages: null,
    seenSignatures: [],
    error: "",
  });

  const page = {
    type: "OUR_CHOICE_RECORD_AUTO_FOLLOW_PAGE",
    tabId: 44,
    page: 1,
    totalPages: 3,
    signature: "2,946974",
    candidates: [
      { externalId: "2", name: "另一个 UP", url: "https://space.bilibili.com/2" },
      {
        externalId: "946974",
        name: "影视飓风",
        url: "https://space.bilibili.com/946974",
        imageUrl: "https://i0.hdslb.com/bfs/face/example.jpg",
      },
    ],
  };
  const recorded = await harness.handleMessage(page);
  const repeated = await harness.handleMessage(page);

  assert.equal(recorded.ok, true);
  assert.equal(recorded.duplicatePage, false);
  assert.equal(recorded.count, 2);
  assert.equal(repeated.duplicatePage, true);
  assert.equal(harness.storage.ourChoiceBilibiliFollowV1.auto.pagesScanned, 1);
  assert.deepEqual(harness.storage.ourChoiceBilibiliFollowV1.auto.seenSignatures, ["2,946974"]);
  assert.equal(harness.storage.ourChoiceBilibiliFollowV1.current[1].imageUrl, "https://i0.hdslb.com/bfs/face/example.jpg");

  harness.tabUpdatedListener(44, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.injectedScripts, [{
    target: { tabId: 44 },
    files: ["shared.js", "content-script.js"],
  }]);
  assert.deepEqual(harness.tabMessages, [{
    tabId: 44,
    message: { type: "OUR_CHOICE_AUTO_SCAN_BILIBILI" },
  }]);
});

test("browser assistant reads a rendered Bilibili card nickname and avatar", async () => {
  const listener = await contentHarness();
  let response = null;
  listener({ type: "OUR_CHOICE_SCAN_BILIBILI" }, {}, (value) => {
    response = value;
  });

  assert.deepEqual(plain(response), {
    ok: true,
    candidates: [{
      externalId: "946974",
      name: "影视飓风",
      url: "https://space.bilibili.com/946974",
      imageUrl: "https://i0.hdslb.com/bfs/face/avatar.jpg@96w_96h.webp",
    }],
  });
});

test("browser assistant sanitizes captures without credentials or unsafe page data", async () => {
  const { sanitizeCapture } = await extensionHelpers();
  const capture = sanitizeCapture({
    url: "https://example.com/post#reply",
    title: "  一篇文章  ",
    description: " 简介 ",
    selection: " 用户选中的一段话 ",
    imageUrl: "data:text/html,bad",
    siteName: "示例站",
    cookies: "must-not-survive",
    token: "must-not-survive",
    contentType: "article",
  });

  assert.deepEqual(plain(capture), {
    url: "https://example.com/post",
    title: "一篇文章",
    description: "简介",
    selection: "用户选中的一段话",
    siteName: "示例站",
    contentType: "article",
  });
  assert.equal(JSON.stringify(capture).includes("must-not-survive"), false);
});

test("app exposes paired queue import, clip collection routing, and source deduplication", async () => {
  const [app, model, styles, docs, extensionReadme, popupHtml, popup, content] = await Promise.all([
    text("app/our-choice-app.tsx"),
    text("app/lib/model.ts"),
    text("app/globals.css"),
    text("docs/index.html"),
    text("browser-extension/README.md"),
    text("browser-extension/popup.html"),
    text("browser-extension/popup.js"),
    text("browser-extension/content-script.js"),
  ]);

  assert.match(app, /our-choice:assistant:v1/);
  assert.match(app, /OUR_CHOICE_PULL_QUEUE/);
  assert.match(app, /OUR_CHOICE_ACK_QUEUE/);
  assert.match(app, /ASSISTANT_HANDOFF_HASH/);
  assert.match(app, /正在连接浏览器助手/);
  assert.match(app, /浏览器助手没有响应/);
  assert.match(app, /function BrowserAssistantModal/);
  assert.match(app, /浏览器助手/);
  assert.match(app, /检查待处理内容/);
  assert.match(app, /取消关注只供确认，不会自动删除/);
  assert.match(app, /Promise\.all/);
  assert.match(app, /Math\.min\(3,/);
  assert.match(app, /bilibiliSourceKinds/);
  assert.match(app, /这次统一导入哪些内容源/);
  assert.match(app, /固定展示 UP 主主页可发现的 9 类来源/);
  assert.match(app, /selection\.bilibiliSourceKinds\.includes\(kind\)/);
  assert.match(app, /function BilibiliSourceKindPicker/);
  assert.match(app, /type="checkbox"/);
  assert.match(app, /isBilibiliProfileCandidate\(item\.candidate\)/);
  assert.match(app, /preview\.source\.kind === "bilibili"/);
  assert.match(app, /source\.platform === "bilibili"/);
  for (const sourceKind of [
    "article", "coin", "dynamic", "followers", "followings", "like", "bangumi", "fav", "video",
  ]) {
    assert.match(app, new RegExp(`id: "${sourceKind}"`));
  }
  assert.match(app, /需要登录 UID 与 B站 Cookie/);
  assert.match(app, /imageUrl:\s*request\.candidate\.imageUrl\s*\?\?\s*preview\.source\.imageUrl/);
  assert.match(app, /source\?\.imageUrl/);
  assert.match(model, /capturedAt\?: string/);
  assert.match(model, /imageUrl\?: string/);
  assert.match(model, /selectionText\?: string/);
  assert.match(model, /importedFrom\?: "browser-extension"/);
  assert.match(docs, /自选浏览器助手/);
  assert.match(docs, /扫描本页/);
  assert.match(extensionReadme, /加载已解压的扩展程序/);
  assert.match(extensionReadme, /不会读取.*Cookie/);
  assert.match(popupHtml, /id="auto-scan"/);
  assert.match(popup, /OUR_CHOICE_BEGIN_AUTO_FOLLOW_SCAN/);
  assert.match(content, /OUR_CHOICE_AUTO_SCAN_BILIBILI/);
  assert.match(content, /MAX_AUTO_SCAN_PAGES\s*=\s*200/);
  assert.match(content, /AUTO_SCAN_PAGE_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(content, /currentSrc/);
  assert.match(styles, /\.source-avatar img/);
  assert.match(styles, /object-fit:\s*cover/);
});
