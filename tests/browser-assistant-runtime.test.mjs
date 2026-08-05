import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";

import {
  fullyProcessedAssistantQueueIds,
  nativeDesktopAuthorizationHeaders,
  persistAppDataThenAcknowledge,
  registerNativeDesktopPairing,
  requestExtensionAssistantResponse,
} from "../app/lib/browser-assistant-runtime.ts";

class FakeWindow {
  constructor() {
    this.location = { origin: "http://localhost:3000" };
    this.listeners = new Set();
    this.messages = [];
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  postMessage(message, targetOrigin) {
    this.messages.push({ message, targetOrigin });
  }

  emit(data, { origin = this.location.origin, source = this } = {}) {
    for (const listener of this.listeners) listener({ data, origin, source });
  }
}

test("extension fallback ACK waits for the matching response and reports its real result", async () => {
  const targetWindow = new FakeWindow();
  let timeoutCallback;
  let cancelledHandle;
  const pending = requestExtensionAssistantResponse({
    targetWindow,
    request: {
      source: "our-choice-app",
      type: "OUR_CHOICE_ACK_QUEUE",
      requestId: "assistant-ack-1",
      pairingCode: "paired",
      ids: ["clip-1"],
    },
    responseType: "OUR_CHOICE_ACK_RESPONSE",
    scheduleTimeout(callback, delay) {
      assert.equal(delay, 1_800);
      timeoutCallback = callback;
      return 17;
    },
    cancelTimeout(handle) { cancelledHandle = handle; },
  });

  assert.deepEqual(targetWindow.messages, [{
    message: {
      source: "our-choice-app",
      type: "OUR_CHOICE_ACK_QUEUE",
      requestId: "assistant-ack-1",
      pairingCode: "paired",
      ids: ["clip-1"],
    },
    targetOrigin: "http://localhost:3000",
  }]);

  targetWindow.emit({
    source: "our-choice-extension",
    type: "OUR_CHOICE_ACK_RESPONSE",
    requestId: "wrong-request",
    response: { ok: true },
  });
  assert.equal(targetWindow.listeners.size, 1);

  targetWindow.emit({
    source: "our-choice-extension",
    type: "OUR_CHOICE_ACK_RESPONSE",
    requestId: "assistant-ack-1",
    response: { ok: false, error: "extension storage failed" },
  });
  assert.deepEqual(await pending, { ok: false, error: "extension storage failed" });
  assert.equal(targetWindow.listeners.size, 0);
  assert.equal(typeof timeoutCallback, "function");
  assert.equal(cancelledHandle, 17);
});

test("extension fallback ACK times out without accepting unrelated messages", async () => {
  const targetWindow = new FakeWindow();
  let timeoutCallback;
  const pending = requestExtensionAssistantResponse({
    targetWindow,
    request: {
      source: "our-choice-app",
      type: "OUR_CHOICE_ACK_QUEUE",
      requestId: "assistant-ack-timeout",
    },
    responseType: "OUR_CHOICE_ACK_RESPONSE",
    timeoutMilliseconds: 1_800,
    scheduleTimeout(callback) {
      timeoutCallback = callback;
      return 18;
    },
    cancelTimeout() {},
  });

  targetWindow.emit({
    source: "our-choice-extension",
    type: "OUR_CHOICE_ACK_RESPONSE",
    requestId: "assistant-ack-timeout",
    response: { ok: true },
  }, { origin: "https://attacker.example" });
  timeoutCallback();
  assert.deepEqual(await pending, {
    ok: false,
    error: "浏览器扩展没有确认队列删除，请稍后重试。",
  });
  assert.equal(targetWindow.listeners.size, 0);
});

test("queue ACK eligibility requires every work item in an extension queue group", () => {
  const groups = [
    { id: "checked-clip", requiredKeys: ["clip:checked-clip"] },
    { id: "unchecked-clip", requiredKeys: ["clip:unchecked-clip"] },
    { id: "selected-source", requiredKeys: ["selected-source:https://example.com/a"] },
    { id: "unchecked-source", requiredKeys: ["unchecked-source:https://example.com/b"] },
    {
      id: "partial-follow-batch",
      requiredKeys: [
        "partial-follow-batch:https://space.bilibili.com/1",
        "partial-follow-batch:https://space.bilibili.com/2",
      ],
    },
    {
      id: "complete-follow-batch",
      requiredKeys: [
        "complete-follow-batch:https://space.bilibili.com/3",
        "complete-follow-batch:https://space.bilibili.com/4",
      ],
    },
  ];
  const completed = new Set([
    "clip:checked-clip",
    "selected-source:https://example.com/a",
    "partial-follow-batch:https://space.bilibili.com/1",
    "complete-follow-batch:https://space.bilibili.com/3",
    "complete-follow-batch:https://space.bilibili.com/4",
  ]);

  assert.deepEqual(
    fullyProcessedAssistantQueueIds(groups, completed),
    ["checked-clip", "selected-source", "complete-follow-batch"],
  );
});

test("AppData persistence completes synchronously before ACK and storage failure prevents ACK", async () => {
  const order = [];
  const result = await persistAppDataThenAcknowledge({
    storage: {
      setItem(key, value) {
        order.push(["persist", key, JSON.parse(value).version]);
      },
    },
    storageKey: "our-choice:state:v1",
    nextData: { version: 2 },
    onPersisted() { order.push(["state"]); },
    async acknowledge() {
      order.push(["ack"]);
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(order, [
    ["persist", "our-choice:state:v1", 2],
    ["state"],
    ["ack"],
  ]);

  let acknowledged = false;
  await assert.rejects(
    persistAppDataThenAcknowledge({
      storage: { setItem() { throw new DOMException("quota", "QuotaExceededError"); } },
      storageKey: "our-choice:state:v1",
      nextData: { version: 2 },
      onPersisted() { assert.fail("state must not change when persistence fails"); },
      async acknowledge() {
        acknowledged = true;
        return { ok: true };
      },
    }),
    /quota/,
  );
  assert.equal(acknowledged, false);
});

test("native pairing requires the WKWebView bootstrap secret and sends it only in a header", async () => {
  let browserFetches = 0;
  assert.equal(await registerNativeDesktopPairing({
    targetWindow: {},
    pairingCode: "stale-browser-pairing",
    async fetchImpl() {
      browserFetches += 1;
      return new Response(null, { status: 200 });
    },
  }), false);
  assert.equal(browserFetches, 0);

  const requests = [];
  const bootstrapSecret = "native-bootstrap-secret-with-at-least-32-bytes";
  assert.equal(await registerNativeDesktopPairing({
    targetWindow: { __OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__: bootstrapSecret },
    pairingCode: "fresh-native-pairing",
    async fetchImpl(url, init) {
      requests.push({ url, init });
      return Response.json({ ok: true });
    },
  }), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/__our_choice/assistant/pair");
  assert.equal(requests[0].init.headers["x-our-choice-native-bootstrap"], bootstrapSecret);
  assert.equal(requests[0].init.body, JSON.stringify({ pairingCode: "fresh-native-pairing" }));
  assert.equal(requests[0].init.body.includes(bootstrapSecret), false);
});

test("native queue authorization uses the WKWebView bootstrap without a pairing code", () => {
  assert.deepEqual(nativeDesktopAuthorizationHeaders({}, "manual-pairing"), {
    authorization: "Bearer manual-pairing",
  });

  const bootstrapSecret = "native-bootstrap-secret-with-at-least-32-bytes";
  assert.deepEqual(nativeDesktopAuthorizationHeaders({
    __OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__: bootstrapSecret,
  }, ""), {
    "x-our-choice-native-bootstrap": bootstrapSecret,
  });
  assert.deepEqual(nativeDesktopAuthorizationHeaders({
    __OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__: bootstrapSecret,
  }, "legacy-pairing"), {
    "x-our-choice-native-bootstrap": bootstrapSecret,
  });
});

test("app bridge returns the extension runtime's real ACK result", async () => {
  const posted = [];
  const sent = [];
  let messageListener;
  const targetWindow = {
    location: { origin: "http://localhost:3000" },
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  const context = {
    window: targetWindow,
    OurChoiceBrowser: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve({ ok: false, error: "extension storage failed" });
        },
      },
    },
  };
  context.globalThis = context;
  new Script(await readFile(
    new URL("../browser-extension/app-bridge.js", import.meta.url),
    "utf8",
  )).runInNewContext(context);

  messageListener({
    source: targetWindow,
    origin: targetWindow.location.origin,
    data: {
      source: "our-choice-app",
      type: "OUR_CHOICE_ACK_QUEUE",
      requestId: "ack-real-result",
      pairingCode: "paired",
      ids: ["clip-1"],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    type: "OUR_CHOICE_ACK_QUEUE",
    pairingCode: "paired",
    ids: ["clip-1"],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
    message: {
      source: "our-choice-extension",
      type: "OUR_CHOICE_ACK_RESPONSE",
      requestId: "ack-real-result",
      response: { ok: false, error: "extension storage failed" },
    },
    targetOrigin: "http://localhost:3000",
  });

  context.OurChoiceBrowser.runtime.sendMessage = () => {
    throw new Error("extension context was invalidated");
  };
  assert.doesNotThrow(() => messageListener({
    source: targetWindow,
    origin: targetWindow.location.origin,
    data: {
      source: "our-choice-app",
      type: "OUR_CHOICE_ACK_QUEUE",
      requestId: "ack-runtime-throw",
      pairingCode: "paired",
      ids: ["clip-2"],
    },
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1).message)), {
    source: "our-choice-extension",
    type: "OUR_CHOICE_ACK_RESPONSE",
    requestId: "ack-runtime-throw",
    response: { ok: false, error: "extension context was invalidated" },
  });
});
