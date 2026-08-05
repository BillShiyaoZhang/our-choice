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

async function backgroundHarness(initialStorage = {}, options = {}) {
  const storage = plain(initialStorage);
  const createdTabs = [];
  const readTabs = [];
  const updatedTabs = [];
  const injectedScripts = [];
  const tabMessages = [];
  const desktopRequests = [];
  let runtimeListener = null;
  let tabUpdatedListener = null;
  const browserApi = {
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
      async create(createOptions) {
        createdTabs.push(plain(createOptions));
        if (options.tabsCreate) return options.tabsCreate(createOptions);
        return { id: 91, windowId: 7, ...createOptions };
      },
      async get(tabId) {
        readTabs.push(tabId);
        if (options.tabsGet) return options.tabsGet(tabId);
        throw new Error("tab not found");
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
    crypto: webcrypto,
    fetch: async (url, init) => {
      desktopRequests.push({ url: String(url), init: plain(init) });
      if (options.desktopResponse) return options.desktopResponse(url, init);
      throw new Error("desktop runtime is unavailable");
    },
    importScripts() {},
    OurChoiceExtension: await extensionHelpers(),
  };
  context[options.namespace === "browser" ? "browser" : "chrome"] = browserApi;
  context.globalThis = context;
  new Script(await text("browser-extension/extension-api.js")).runInNewContext(context);
  const source = `${await text("browser-extension/background.js")}
globalThis.__testHandleMessage = handleMessage;
globalThis.__testEnqueueLocally = enqueueLocally;
globalThis.__testFlushLocalQueue = flushLocalQueue;`;
  new Script(source).runInNewContext(context);
  assert.equal(typeof runtimeListener, "function");
  assert.equal(typeof tabUpdatedListener, "function");
  return {
    handleMessage: context.__testHandleMessage,
    enqueueLocally: context.__testEnqueueLocally,
    flushLocalQueue: context.__testFlushLocalQueue,
    storage,
    createdTabs,
    readTabs,
    updatedTabs,
    injectedScripts,
    tabMessages,
    desktopRequests,
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
  const browserApi = {
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
    document,
    location: {
      href: "https://space.bilibili.com/123/relation/follow",
      hostname: "space.bilibili.com",
      pathname: "/123/relation/follow",
    },
    window: {},
    browser: browserApi,
    OurChoiceExtension: await extensionHelpers(),
  };
  context.globalThis = context;
  new Script(await text("browser-extension/extension-api.js")).runInNewContext(context);
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
  assert.deepEqual(manifest.host_permissions, [
    "http://localhost/*",
    "http://127.0.0.1/*",
  ]);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["http://localhost/*", "http://127.0.0.1/*"],
      js: ["extension-api.js", "app-bridge.js"],
      run_at: "document_start",
    },
  ]);
  assert.equal(manifest.background.service_worker, "background.js");

  const background = await text("browser-extension/background.js");
  const popup = await text("browser-extension/popup.js");
  const popupHtml = await text("browser-extension/popup.html");
  assert.match(background, /importScripts\("extension-api\.js", "shared\.js"\)/);
  assert.match(popup, /files:\s*\["extension-api\.js", "shared\.js", "content-script\.js"\]/);
  assert.match(popup, /result\.delivery === "desktop"/);
  assert.match(popupHtml, /本地应用地址（自动发现）/);
  assert.match(popupHtml, /Mac 应用会自动连接/);
  assert.match(popupHtml, /Docker \/ 网页模式配对码/);
  await assert.rejects(text("browser-extension/shared.cjs"));

  for (const path of ["extension-api.js", "shared.js", "background.js", "content-script.js", "app-bridge.js", "popup.js"]) {
    const source = await text(`browser-extension/${path}`);
    assert.doesNotThrow(() => new Script(source), `${path} should parse`);
  }
});

