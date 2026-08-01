"use strict";

importScripts("shared.cjs");

const QUEUE_KEY = "ourChoiceQueueV1";
const CONFIG_KEY = "ourChoiceConfigV1";
const FOLLOW_KEY = "ourChoiceBilibiliFollowV1";
const DEFAULT_CONFIG = { appUrl: "http://localhost:3000", pairingCode: "", appTabId: null };

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

async function openApp() {
  const current = await config();
  if (current.appTabId) {
    try {
      const tab = await chrome.tabs.update(current.appTabId, { active: true, url: current.appUrl });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
      return tab;
    } catch {
      // The remembered tab may have been closed.
    }
  }
  const tab = await chrome.tabs.create({ url: current.appUrl });
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

async function handleMessage(message) {
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
              },
            }
          : null;
      if (!item || (item.kind === "source" && !item.candidate.url)) {
        return { ok: false, error: "没有找到可安全发送的页面数据。" };
      }
      const queued = await enqueue(item);
      await openApp();
      return { ok: true, item: queued };
    }
    case "OUR_CHOICE_BEGIN_FOLLOW_SCAN":
      await save(FOLLOW_KEY, {
        active: true,
        current: [],
        previous: (await stored(FOLLOW_KEY, {})).previous ?? [],
      });
      return { ok: true, count: 0 };
    case "OUR_CHOICE_GET_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, { active: false, current: [], previous: [] });
      return { ok: true, active: Boolean(state.active), count: state.current?.length ?? 0, previousCount: state.previous?.length ?? 0 };
    }
    case "OUR_CHOICE_MERGE_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, { active: false, current: [], previous: [] });
      if (!state.active) return { ok: false, error: "请先开始一轮关注扫描。" };
      const before = OurChoiceExtension.dedupeBilibiliCandidates(state.current);
      const merged = OurChoiceExtension.dedupeBilibiliCandidates([
        ...before,
        ...(Array.isArray(message.candidates) ? message.candidates : []),
      ]);
      await save(FOLLOW_KEY, { ...state, current: merged });
      return { ok: true, count: merged.length, addedOnPage: merged.length - before.length };
    }
    case "OUR_CHOICE_FINISH_FOLLOW_SCAN": {
      const state = await stored(FOLLOW_KEY, { active: false, current: [], previous: [] });
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
      await save(FOLLOW_KEY, { active: false, current: [], previous: current });
      await openApp();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败。" });
  });
  return true;
});
