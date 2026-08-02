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
  let runtimeListener = null;
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
  return { handleMessage: context.__testHandleMessage, storage, createdTabs, updatedTabs };
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
      { externalId: "946974", name: "影视飓风", url: "https://space.bilibili.com/946974/video" },
      { externalId: "946974", name: "重复", url: "https://space.bilibili.com/946974" },
      { externalId: "bad", name: "无效", url: "javascript:alert(1)" },
      { externalId: "2", name: "另一个 UP", url: "https://space.bilibili.com/2/" },
    ])),
    [
      { externalId: "2", name: "另一个 UP", url: "https://space.bilibili.com/2" },
      { externalId: "946974", name: "影视飓风", url: "https://space.bilibili.com/946974" },
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
  const [app, model, docs, extensionReadme] = await Promise.all([
    text("app/our-choice-app.tsx"),
    text("app/lib/model.ts"),
    text("docs/index.html"),
    text("browser-extension/README.md"),
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
  assert.match(model, /capturedAt\?: string/);
  assert.match(model, /selectionText\?: string/);
  assert.match(model, /importedFrom\?: "browser-extension"/);
  assert.match(docs, /自选浏览器助手/);
  assert.match(docs, /扫描本页/);
  assert.match(extensionReadme, /加载已解压的扩展程序/);
  assert.match(extensionReadme, /不会读取.*Cookie/);
});
