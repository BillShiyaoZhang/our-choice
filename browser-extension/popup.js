"use strict";

let inspection = null;
let activeTabId = null;
let followScanState = null;

const elements = Object.fromEntries(
  [
    "open-settings", "settings", "app-url", "pairing-code", "save-settings",
    "page-site", "page-title", "selection-note", "save-later", "save-collection",
    "subscribe", "bilibili-scan", "scan-count", "begin-scan", "scan-page",
    "finish-scan", "auto-scan", "status", "open-app", "export-queue",
  ].map((id) => [id, document.getElementById(id)]),
);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function status(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

async function inspectCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有找到当前标签页。");
  activeTabId = tab.id;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["shared.js", "content-script.js"],
  });
  return chrome.tabs.sendMessage(tab.id, { type: "OUR_CHOICE_INSPECT_PAGE" });
}

function renderInspection(result) {
  inspection = result?.ok ? result : null;
  if (!inspection) {
    elements["page-site"].textContent = "当前页面不可用";
    elements["page-title"].textContent = result?.error || "无法读取这个页面";
    status(result?.error || "浏览器内部页面不能被收藏。", true);
    return;
  }
  elements["page-site"].textContent = inspection.page.siteName || new URL(inspection.page.url).hostname;
  elements["page-title"].textContent = inspection.page.title;
  elements["selection-note"].hidden = !inspection.page.selection;
  elements["save-later"].disabled = false;
  elements["save-collection"].disabled = false;
  elements.subscribe.disabled = !inspection.sourceCandidates?.length;
  elements["bilibili-scan"].hidden = !inspection.isBilibili;
}

async function enqueueClip(destination) {
  if (!inspection) return;
  const result = await send({
    type: "OUR_CHOICE_ENQUEUE",
    item: { kind: "clip", page: inspection.page, destination },
  });
  status(result.ok ? "已发送到自选，正在打开确认页面。" : result.error, !result.ok);
}

async function enqueueSource() {
  const candidate = inspection?.sourceCandidates?.[0];
  if (!candidate) return;
  const result = await send({ type: "OUR_CHOICE_ENQUEUE", item: { kind: "source", candidate } });
  status(result.ok ? "来源已发送到自选，请确认订阅。" : result.error, !result.ok);
}

async function renderScanState() {
  const result = await send({ type: "OUR_CHOICE_GET_FOLLOW_SCAN" });
  followScanState = result.ok ? result : null;
  const active = Boolean(result.ok && result.active);
  const autoRunning = Boolean(result.ok && result.auto?.running);
  elements["scan-count"].textContent = autoRunning
    ? `自动扫描 ${result.auto.pagesScanned}${result.auto.totalPages ? ` / ${result.auto.totalPages}` : ""} 页 · ${result.count} 个`
    : active
      ? `本轮已收集 ${result.count} 个`
      : `上次 ${result.previousCount || 0} 个`;
  elements["scan-page"].disabled = !active || autoRunning;
  elements["finish-scan"].disabled = !active || result.count === 0 || autoRunning;
  elements["begin-scan"].disabled = autoRunning;
  elements["begin-scan"].textContent = active ? "重新开始" : "开始新一轮";
  elements["auto-scan"].disabled = !inspection?.isBilibiliFollowPage;
  elements["auto-scan"].textContent = autoRunning ? "取消自动扫描" : "自动扫描全部关注";
  if (result.auto?.error) status(result.auto.error, true);
}

async function scanCurrentPage() {
  if (!activeTabId) return;
  const scan = await chrome.tabs.sendMessage(activeTabId, { type: "OUR_CHOICE_SCAN_BILIBILI" });
  if (!scan?.ok) return status(scan?.error || "扫描失败。", true);
  const merged = await send({ type: "OUR_CHOICE_MERGE_FOLLOW_SCAN", candidates: scan.candidates });
  status(
    merged.ok ? `本页找到 ${scan.candidates.length} 个，本轮新增 ${merged.addedOnPage} 个。` : merged.error,
    !merged.ok,
  );
  await renderScanState();
}

