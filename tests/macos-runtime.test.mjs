import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const NATIVE_BOOTSTRAP_SECRET = "native-bootstrap-secret-for-runtime-tests-2026";
const NATIVE_BOOTSTRAP_HEADER = "x-our-choice-native-bootstrap";
const EXTENSION_SESSION = "native-extension-session-for-runtime-tests-2026";

function request(path, init = {}) {
  return new Request(`http://localhost:3000${path}`, init);
}

function authenticatedHeaders(pairingCode, extra = {}) {
  return {
    authorization: `Bearer ${pairingCode}`,
    ...extra,
  };
}

function nativePairHeaders(origin = "http://localhost:3000", secret = NATIVE_BOOTSTRAP_SECRET) {
  return {
    "content-type": "application/json",
    origin,
    [NATIVE_BOOTSTRAP_HEADER]: secret,
  };
}

test("desktop automatic port candidates are deterministic and explicit overrides stay exact", async () => {
  const { desktopPortCandidates } = await import("../macos/runtime/server.mjs");

  assert.deepEqual(desktopPortCandidates(3000, true), Array.from(
    { length: 32 },
    (_, index) => 3000 + index,
  ));
  assert.deepEqual(desktopPortCandidates(4123, false), [4123]);
  assert.deepEqual(desktopPortCandidates(0, false), [0]);
  assert.throws(() => desktopPortCandidates(65_535, true), /自动端口范围/);
});

test("desktop health discloses the ephemeral session only to extension origins", async () => {
  const {
    desktopHealthPreflightResponse,
    desktopHealthResponse,
  } = await import("../macos/runtime/server.mjs");

  const ordinary = desktopHealthResponse("0.2.0", EXTENSION_SESSION, "http://localhost:3000");
  assert.deepEqual(await ordinary.json(), {
    ok: true,
    product: "our-choice-desktop",
    version: "0.2.0",
  });
  assert.equal(ordinary.headers.get("access-control-allow-origin"), null);

  for (const origin of [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "safari-web-extension://session-specific-uuid",
  ]) {
    const unmarked = desktopHealthResponse("0.2.0", EXTENSION_SESSION, origin);
    assert.equal(Object.hasOwn(await unmarked.json(), "extensionSession"), false);

    const extension = desktopHealthResponse("0.2.0", EXTENSION_SESSION, origin, true);
    assert.deepEqual(await extension.json(), {
      ok: true,
      product: "our-choice-desktop",
      version: "0.2.0",
      extensionSession: EXTENSION_SESSION,
    });
    assert.equal(extension.headers.get("access-control-allow-origin"), origin);

    const preflight = desktopHealthPreflightResponse(
      origin,
      "x-our-choice-extension-session",
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "x-our-choice-extension-session",
    );
  }

  const missingOrigin = desktopHealthResponse("0.2.0", EXTENSION_SESSION, "", true);
  assert.equal((await missingOrigin.json()).extensionSession, EXTENSION_SESSION);

  const ordinaryMarked = desktopHealthResponse(
    "0.2.0",
    EXTENSION_SESSION,
    "https://example.com",
    true,
  );
  assert.equal(Object.hasOwn(await ordinaryMarked.json(), "extensionSession"), false);
  assert.equal(
    desktopHealthPreflightResponse(
      "https://example.com",
      "x-our-choice-extension-session",
    ).status,
    403,
  );
});

test("desktop assistant accepts the ephemeral extension session and native queue bootstrap", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-native-session-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
    extensionSession: EXTENSION_SESSION,
  });

  const enqueued = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders(EXTENSION_SESSION, {
      "content-type": "application/json",
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    }),
    body: JSON.stringify({
      item: {
        id: "automatic-native-item",
        kind: "clip",
        capturedAt: "2026-08-04T00:00:00.000Z",
        destination: "later",
        page: { url: "https://example.com/automatic", title: "Automatic" },
      },
    }),
  }));
  assert.equal(enqueued.status, 200);

  const queue = await bridge.handle(request("/__our_choice/assistant/queue", {
    headers: {
      origin: "http://localhost:3000",
      [NATIVE_BOOTSTRAP_HEADER]: NATIVE_BOOTSTRAP_SECRET,
    },
  }));
  assert.equal(queue.status, 200);
  assert.deepEqual((await queue.json()).items.map((item) => item.id), ["automatic-native-item"]);

  const acknowledged = await bridge.handle(request("/__our_choice/assistant/ack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      [NATIVE_BOOTSTRAP_HEADER]: NATIVE_BOOTSTRAP_SECRET,
    },
    body: JSON.stringify({ ids: ["automatic-native-item"] }),
  }));
  assert.equal(acknowledged.status, 200);
  assert.equal((await acknowledged.json()).acknowledged, 1);
});