test("browser assistant obtains a native session without a pairing code", async () => {
  const sessionToken = "native-extension-session-token-with-at-least-32-bytes";
  const harness = await backgroundHarness({}, {
    desktopResponse: async (url, init) => {
      const target = String(url);
      if (target === "http://localhost:3000/__our_choice/desktop/health") {
        assert.equal(init.headers["x-our-choice-extension-session"], "request");
        return Response.json({
          product: "our-choice-desktop",
          version: "0.1.0",
          extensionSession: sessionToken,
        });
      }
      if (target === "http://localhost:3000/__our_choice/assistant/enqueue") {
        assert.equal(init.headers.authorization, `Bearer ${sessionToken}`);
        return Response.json({ ok: true, enqueued: true });
      }
      throw new Error(`unexpected desktop request: ${target}`);
    },
  });

  const response = await harness.handleMessage({
    type: "OUR_CHOICE_ENQUEUE",
    item: {
      kind: "clip",
      destination: "later",
      page: { url: "https://example.com/automatic", title: "Automatic" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery, "desktop");
  assert.equal(harness.storage.ourChoiceConfigV1.pairingCode, "");
  assert.equal(harness.storage.ourChoiceConfigV1.extensionSession, sessionToken);
});

test("browser assistant refreshes an expired native session once after 401", async () => {
  const oldToken = "expired-native-session-token-with-at-least-32-bytes";
  const freshToken = "fresh-native-session-token-with-at-least-32-bytes";
  let enqueueAttempts = 0;
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "",
      extensionSession: oldToken,
      appTabId: null,
    },
  }, {
    desktopResponse: async (url, init) => {
      const target = String(url);
      if (target.endsWith("/__our_choice/desktop/health")) {
        assert.equal(init.headers["x-our-choice-extension-session"], "request");
        return Response.json({
          product: "our-choice-desktop",
          version: "0.1.0",
          extensionSession: freshToken,
        });
      }
      if (target.endsWith("/__our_choice/assistant/enqueue")) {
        enqueueAttempts += 1;
        if (init.headers.authorization === `Bearer ${oldToken}`) {
          return Response.json({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "会话已过期。" },
          }, { status: 401 });
        }
        assert.equal(init.headers.authorization, `Bearer ${freshToken}`);
        return Response.json({ ok: true, enqueued: true });
      }
      throw new Error(`unexpected desktop request: ${target}`);
    },
  });

  const response = await harness.handleMessage({
    type: "OUR_CHOICE_ENQUEUE",
    item: {
      kind: "clip",
      destination: "later",
      page: { url: "https://example.com/restart", title: "Restart" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery, "desktop");
  assert.equal(enqueueAttempts, 2);
  assert.equal(harness.storage.ourChoiceConfigV1.extensionSession, freshToken);
});

test("browser assistant discovers the desktop port and ignores impostor health responses", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: null,
    },
  }, {
    desktopResponse: async (url) => {
      const target = String(url);
      if (target.endsWith("/__our_choice/desktop/health")) {
        if (target.startsWith("http://127.0.0.1:3000")) {
          return Response.json({ product: "some-other-local-service" });
        }
        if (target.startsWith("http://127.0.0.1:3001")) {
          return Response.json({ product: "our-choice-desktop", version: "0.1.0" });
        }
        return Response.json({ product: "not-our-choice" }, { status: 404 });
      }
      if (target === "http://127.0.0.1:3001/__our_choice/assistant/enqueue") {
        return Response.json({ ok: true, queued: true });
      }
      throw new Error(`unexpected desktop request: ${target}`);
    },
  });

  const response = await harness.handleMessage({
    type: "OUR_CHOICE_ENQUEUE",
    item: {
      kind: "clip",
      destination: "later",
      page: { url: "https://example.com/post", title: "Example" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery, "desktop");
  assert.equal(harness.storage.ourChoiceConfigV1.appUrl, "http://127.0.0.1:3001");
  assert.equal(harness.storage.ourChoiceConfigV1.pairingCode, "paired-locally");
  assert.equal(
    harness.desktopRequests.some(({ url }) => (
      url === "http://127.0.0.1:3001/__our_choice/assistant/enqueue"
    )),
    true,
  );
});

test("browser assistant accepts explicit fixed loopback ports and rejects unsafe app origins", async () => {
  const harness = await backgroundHarness();
  const save = (appUrl) => harness.handleMessage({
    type: "OUR_CHOICE_SAVE_CONFIG",
    config: { appUrl },
  });

  for (const [input, expected] of [
    ["http://localhost:3100/", "http://localhost:3100"],
    ["http://localhost:80", "http://localhost:80"],
    ["http://127.0.0.1:1", "http://127.0.0.1:1"],
    ["http://127.0.0.1:65535", "http://127.0.0.1:65535"],
  ]) {
    const response = await save(input);
    assert.equal(response.ok, true, input);
    assert.equal(response.config.appUrl, expected);
  }

  for (const input of [
    "http://localhost",
    "http://localhost:0",
    "http://localhost:65536",
    "https://localhost:3100",
    "http://user:password@localhost:3100",
    "http://localhost:3100/private",
    "http://localhost:3100/?token=secret",
    "http://localhost:3100/#secret",
    "http://localhost.example:3100",
  ]) {
    const response = await save(input);
    assert.equal(response.ok, false, input);
    assert.match(response.error, /明确端口.*localhost.*127\.0\.0\.1/);
  }
});

test("browser assistant never reuses a remembered tab after it leaves the configured app origin", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: 42,
    },
  }, {
    tabsGet: async () => ({
      id: 42,
      windowId: 3,
      url: "https://unrelated.example/account",
    }),
  });

  const response = await harness.handleMessage({ type: "OUR_CHOICE_OPEN_APP" });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.readTabs, [42]);
  assert.deepEqual(harness.updatedTabs, []);
  assert.deepEqual(harness.createdTabs, [{ url: "http://localhost:3000" }]);
  assert.deepEqual(harness.storage.ourChoiceConfigV1, {
    appUrl: "http://localhost:3000",
    pairingCode: "paired-locally",
    appTabId: 91,
  });
});