elements["open-settings"].addEventListener("click", () => {
  elements.settings.hidden = !elements.settings.hidden;
});
elements["save-settings"].addEventListener("click", async () => {
  const result = await send({
    type: "OUR_CHOICE_SAVE_CONFIG",
    config: { appUrl: elements["app-url"].value, pairingCode: elements["pairing-code"].value },
  });
  status(result.ok ? "连接设置已保存。" : result.error, !result.ok);
});
elements["save-later"].addEventListener("click", () => void enqueueClip("later"));
elements["save-collection"].addEventListener("click", () => void enqueueClip("collection"));
elements.subscribe.addEventListener("click", () => void enqueueSource());
elements["begin-scan"].addEventListener("click", async () => {
  const result = await send({ type: "OUR_CHOICE_BEGIN_FOLLOW_SCAN" });
  status(result.ok ? "新一轮扫描已开始。请滚动或切换关注分页后扫描本页。" : result.error, !result.ok);
  await renderScanState();
});
elements["scan-page"].addEventListener("click", () => void scanCurrentPage());
elements["auto-scan"].addEventListener("click", async () => {
  if (!activeTabId || !inspection?.isBilibiliFollowPage) {
    return status("请先打开 B站个人空间里的“全部关注”页面。", true);
  }
  if (followScanState?.auto?.running) {
    await send({ type: "OUR_CHOICE_CANCEL_AUTO_FOLLOW_SCAN" });
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: "OUR_CHOICE_CANCEL_AUTO_SCAN_BILIBILI" });
    } catch {
      // The page may be between two same-origin navigations.
    }
    status("正在取消；已经扫描的账号仍会保留。");
    return renderScanState();
  }
  const started = await send({ type: "OUR_CHOICE_BEGIN_AUTO_FOLLOW_SCAN", tabId: activeTabId });
  if (!started.ok) return status(started.error, true);
  status("自动扫描已开始；可以关闭弹窗并在页面查看进度。");
  await renderScanState();
  chrome.tabs.sendMessage(activeTabId, { type: "OUR_CHOICE_AUTO_SCAN_BILIBILI" }).catch(async (error) => {
    await send({
      type: "OUR_CHOICE_REPORT_AUTO_FOLLOW_SCAN",
      tabId: activeTabId,
      running: false,
      error: error instanceof Error ? error.message : "无法启动自动扫描。",
    });
  });
});
elements["finish-scan"].addEventListener("click", async () => {
  const result = await send({ type: "OUR_CHOICE_FINISH_FOLLOW_SCAN" });
  status(
    result.ok
      ? `已发送 ${result.count} 个关注；请在自选网页中确认导入。`
      : result.error,
    !result.ok,
  );
  await renderScanState();
});
elements["open-app"].addEventListener("click", () => void send({ type: "OUR_CHOICE_OPEN_APP" }));
elements["export-queue"].addEventListener("click", async () => {
  const result = await send({ type: "OUR_CHOICE_EXPORT_QUEUE" });
  if (!result.ok) return status(result.error, true);
  const blob = new Blob([JSON.stringify({ version: 1, items: result.items }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `our-choice-assistant-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  status("待处理队列已导出；配对码未包含在文件中。");
});

async function initialize() {
  const saved = await send({ type: "OUR_CHOICE_GET_CONFIG" });
  if (saved.ok) {
    elements["app-url"].value = saved.config.appUrl;
    elements["pairing-code"].value = saved.config.pairingCode;
    elements.settings.hidden = Boolean(saved.config.pairingCode);
  }
  try {
    renderInspection(await inspectCurrentPage());
  } catch (error) {
    renderInspection({ ok: false, error: error instanceof Error ? error.message : "无法读取当前页面。" });
  }
  await renderScanState();
}

void initialize();