test("desktop assistant bridge pairs locally and persists an authenticated queue", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-assistant-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });
  const pairingCode = "a-local-pairing-secret";

  const rejectedPair = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders("https://example.com"),
    body: JSON.stringify({ pairingCode }),
  }));
  assert.equal(rejectedPair.status, 403);

  const rejectedBrowserPair = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ pairingCode }),
  }));
  assert.equal(rejectedBrowserPair.status, 403);
  assert.equal((await rejectedBrowserPair.json()).error.code, "NATIVE_BOOTSTRAP_FORBIDDEN");

  const rejectedWrongBootstrap = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders("http://localhost:3000", `${NATIVE_BOOTSTRAP_SECRET}-wrong`),
    body: JSON.stringify({ pairingCode }),
  }));
  assert.equal(rejectedWrongBootstrap.status, 403);

  const paired = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders(),
    body: JSON.stringify({ pairingCode }),
  }));
  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), { ok: true, paired: true });

  const rejectedBrowserRevoke = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ pairingCode: "" }),
  }));
  assert.equal(rejectedBrowserRevoke.status, 403);

  const rejectedItem = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders("wrong", {
      "content-type": "application/json",
      origin: "chrome-extension://abcdefghijklmnop",
    }),
    body: JSON.stringify({ item: { id: "capture-1", kind: "clip" } }),
  }));
  assert.equal(rejectedItem.status, 401);

  const malformedItem = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders(pairingCode, {
      "content-type": "application/json",
      origin: "chrome-extension://abcdefghijklmnop",
    }),
    body: JSON.stringify({ item: { id: "future-item", kind: "not-supported" } }),
  }));
  assert.equal(malformedItem.status, 400);

  const item = {
    id: "capture-1",
    kind: "clip",
    capturedAt: "2026-08-03T00:00:00.000Z",
    destination: "later",
    page: { url: "https://example.com/post", title: "Example", contentType: "article" },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const enqueued = await bridge.handle(request("/__our_choice/assistant/enqueue", {
      method: "POST",
      headers: authenticatedHeaders(pairingCode, {
        "content-type": "application/json",
        origin: "chrome-extension://abcdefghijklmnop",
      }),
      body: JSON.stringify({ item }),
    }));
    assert.equal(enqueued.status, 200);
  }

  const persistedText = await readFile(join(dataDir, "assistant-state.json"), "utf8");
  assert.equal(persistedText.includes(pairingCode), false);
  assert.equal(persistedText.includes(NATIVE_BOOTSTRAP_SECRET), false);

  const restarted = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });
  const queueResponse = await restarted.handle(request("/__our_choice/assistant/queue", {
    headers: authenticatedHeaders(pairingCode, {
      referer: "http://localhost:3000/settings",
      "sec-fetch-site": "same-origin",
    }),
  }));
  assert.equal(queueResponse.status, 200);
  assert.deepEqual((await queueResponse.json()).items, [item]);

  const acknowledged = await restarted.handle(request("/__our_choice/assistant/ack", {
    method: "POST",
    headers: authenticatedHeaders(pairingCode, {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    }),
    body: JSON.stringify({ ids: [item.id] }),
  }));
  assert.equal(acknowledged.status, 200);

  const emptyQueue = await restarted.handle(request("/__our_choice/assistant/queue", {
    headers: authenticatedHeaders(pairingCode, { origin: "http://localhost:3000" }),
  }));
  assert.deepEqual((await emptyQueue.json()).items, []);

  const revoked = await restarted.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders(),
    body: JSON.stringify({ revoke: true }),
  }));
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true, paired: false });

  const oldPairingRejected = await restarted.handle(request("/__our_choice/assistant/queue", {
    headers: authenticatedHeaders(pairingCode, { origin: "http://localhost:3000" }),
  }));
  assert.equal(oldPairingRejected.status, 401);
});

