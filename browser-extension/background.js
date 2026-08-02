"use strict";

importScripts("shared.js");

const QUEUE_KEY = "ourChoiceQueueV1";
const CONFIG_KEY = "ourChoiceConfigV1";
const FOLLOW_KEY = "ourChoiceBilibiliFollowV1";
const DEFAULT_CONFIG = { appUrl: "http://localhost:3000", pairingCode: "", appTabId: null };
const APP_HANDOFF_HASH = "#browser-assistant";
const MAX_AUTO_SCAN_PAGES = 200;

function emptyFollowState() {
  return { active: false, current: [], previous: [], auto: null };
}

async function stored(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

async function save(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function validConfig(value) {
  const normalized = OurChoiceExtension.normalizeHttpUrl(value?.appUrl || DEFAULT_CONFIG.appUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (
    url.protocol !== "http:" ||
    url.port !== "3000" ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) return null;
  return {
    appUrl: url.origin,
    pairingCode: OurChoiceExtension.cleanText(value?.pairingCode, 160),
    appTabId: Number.isInteger(value?.appTabId) ? value.appTabId : null,
  };
}

async function config() {
  return validConfig(await stored(CONFIG_KEY, DEFAULT_CONFIG)) ?? DEFAULT_CONFIG;
}

async function openApp(handoff = false) {
  const current = await config();
  const targetUrl = handoff ? `${current.appUrl}/${APP_HANDOFF_HASH}` : current.appUrl;
  if (current.appTabId) {
    try {
      const tab = await chrome.tabs.update(current.appTabId, { active: true, url: targetUrl });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return tab;
    } catch {
      // The remembered tab may have been closed.
    }
  }
  const tab = await chrome.tabs.create({ url: targetUrl });
  await save(CONFIG_KEY, { ...current, appTabId: tab.id ?? null });
  return tab;
}

async function enqueue(item) {
  const queue = await stored(QUEUE_KEY, []);
  const next = {
    ...item,
    id: item.id || newId("assistant"),
    capturedAt: item.capturedAt || new Date().toISOString(),
  };
  await save(QUEUE_KEY, [...queue, next].slice(-500));
  return next;
}

async function authenticated(message) {
  const current = await config();
  return Boolean(current.pairingCode && message?.pairingCode === current.pairingCode);
}

async function requirePairing() {
  const current = await config();
  return current.pairingCode
    ? null
    : { ok: false, error: "请先在连接设置中填写并保存配对码。" };
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
    case "OUR_CHOICE_GET_CONFIG":
      return { ok: true, config: await config() };
    case "OUR_CHOICE_SAVE_CONFIG": {
      const current = await config();
      const next = validConfig({ ...current, ...message.config });
      if (!next) return { ok: false, error: "本地应用地址必须是 localhost:3000。" };
      await save(CONFIG_KEY, next);
      return { ok: true, config: next };
    }
    case "OUR_CHOICE_ENQUEUE": {
      const pairingError = await requirePairing();
      if (pairingError) return pairingError;
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
      const queued = await enqueue(item);
      await openApp(true);
      return { ok: true, item: queued };
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
      const pairingError = await requirePairing();
      if (pairingError) return pairingError;
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
      const pairingError = await requirePairing();
      if (pairingError) return pairingError;
      const state = await stored(FOLLOW_KEY, emptyFollowState());
      const current = OurChoiceExtension.dedupeBilibiliCandidates(state.current);
      if (!state.active || !current.length) return { ok: false, error: "本轮还没有扫描到任何 UP 主。" };
      const differences = OurChoiceExtension.diffFollowSnapshot(state.previous, current);
      const queued = await enqueue({
        kind: "follow-batch",
        platform: "bilibili",
        candidates: current,
        added: differences.added,
        removed: differences.removed,
        previousCount: state.previous?.length ?? 0,
      });
      await save(FOLLOW_KEY, { active: false, current: [], previous: current, auto: null });
      await openApp(true);
      return { ok: true, item: queued, count: current.length, added: differences.added.length, removed: differences.removed.length };
    }
    case "OUR_CHOICE_PULL_QUEUE": {
      if (!(await authenticated(message))) return { ok: false, error: "配对码不匹配，请在自选设置中重新配对。" };
      return { ok: true, items: await stored(QUEUE_KEY, []) };
    }
    case "OUR_CHOICE_ACK_QUEUE": {
      if (!(await authenticated(message))) return { ok: false, error: "配对码不匹配。" };
      const ids = new Set(Array.isArray(message.ids) ? message.ids : []);
      const queue = await stored(QUEUE_KEY, []);
      await save(QUEUE_KEY, queue.filter((item) => !ids.has(item.id)));
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js", "content-script.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "OUR_CHOICE_AUTO_SCAN_BILIBILI" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "关注页重新加载后无法继续扫描。";
    await save(FOLLOW_KEY, {
      ...state,
      auto: { ...state.auto, running: false, error: message },
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败。" });
  });
  return true;
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void resumeAutoScan(tabId);
});