test("browser assistant reuses a remembered tab only while it remains on the app origin", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: 42,
    },
  }, {
    tabsGet: async () => ({
      id: 42,
      windowId: 3,
      url: "http://localhost:3000/settings",
    }),
  });

  const response = await harness.handleMessage({ type: "OUR_CHOICE_OPEN_APP" });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.createdTabs, []);
  assert.deepEqual(harness.updatedTabs, [{
    tabId: 42,
    options: { active: true, url: "http://localhost:3000" },
  }]);
  assert.equal(harness.storage.ourChoiceConfigV1.appTabId, 42);
});

test("browser assistant serializes app-tab discovery with concurrent config updates", async () => {
  let releaseCreate;
  let createStarted;
  const createStartedPromise = new Promise((resolve) => { createStarted = resolve; });
  const createdPromise = new Promise((resolve) => { releaseCreate = resolve; });
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "old-pairing",
      appTabId: null,
    },
  }, {
    tabsCreate: async (options) => {
      createStarted();
      await createdPromise;
      return { id: 77, windowId: 4, ...options };
    },
  });

  const opening = harness.handleMessage({ type: "OUR_CHOICE_OPEN_APP" });
  await createStartedPromise;
  const saving = harness.handleMessage({
    type: "OUR_CHOICE_SAVE_CONFIG",
    config: {
      appUrl: "http://127.0.0.1:3100",
      pairingCode: "new-pairing",
    },
  });
  releaseCreate();
  assert.equal((await opening).ok, true);
  assert.equal((await saving).ok, true);
  assert.deepEqual(harness.storage.ourChoiceConfigV1, {
    appUrl: "http://127.0.0.1:3100",
    pairingCode: "new-pairing",
    appTabId: 77,
  });
});