test("desktop assistant bridge persists only normalized allowlisted queue fields", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-assistant-normalized-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });
  const pairingCode = "normalized-queue-pairing";
  const productOrigin = "http://localhost:3000";
  const extensionOrigin = "chrome-extension://abcdefghijklmnop";

  const paired = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders(productOrigin),
    body: JSON.stringify({ pairingCode }),
  }));
  assert.equal(paired.status, 200);

  const forbiddenSecrets = [
    "secret-token-that-must-not-persist",
    "session-cookie-that-must-not-persist",
    "nested-authorization-that-must-not-persist",
  ];
  const clipResponse = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders(pairingCode, {
      "content-type": "application/json",
      origin: extensionOrigin,
    }),
    body: JSON.stringify({
      token: forbiddenSecrets[0],
      cookies: forbiddenSecrets[1],
      item: {
        id: "  normalized-clip  ",
        kind: "clip",
        capturedAt: "2026-08-03T08:00:00+08:00",
        destination: "collection",
        token: forbiddenSecrets[0],
        cookies: [forbiddenSecrets[1]],
        metadata: { authorization: forbiddenSecrets[2] },
        page: {
          url: " https://example.com/articles/one///#private-fragment ",
          title: `  A\n normalized   title ${"x".repeat(300)}  `,
          description: "  Public\n summary  ",
          selection: " selected   words ",
          siteName: " Example   Site ",
          imageUrl: "https://cdn.example.com/image.png#tracking",
          contentType: "video",
          cookies: forbiddenSecrets[1],
          credentials: { authorization: forbiddenSecrets[2] },
        },
      },
    }),
  }));
  assert.equal(clipResponse.status, 200);
  const normalizedClip = (await clipResponse.json()).item;
  assert.deepEqual(Object.keys(normalizedClip).sort(), [
    "capturedAt",
    "destination",
    "id",
    "kind",
    "page",
  ]);
  assert.deepEqual(Object.keys(normalizedClip.page).sort(), [
    "contentType",
    "description",
    "imageUrl",
    "selection",
    "siteName",
    "title",
    "url",
  ]);
  assert.equal(normalizedClip.id, "normalized-clip");
  assert.equal(normalizedClip.capturedAt, "2026-08-03T00:00:00.000Z");
  assert.equal(normalizedClip.page.url, "https://example.com/articles/one");
  assert.equal(normalizedClip.page.imageUrl, "https://cdn.example.com/image.png");
  assert.equal(normalizedClip.page.title.length, 240);
  assert.equal(normalizedClip.page.description, "Public summary");
  assert.equal(normalizedClip.page.selection, "selected words");
  assert.equal(normalizedClip.page.siteName, "Example Site");

  const sourceResponse = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders(pairingCode, {
      "content-type": "application/json",
      origin: extensionOrigin,
    }),
    body: JSON.stringify({
      item: {
        id: "normalized-source",
        kind: "source",
        capturedAt: "2026-08-03T01:02:03.456Z",
        candidate: {
          url: "https://example.com/creator/#profile",
          name: ` Creator ${"n".repeat(160)}`,
          externalId: `external-${"i".repeat(100)}`,
          imageUrl: "https://cdn.example.com/avatar.png#size",
          token: forbiddenSecrets[0],
          cookies: forbiddenSecrets[1],
          private: { headers: { authorization: forbiddenSecrets[2] } },
        },
        request: { headers: { cookie: forbiddenSecrets[1] } },
      },
    }),
  }));
  assert.equal(sourceResponse.status, 200);
  const normalizedSource = (await sourceResponse.json()).item;
  assert.deepEqual(Object.keys(normalizedSource.candidate).sort(), [
    "externalId",
    "imageUrl",
    "name",
    "url",
  ]);
  assert.equal(normalizedSource.candidate.url, "https://example.com/creator");
  assert.equal(normalizedSource.candidate.imageUrl, "https://cdn.example.com/avatar.png");
  assert.equal(normalizedSource.candidate.name.length, 120);
  assert.equal(normalizedSource.candidate.externalId.length, 80);

  const followResponse = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "POST",
    headers: authenticatedHeaders(pairingCode, {
      "content-type": "application/json",
      origin: extensionOrigin,
    }),
    body: JSON.stringify({
      item: {
        id: "normalized-follow-batch",
        kind: "follow-batch",
        capturedAt: "2026-08-03T02:03:04.000Z",
        platform: "bilibili",
        candidates: [{
          url: "https://space.bilibili.com/123/#profile",
          name: " Public Creator ",
          externalId: "123",
          cookies: forbiddenSecrets[1],
        }],
        added: [{
          url: "https://space.bilibili.com/123/",
          name: "Public Creator",
          externalId: "123",
          token: forbiddenSecrets[0],
        }],
        removed: [],
        previousCount: 0,
        diff: { authorization: forbiddenSecrets[2] },
      },
    }),
  }));
  assert.equal(followResponse.status, 200);
  const normalizedFollow = (await followResponse.json()).item;
  assert.deepEqual(Object.keys(normalizedFollow).sort(), [
    "added",
    "candidates",
    "capturedAt",
    "id",
    "kind",
    "platform",
    "previousCount",
    "removed",
  ]);
  assert.deepEqual(normalizedFollow.candidates, [{
    url: "https://space.bilibili.com/123",
    name: "Public Creator",
    externalId: "123",
  }]);
  assert.deepEqual(normalizedFollow.added, normalizedFollow.candidates);

  const queueResponse = await bridge.handle(request("/__our_choice/assistant/queue", {
    headers: authenticatedHeaders(pairingCode, { origin: productOrigin }),
  }));
  assert.equal(queueResponse.status, 200);
  assert.deepEqual(
    (await queueResponse.json()).items,
    [normalizedClip, normalizedSource, normalizedFollow],
  );

  const persistedText = await readFile(join(dataDir, "assistant-state.json"), "utf8");
  for (const secret of forbiddenSecrets) assert.equal(persistedText.includes(secret), false);
  assert.deepEqual(
    JSON.parse(persistedText).queue,
    [normalizedClip, normalizedSource, normalizedFollow],
  );
});

