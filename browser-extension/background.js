"use strict";

importScripts("extension-api.js", "shared.js");

const extensionApi = OurChoiceExtension.browserApi(globalThis);
const QUEUE_KEY = "ourChoiceQueueV1";
const CONFIG_KEY = "ourChoiceConfigV1";
const FOLLOW_KEY = "ourChoiceBilibiliFollowV1";
const DEFAULT_CONFIG = { appUrl: "http://localhost:3000", pairingCode: "", appTabId: null };
const APP_HANDOFF_HASH = "#browser-assistant";
const DESKTOP_HEALTH_PATH = "/__our_choice/desktop/health";
const EXTENSION_SESSION_REQUEST_HEADER = "x-our-choice-extension-session";
const DESKTOP_ENQUEUE_PATH = "/__our_choice/assistant/enqueue";
const DESKTOP_REQUEST_TIMEOUT_MS = 1_200;
const DESKTOP_DISCOVERY_TIMEOUT_MS = 450;
const DESKTOP_DISCOVERY_FIRST_PORT = 3000;
const DESKTOP_DISCOVERY_LAST_PORT = 3031;
const MAX_AUTO_SCAN_PAGES = 200;
const MAX_FOLLOW_BATCH_CANDIDATES = 500;
let queueTransactionTail = Promise.resolve();
let configTransactionTail = Promise.resolve();

function emptyFollowState() {
  return { active: false, current: [], previous: [], auto: null };
}

async function stored(key, fallback) {
  const result = await extensionApi.storage.local.get(key);
  return result[key] ?? fallback;
}