test("browser assistant delivers directly to the paired desktop runtime", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: null,
    },
  }, {
    namespace: "browser",
    desktopResponse: async () => Response.json({ ok: true, queued: true }),
  });

  const response = await harness.handleMessage({
    type: "OUR_CHOICE_ENQUEUE",
    item: {
      kind: "clip",
      destination: "later",
      page: { url: "https://example.com/post", title: "Example" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery, "desktop");
  assert.equal(harness.storage.ourChoiceQueueV1, undefined);
  assert.deepEqual(harness.createdTabs, []);
  assert.equal(harness.desktopRequests.length, 1);
  assert.equal(
    harness.desktopRequests[0].url,
    "http://localhost:3000/__our_choice/assistant/enqueue",
  );
  assert.equal(
    harness.desktopRequests[0].init.headers.authorization,
    "Bearer paired-locally",
  );
});

test("browser assistant preserves structured desktop errors when falling back locally", async () => {
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "stale-pairing-code",
      appTabId: null,
    },
  }, {
    desktopResponse: async () => Response.json({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "配对码不匹配。" },
    }, { status: 401 }),
  });

  const response = await harness.handleMessage({
    type: "OUR_CHOICE_ENQUEUE",
    item: {
      kind: "clip",
      destination: "later",
      page: { url: "https://example.com/post", title: "Example" },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.delivery, "local");
  assert.equal(response.desktop.error, "配对码不匹配。");
  assert.equal(harness.storage.ourChoiceQueueV1.length, 1);
});