test("desktop assistant bridge rejects credential-bearing and oversized URLs", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-assistant-url-boundary-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });
  const pairingCode = "url-boundary-pairing";
  const headers = authenticatedHeaders(pairingCode, {
    "content-type": "application/json",
    origin: "chrome-extension://abcdefghijklmnop",
  });

  await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders(),
    body: JSON.stringify({ pairingCode }),
  }));

  const common = { capturedAt: "2026-08-03T00:00:00.000Z" };
  const invalidItems = [
    {
      ...common,
      id: "credential-page",
      kind: "clip",
      destination: "later",
      page: { url: "https://alice:password@example.com/article" },
    },
    {
      ...common,
      id: "credential-source",
      kind: "source",
      candidate: { url: "https://alice:password@example.com/creator" },
    },
    {
      ...common,
      id: "credential-image",
      kind: "source",
      candidate: {
        url: "https://example.com/creator",
        imageUrl: "https://alice:password@cdn.example.com/avatar.png",
      },
    },
    {
      ...common,
      id: "oversized-url",
      kind: "source",
      candidate: { url: `https://example.com/${"x".repeat(4_100)}` },
    },
    {
      ...common,
      id: "x".repeat(161),
      kind: "source",
      candidate: { url: "https://example.com/creator" },
    },
    {
      ...common,
      id: "oversized-previous-count",
      kind: "follow-batch",
      platform: "bilibili",
      candidates: [{ url: "https://space.bilibili.com/123" }],
      added: [],
      removed: [],
      previousCount: 1_000_001,
    },
  ];

  for (const item of invalidItems) {
    const response = await bridge.handle(request("/__our_choice/assistant/enqueue", {
      method: "POST",
      headers,
      body: JSON.stringify({ item }),
    }));
    assert.equal(response.status, 400, item.id);
    assert.equal((await response.json()).error.code, "INVALID_ITEM", item.id);
  }

  const queueResponse = await bridge.handle(request("/__our_choice/assistant/queue", {
    headers: authenticatedHeaders(pairingCode, { origin: "http://localhost:3000" }),
  }));
  assert.deepEqual((await queueResponse.json()).items, []);
});