async function save(key, value) {
  await extensionApi.storage.local.set({ [key]: value });
  return value;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function withQueueTransaction(operation) {
  const result = queueTransactionTail.then(operation, operation);
  queueTransactionTail = result.catch(() => undefined);
  return result;
}

function withConfigTransaction(operation) {
  const result = configTransactionTail.then(operation, operation);
  configTransactionTail = result.catch(() => undefined);
  return result;
}

function validConfig(value) {
  const candidate = typeof value?.appUrl === "string"
    ? value.appUrl.trim()
    : DEFAULT_CONFIG.appUrl;
  const match = candidate.match(
    /^http:\/\/(localhost|127\.0\.0\.1):([0-9]{1,5})\/?$/i,
  );
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const extensionSession = typeof value?.extensionSession === "string" &&
    /^[A-Za-z0-9_-]{32,1024}$/.test(value.extensionSession)
    ? value.extensionSession
    : "";
  return {
    appUrl: `http://${match[1].toLowerCase()}:${port}`,
    pairingCode: OurChoiceExtension.cleanText(value?.pairingCode, 160),
    ...(extensionSession ? { extensionSession } : {}),
    appTabId: Number.isInteger(value?.appTabId) ? value.appTabId : null,
  };
}

async function config() {
  return validConfig(await stored(CONFIG_KEY, DEFAULT_CONFIG)) ?? DEFAULT_CONFIG;
}

async function healthyDesktopOrigin(appUrl) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), DESKTOP_DISCOVERY_TIMEOUT_MS)
    : null;
  try {
    const response = await globalThis.fetch(`${appUrl}${DESKTOP_HEALTH_PATH}`, {
      method: "GET",
      headers: { [EXTENSION_SESSION_REQUEST_HEADER]: "request" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.product !== "our-choice-desktop") return null;
    const extensionSession = typeof payload.extensionSession === "string" &&
      /^[A-Za-z0-9_-]{32,1024}$/.test(payload.extensionSession)
      ? payload.extensionSession
      : "";
    return { appUrl, extensionSession };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function discoverDesktop(currentValue) {
  const current = currentValue ?? await config();
  if (typeof globalThis.fetch !== "function") return current;

  const remembered = await healthyDesktopOrigin(current.appUrl);
  let discovered = remembered;
  if (!discovered) {
    const candidates = Array.from(
      { length: DESKTOP_DISCOVERY_LAST_PORT - DESKTOP_DISCOVERY_FIRST_PORT + 1 },
      (_, index) => `http://127.0.0.1:${DESKTOP_DISCOVERY_FIRST_PORT + index}`,
    );
    const results = await Promise.all(candidates.map(healthyDesktopOrigin));
    discovered = results.find(Boolean) ?? null;
  }
  if (!discovered) return current;
  if (
    discovered.appUrl === current.appUrl &&
    discovered.extensionSession === (current.extensionSession ?? "")
  ) return current;

  return withConfigTransaction(async () => {
    const latest = await config();
    if (latest.appUrl !== current.appUrl) return latest;
    const next = { ...latest, appUrl: discovered.appUrl };
    if (discovered.extensionSession) next.extensionSession = discovered.extensionSession;
    else delete next.extensionSession;
    await save(CONFIG_KEY, next);
    return next;
  });
}

async function openApp(handoff = false) {
  await discoverDesktop(await config());
  return withConfigTransaction(async () => {
    const current = await config();
    const targetUrl = handoff ? `${current.appUrl}/${APP_HANDOFF_HASH}` : current.appUrl;
    if (Number.isInteger(current.appTabId)) {
      try {
        const remembered = await extensionApi.tabs.get(current.appTabId);
        const rememberedUrl = remembered?.url ?? remembered?.pendingUrl;
        const rememberedOrigin = rememberedUrl ? new URL(rememberedUrl).origin : null;
        const configuredOrigin = new URL(current.appUrl).origin;
        if (rememberedOrigin === configuredOrigin) {
          const tab = await extensionApi.tabs.update(current.appTabId, {
            active: true,
            url: targetUrl,
          });
          if (Number.isInteger(tab.windowId)) {
            await extensionApi.windows.update(tab.windowId, { focused: true });
          }
          return tab;
        }
      } catch {
        // A closed, inaccessible, or navigated-away tab is never overwritten.
      }
    }
    const tab = await extensionApi.tabs.create({ url: targetUrl });
    await save(CONFIG_KEY, {
      ...current,
      appTabId: Number.isInteger(tab.id) ? tab.id : null,
    });
    return tab;
  });
}

function queuedItem(item) {
  return {
    ...item,
    id: item.id || newId("assistant"),
    capturedAt: item.capturedAt || new Date().toISOString(),
  };
}

async function enqueueLocally(item) {
  return withQueueTransaction(async () => {
    const queue = await stored(QUEUE_KEY, []);
    const withoutDuplicate = queue.filter((queued) => queued?.id !== item.id);
    if (withoutDuplicate.length >= 500) {
      throw new Error("本地待处理队列已满，请先打开自选处理或导出队列。");
    }
    await save(QUEUE_KEY, [...withoutDuplicate, item]);
    return item;
  });
}

async function removeQueuedItems(ids) {
  return withQueueTransaction(async () => {
    const queue = await stored(QUEUE_KEY, []);
    const remaining = queue.filter((item) => !ids.has(item?.id));
    await save(QUEUE_KEY, remaining);
    return remaining;
  });
}

function desktopFailure(error, available = false) {
  return {
    ok: false,
    available,
    error: OurChoiceExtension.cleanText(error, 300) || "桌面应用暂时不可用。",
  };
}

function desktopResponseError(payload, status) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  return `桌面端点返回 HTTP ${status}。`;
}

async function deliverToDesktopOnce(item, current) {
  const authorization = current.extensionSession || current.pairingCode;
  if (!authorization) return desktopFailure("尚未建立本地连接。");
  if (typeof globalThis.fetch !== "function") return desktopFailure("当前浏览器不支持桌面投递。");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), DESKTOP_REQUEST_TIMEOUT_MS)
    : null;
  try {
    const response = await globalThis.fetch(`${current.appUrl}${DESKTOP_ENQUEUE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ item }),
      cache: "no-store",
      credentials: "omit",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      const detail = desktopResponseError(payload, response.status);
      return { ...desktopFailure(detail, response.status !== 404), status: response.status };
    }
    return { ok: true, available: true, config: current };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "无法连接桌面应用。";
    return desktopFailure(detail);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function deliverToDesktop(item, currentValue) {
  const current = currentValue ?? await config();
  const initial = await deliverToDesktopOnce(item, current);
  if (initial.ok) return initial;
  const shouldDiscover = !initial.available || initial.status === 404 ||
    (initial.status === 401 && Boolean(current.extensionSession));
  if (!shouldDiscover) return initial;

  const discovered = await discoverDesktop(current);
  if (
    discovered.appUrl === current.appUrl &&
    (discovered.extensionSession ?? "") === (current.extensionSession ?? "")
  ) return initial;
  return { ...await deliverToDesktopOnce(item, discovered), config: discovered };
}

async function flushLocalQueue(currentValue) {
  let current = currentValue ?? await config();
  const queue = await withQueueTransaction(() => stored(QUEUE_KEY, []));
  const summary = {
    attempted: 0,
    delivered: 0,
    remaining: queue.length,
    desktopAvailable: null,
  };
  if (!queue.length) return summary;
  if (!current.extensionSession && !current.pairingCode) {
    current = await discoverDesktop(current);
  }
  if (!current.extensionSession && !current.pairingCode) return summary;

  const deliveredIds = new Set();
  for (const item of queue) {
    summary.attempted += 1;
    const result = await deliverToDesktop(item, current);
    if (result.config) current = result.config;
    summary.desktopAvailable = result.available;
    if (!result.ok) {
      summary.error = result.error;
      break;
    }
    deliveredIds.add(item.id);
    summary.delivered += 1;
  }
  if (deliveredIds.size) {
    const remaining = await removeQueuedItems(deliveredIds);
    summary.remaining = remaining.length;
  } else {
    summary.remaining = (await withQueueTransaction(() => stored(QUEUE_KEY, []))).length;
  }
  return summary;
}

async function dispatchQueuedItem(item, current) {
  const next = queuedItem(item);
  const desktop = await deliverToDesktop(next, current);
  if (desktop.ok) {
    return {
      item: next,
      delivery: "desktop",
      transport: "desktop",
      queuedLocally: false,
      desktop,
    };
  }
  await enqueueLocally(next);
  return {
    item: next,
    delivery: "local",
    transport: "local",
    queuedLocally: true,
    desktop,
  };
}

async function authenticated(message) {
  const current = await config();
  return Boolean(current.pairingCode && message?.pairingCode === current.pairingCode);
}

async function requireConnection(currentValue) {
  const current = currentValue ?? await config();
  return current.extensionSession || current.pairingCode
    ? null
    : { ok: false, error: "请先打开 Mac 应用自动连接，或在高级设置中配置网页模式配对码。" };
}

function senderTabId(message, sender) {
  return Number.isInteger(message?.tabId)
    ? message.tabId
    : Number.isInteger(sender?.tab?.id)
      ? sender.tab.id
      : null;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "OUR_CHOICE_GET_CONFIG": {
      const current = await discoverDesktop(await config());
      return { ok: true, config: current, flush: await flushLocalQueue(current) };
    }
    case "OUR_CHOICE_SAVE_CONFIG": {
      const next = await withConfigTransaction(async () => {
        const current = await config();
        const candidate = validConfig({ ...current, ...message.config });
        if (!candidate) return null;
        await save(CONFIG_KEY, candidate);
        return candidate;
      });
      if (!next) return {
        ok: false,
        error: "本地应用地址必须是带明确端口的 localhost 或 127.0.0.1。",
      };
      return { ok: true, config: next, flush: await flushLocalQueue(next) };
    }
    case "OUR_CHOICE_ENQUEUE": {
      let current = await config();
      if (!current.extensionSession && !current.pairingCode) {
        current = await discoverDesktop(current);
      }
      const connectionError = await requireConnection(current);
      if (connectionError) return connectionError;
      const capture = message.item?.kind === "clip"
        ? OurChoiceExtension.sanitizeCapture(message.item.page)
        : null;
      const item = message.item?.kind === "clip"
        ? capture && { kind: "clip", page: capture, destination: message.item.destination === "collection" ? "collection" : "later" }
        : message.item?.kind === "source"
          ? {
              kind: "source",
              candidate: {
                url: OurChoiceExtension.normalizeHttpUrl(message.item.candidate?.url),
                name: OurChoiceExtension.cleanText(message.item.candidate?.name, 120),
                externalId: OurChoiceExtension.cleanText(message.item.candidate?.externalId, 80) || undefined,
                imageUrl: OurChoiceExtension.normalizeHttpUrl(message.item.candidate?.imageUrl) || undefined,
              },
            }
          : null;
      if (!item || (item.kind === "source" && !item.candidate.url)) {
        return { ok: false, error: "没有找到可安全发送的页面数据。" };
      }
      const flush = await flushLocalQueue(current);
      const delivery = await dispatchQueuedItem(item, current);
      if (delivery.queuedLocally) await openApp(true);
      return { ok: true, ...delivery, flush };
    }
    case "OUR_CHOICE_BEGIN_FOLLOW_SCAN":
      await save(FOLLOW_KEY, {
        active: true,
        current: [],
        previous: (await stored(FOLLOW_KEY, {})).previous ?? [],
        auto: null,
      });
      return { ok: true, count: 0 };
    case "OUR_CHOICE_BEGIN_AUTO_FOLLOW_SCAN": {
      let current = await config();
      if (!current.extensionSession && !current.pairingCode) {
        current = await discoverDesktop(current);
      }
      const connectionError = await requireConnection(current);
      if (connectionError) return connectionError;
      if (!Number.isInteger(message.tabId)) return { ok: false, error: "没有找到要扫描的关注页。" };
      const previous = (await stored(FOLLOW_KEY, emptyFollowState())).previous ?? [];
      const auto = {
        running: true,
        tabId: message.tabId,
        pagesScanned: 0,
        totalPages: null,
        seenSignatures: [],
        error: "",
      };
      await save(FOLLOW_KEY, { active: true, current: [], previous, auto });
      return { ok: true, count: 0, auto };
    }
    case "OUR_CHOICE_GET_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      return {
        ok: true,
        active: Boolean(state.active),
        count: state.current?.length ?? 0,
        previousCount: state.previous?.length ?? 0,
        auto: state.auto ?? null,
      };
    }
    case "OUR_CHOICE_MERGE_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      if (!state.active) return { ok: false, error: "请先开始一轮关注扫描。" };
      const before = OurChoiceExtension.dedupeBilibiliCandidates(state.current);
      const merged = OurChoiceExtension.dedupeBilibiliCandidates([
        ...before,
        ...(Array.isArray(message.candidates) ? message.candidates : []),
      ]);
      await save(FOLLOW_KEY, { ...state, current: merged });
      return { ok: true, count: merged.length, addedOnPage: merged.length - before.length };
    }
    case "OUR_CHOICE_RECORD_AUTO_FOLLOW_PAGE": {
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      const auto = state.auto;
      const tabId = senderTabId(message, sender);
      if (!state.active || !auto?.running || auto.tabId !== tabId) {
        return { ok: false, error: "自动扫描已经停止。" };
      }
      const signature = OurChoiceExtension.cleanText(message.signature, 4_000);
      if (!signature) return { ok: false, error: "当前页没有可识别的关注账号。" };
      const seenSignatures = Array.isArray(auto.seenSignatures) ? auto.seenSignatures : [];
      if (seenSignatures.includes(signature)) {
        return { ok: true, duplicatePage: true, count: state.current?.length ?? 0, auto };
      }
      if (seenSignatures.length >= MAX_AUTO_SCAN_PAGES) {
        const stopped = { ...auto, running: false, error: "已达到 200 页安全上限。" };
        await save(FOLLOW_KEY, { ...state, auto: stopped });
        return { ok: false, error: stopped.error };
      }
      const before = OurChoiceExtension.dedupeBilibiliCandidates(state.current);
      const merged = OurChoiceExtension.dedupeBilibiliCandidates([
        ...before,
        ...(Array.isArray(message.candidates) ? message.candidates : []),
      ]);
      const totalPages = Number.isInteger(message.totalPages)
        ? Math.min(MAX_AUTO_SCAN_PAGES, Math.max(1, message.totalPages))
        : auto.totalPages;
      const nextAuto = {
        ...auto,
        pagesScanned: seenSignatures.length + 1,
        totalPages,
        seenSignatures: [...seenSignatures, signature],
        error: "",
      };
      await save(FOLLOW_KEY, { ...state, current: merged, auto: nextAuto });
      return {
        ok: true,
        duplicatePage: false,
        count: merged.length,
        addedOnPage: merged.length - before.length,
        auto: nextAuto,
      };
    }
    case "OUR_CHOICE_REPORT_AUTO_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      const tabId = senderTabId(message, sender);
      if (!state.auto || state.auto.tabId !== tabId) {
        return { ok: false, error: "没有对应的自动扫描。" };
      }
      const nextAuto = {
        ...state.auto,
        running: message.running !== false,
        error: OurChoiceExtension.cleanText(message.error, 300),
      };
      await save(FOLLOW_KEY, { ...state, auto: nextAuto });
      return { ok: true, auto: nextAuto, count: state.current?.length ?? 0 };
    }
    case "OUR_CHOICE_CANCEL_AUTO_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      if (!state.auto) return { ok: true, count: state.current?.length ?? 0 };
      const nextAuto = { ...state.auto, running: false, error: "已由用户取消，已扫描结果仍保留。" };
      await save(FOLLOW_KEY, { ...state, auto: nextAuto });
      return { ok: true, count: state.current?.length ?? 0, auto: nextAuto };
    }
    case "OUR_CHOICE_FINISH_FOLLOW_SCAN": {
      let currentConfig = await config();
      if (!currentConfig.extensionSession && !currentConfig.pairingCode) {
        currentConfig = await discoverDesktop(currentConfig);
      }
      const connectionError = await requireConnection(currentConfig);
      if (connectionError) return connectionError;
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      const current = OurChoiceExtension.dedupeBilibiliCandidates(state.current);
      if (!state.active || !current.length) return { ok: false, error: "本轮还没有扫描到任何 UP 主。" };
      if (current.length > MAX_FOLLOW_BATCH_CANDIDATES) {
        return {
          ok: false,
          error: `单次最多发送 ${MAX_FOLLOW_BATCH_CANDIDATES} 个关注账号；本轮扫描结果已保留，请分批处理。`,
        };
      }
      const differences = OurChoiceExtension.diffFollowSnapshot(state.previous, current);
      const flush = await flushLocalQueue(currentConfig);
      const delivery = await dispatchQueuedItem({
        kind: "follow-batch",
        platform: "bilibili",
        candidates: current,
        added: differences.added,
        removed: differences.removed,
        previousCount: state.previous?.length ?? 0,
      }, currentConfig);
      await save(FOLLOW_KEY, { active: false, current: [], previous: current, auto: null });
      if (delivery.queuedLocally) await openApp(true);
      return {
        ok: true,
        ...delivery,
        flush,
        count: current.length,
        added: differences.added.length,
        removed: differences.removed.length,
      };
    }
    case "OUR_CHOICE_PULL_QUEUE": {
      if (!(await authenticated(message))) return { ok: false, error: "配对码不匹配，请在自选设置中重新配对。" };
      return { ok: true, items: await stored(QUEUE_KEY, []) };
    }
    case "OUR_CHOICE_ACK_QUEUE": {
      if (!(await authenticated(message))) return { ok: false, error: "配对码不匹配。" };
      const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
      await removeQueuedItems(ids);
      return { ok: true };
    }
    case "OUR_CHOICE_EXPORT_QUEUE":
      return { ok: true, items: await stored(QUEUE_KEY, []) };
    case "OUR_CHOICE_OPEN_APP":
      await openApp();
      return { ok: true };
    default:
      return { ok: false, error: "不支持的操作。" };
  }
}

async function resumeAutoScan(tabId) {
  const state = await stored(FOLLOW_KEY, emptyFollowState());
  if (!state.active || !state.auto?.running || state.auto.tabId !== tabId) return;
  try {
    await extensionApi.scripting.executeScript({
      target: { tabId },
      files: ["extension-api.js", "shared.js", "content-script.js"],
    });
    await extensionApi.tabs.sendMessage(tabId, { type: "OUR_CHOICE_AUTO_SCAN_BILIBILI" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "关注页重新加载后无法继续扫描。";
    await save(FOLLOW_KEY, {
      ...state,
      auto: { ...state.auto, running: false, error: message },
    });
  }
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败。" });
  });
  return true;
});

extensionApi.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void resumeAutoScan(tabId);
});