test("browser assistant normalizes public URLs and Bilibili creator identities", async () => {
  const helpers = await extensionHelpers();

  assert.equal(
    helpers.normalizeHttpUrl(" https://example.com/read?id=1#comments "),
    "https://example.com/read?id=1",
  );
  assert.equal(helpers.normalizeHttpUrl("javascript:alert(1)"), null);
  assert.equal(helpers.normalizeHttpUrl("https://user:secret@example.com/read"), null);
  assert.equal(helpers.normalizeHttpUrl(`https://example.com/${"x".repeat(4_100)}`), null);
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

test("browser assistant queue flush cannot erase a concurrent local enqueue", async () => {
  let releaseDesktop;
  let desktopStarted;
  const desktopStartedPromise = new Promise((resolve) => {
    desktopStarted = resolve;
  });
  const desktopResponsePromise = new Promise((resolve) => {
    releaseDesktop = resolve;
  });
  const current = {
    appUrl: "http://localhost:3000",
    pairingCode: "paired",
    appTabId: null,
  };
  const oldItem = {
    id: "assistant-old",
    capturedAt: "2026-08-04T00:00:00.000Z",
    kind: "clip",
    destination: "later",
    page: { url: "https://example.com/old", title: "Old", contentType: "article" },
  };
  const newItem = {
    id: "assistant-new",
    capturedAt: "2026-08-04T00:00:01.000Z",
    kind: "clip",
    destination: "later",
    page: { url: "https://example.com/new", title: "New", contentType: "article" },
  };
  const harness = await backgroundHarness(
    { ourChoiceQueueV1: [oldItem], ourChoiceConfigV1: current },
    {
      desktopResponse: async () => {
        desktopStarted();
        return desktopResponsePromise;
      },
    },
  );

  const flushing = harness.flushLocalQueue(current);
  await desktopStartedPromise;
  await harness.enqueueLocally(newItem);
  releaseDesktop(Response.json({ ok: true, queued: true }));
  const result = await flushing;

  assert.equal(result.delivered, 1);
  assert.deepEqual(harness.storage.ourChoiceQueueV1.map((item) => item.id), ["assistant-new"]);
});

test("browser assistant serializes concurrent enqueues and fails closed when the queue is full", async () => {
  const harness = await backgroundHarness();
  const makeItem = (id) => ({
    id,
    capturedAt: "2026-08-04T00:00:00.000Z",
    kind: "clip",
    destination: "later",
    page: { url: `https://example.com/${id}`, title: id, contentType: "article" },
  });

  await Promise.all([
    harness.enqueueLocally(makeItem("assistant-a")),
    harness.enqueueLocally(makeItem("assistant-b")),
  ]);
  assert.deepEqual(
    harness.storage.ourChoiceQueueV1.map((item) => item.id),
    ["assistant-a", "assistant-b"],
  );

  harness.storage.ourChoiceQueueV1 = Array.from(
    { length: 500 },
    (_, index) => makeItem(`assistant-${index}`),
  );
  await assert.rejects(
    harness.enqueueLocally(makeItem("assistant-overflow")),
    /待处理队列已满/,
  );
  assert.equal(harness.storage.ourChoiceQueueV1.length, 500);
  assert.equal(
    harness.storage.ourChoiceQueueV1.some((item) => item.id === "assistant-overflow"),
    false,
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

test("browser assistant rejects an oversized follow batch without creating a poison queue item", async () => {
  const current = Array.from({ length: 501 }, (_, index) => ({
    externalId: String(index + 1),
    name: `UP ${index + 1}`,
    url: `https://space.bilibili.com/${index + 1}`,
  }));
  const state = { active: true, current, previous: [], auto: null };
  const harness = await backgroundHarness({
    ourChoiceConfigV1: {
      appUrl: "http://localhost:3000",
      pairingCode: "paired-locally",
      appTabId: null,
    },
    ourChoiceBilibiliFollowV1: state,
  });

  const response = await harness.handleMessage({ type: "OUR_CHOICE_FINISH_FOLLOW_SCAN" });
  assert.equal(response.ok, false);
  assert.match(response.error, /500.*保留/);
  assert.deepEqual(harness.storage.ourChoiceBilibiliFollowV1, state);
  assert.equal(harness.storage.ourChoiceQueueV1, undefined);
  assert.equal(harness.desktopRequests.length, 0);
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
    files: ["extension-api.js", "shared.js", "content-script.js"],
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
  assert.match(app, /__our_choice\/desktop\/health/);
  assert.match(app, /const DESKTOP_ASSISTANT_PATH = "\/__our_choice\/assistant"/);
  assert.match(app, /\$\{DESKTOP_ASSISTANT_PATH\}\/pair/);
  assert.match(app, /\$\{DESKTOP_ASSISTANT_PATH\}\/queue/);
  assert.match(app, /\$\{DESKTOP_ASSISTANT_PATH\}\/ack/);
  assert.match(app, /assistantQueueOrigin.*"desktop"/);
  assert.match(app, /function desktopErrorMessage/);
  assert.match(
    app,
    /function normalizedPublicUrl[\s\S]+candidate\.length > 4_096[\s\S]+url\.username \|\|[\s\S]+url\.password/,
  );
  assert.match(app, /errorRecord\.message/);
  assert.match(app, /response\.ok && payload\.ok === true/);
  assert.match(app, /const acknowledgement =[\s\S]*await acknowledgeAssistantQueue/);
  assert.match(app, /acknowledgedQueueIds = acknowledgement\.ok/);
  assert.match(app, /setInterval/);
  assert.match(app, /正在连接浏览器助手/);
  assert.match(app, /浏览器助手没有响应/);
  assert.match(app, /function BrowserAssistantModal/);
  assert.match(app, /浏览器助手/);
  assert.match(app, /检查待处理内容/);
  assert.match(app, /取消关注只供确认，不会自动删除/);
  assert.match(app, /Promise\.all/);
  assert.match(app, /ASSISTANT_IMPORT_CONCURRENCY\s*=\s*6/);
  assert.match(app, /interface AssistantImportTaskState/);
  assert.match(app, /function AssistantImportProgress/);
  assert.match(app, /已导入.*\/.*全部/);
  assert.match(app, /暂停导入/);
  assert.match(app, /继续导入/);
  assert.match(app, /取消导入/);
  assert.match(app, /收起导入进度/);
  assert.match(app, /assistantImportControllerRef/);
  assert.match(app, /AbortController/);
  assert.match(app, /controller\.abortControllers\.add/);
  assert.match(app, /bilibiliSelectionIds/);
  assert.match(app, /fetchPreview\([\s\S]*directSelections/);
  assert.match(app, /setAssistantOpen\(false\)[\s\S]*processAssistantImport\(selection\)/);
  assert.match(styles, /\.assistant-import-progress/);
  assert.match(styles, /\.assistant-import-progress-bar/);
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
  assert.match(content, /finished\.delivery === "desktop"/);
  assert.match(content, /MAX_AUTO_SCAN_PAGES\s*=\s*200/);
  assert.match(content, /AUTO_SCAN_PAGE_TIMEOUT_MS\s*=\s*15_000/);
  assert.match(content, /currentSrc/);
  assert.match(styles, /\.source-avatar img/);
  assert.match(styles, /object-fit:\s*cover/);
});