test("desktop assistant isolates a corrupt state file without blocking the app", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-corrupt-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "assistant-state.json"), "{not-json", "utf8");

  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });
  const files = await readdir(dataDir);
  assert.equal(files.includes("assistant-state.json"), false);
  assert.equal(files.some((name) => name.startsWith("assistant-state.json.corrupt-")), true);

  const paired = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders(),
    body: JSON.stringify({ pairingCode: "replacement-pairing-code" }),
  }));
  assert.equal(paired.status, 200);
});

test("desktop assistant bridge limits CORS to the app and browser extensions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-cors-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
  });

  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "chrome-extension://abcdefghijklmnop",
    "safari-web-extension://com.example.our-choice",
  ]) {
    const response = await bridge.handle(request("/__our_choice/assistant/enqueue", {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    }));
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(
      response.headers.get("access-control-allow-headers") ?? "",
      /x-our-choice-native-bootstrap/,
    );
  }

  const denied = await bridge.handle(request("/__our_choice/assistant/enqueue", {
    method: "OPTIONS",
    headers: { origin: "https://example.com" },
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.has("access-control-allow-origin"), false);
});

test("desktop pairing normalizes an explicit HTTP port 80 product origin", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-default-port-origin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { createAssistantBridge } = await import("../macos/runtime/assistant-bridge.mjs");

  await assert.rejects(
    createAssistantBridge({ dataDir }),
    /bootstrapSecret/,
  );
  const bridge = await createAssistantBridge({
    dataDir,
    bootstrapSecret: NATIVE_BOOTSTRAP_SECRET,
    productOrigins: ["http://localhost:80", "http://127.0.0.1:80"],
  });
  const paired = await bridge.handle(request("/__our_choice/assistant/pair", {
    method: "POST",
    headers: nativePairHeaders("http://localhost"),
    body: JSON.stringify({ pairingCode: "default-port-pairing" }),
  }));

  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), { ok: true, paired: true });
});

test("packaged desktop server proxies the existing Vinext build on loopback", {
  skip: process.env.OUR_CHOICE_NETWORK_TEST !== "1",
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "our-choice-runtime-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const linkedProjectRoot = join(dataDir, "project-link");
  await symlink(projectRoot, linkedProjectRoot, "dir");

  const child = spawn(process.execPath, [join(linkedProjectRoot, "macos", "runtime", "server.mjs")], {
    cwd: linkedProjectRoot,
    env: {
      ...process.env,
      OUR_CHOICE_DATA_DIR: dataDir,
      OUR_CHOICE_PORT: "0",
      OUR_CHOICE_APP_VERSION: "9.8.7-test",
      OUR_CHOICE_WEB_ROOT: linkedProjectRoot,
      OUR_CHOICE_VINEXT_ROOT: join(linkedProjectRoot, "node_modules", "vinext", "dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  const ready = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`desktop server timed out\n${stderr}`)), 10_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("OUR_CHOICE_READY ")) continue;
        clearTimeout(timeout);
        resolve(JSON.parse(line.slice("OUR_CHOICE_READY ".length)));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`desktop server exited with ${code}\n${stderr}`));
    });
  });

  assert.equal(ready.host, "127.0.0.1");
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  const health = await fetch(`${ready.url}/__our_choice/desktop/health`).then((response) => response.json());
  assert.equal(health.product, "our-choice-desktop");
  assert.equal(health.version, "9.8.7-test");

  const page = await fetch(ready.url).then((response) => response.text());
  assert.match(page, /<title>自选｜只看你主动选择的内容<\/title>/);
});

test("macOS App smoke command exercises only its embedded production runtime", async () => {
  const source = await readFile(
    new URL("../scripts/smoke-macos-runtime.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /Contents["'],\s*["']Resources["'],\s*["']runtime/);
  assert.match(source, /OUR_CHOICE_READY/);
  assert.match(source, /spawn\(/);
  assert.match(source, /__our_choice\/desktop\/health/);
  assert.match(source, /api\/source-preview/);
  assert.match(source, /<title>自选｜只看你主动选择的内容<\\\/title>/);
  assert.match(source, /SIGTERM/);
  assert.match(source, /forced: false/);
  assert.match(source, /code: 0/);
  assert.match(source, /signal: null/);
});
