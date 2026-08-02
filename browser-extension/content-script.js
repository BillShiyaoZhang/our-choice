(function installOurChoicePageInspector() {
  "use strict";
  if (globalThis.__ourChoicePageInspectorInstalled) return;
  globalThis.__ourChoicePageInspectorInstalled = true;

  const helpers = globalThis.OurChoiceExtension;
  const MAX_AUTO_SCAN_PAGES = 200;
  const AUTO_SCAN_PAGE_TIMEOUT_MS = 15_000;
  const AUTO_SCAN_OVERLAY_ID = "our-choice-auto-scan";
  let autoScanRunning = false;
  let autoScanCancelled = false;

  function meta(names) {
    for (const name of names) {
      const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const value = element?.getAttribute("content");
      if (value?.trim()) return value.trim();
    }
    return "";
  }

  function selectedText() {
    try {
      return window.getSelection()?.toString() ?? "";
    } catch {
      return "";
    }
  }

  function contentType(url) {
    const pathname = new URL(url).pathname.toLowerCase();
    if (
      document.querySelector("video") ||
      /(?:bilibili\.com\/video|youtube\.com\/watch|youtu\.be\/|vimeo\.com\/)/i.test(url)
    ) return "video";
    if (document.querySelector("audio") || /(?:podcast|episode|xiaoyuzhoufm|ximalaya)/i.test(pathname)) {
      return "podcast";
    }
    return "article";
  }

  function feedLinks(baseUrl) {
    const found = [];
    for (const link of document.querySelectorAll('link[rel~="alternate"][href]')) {
      const type = (link.getAttribute("type") || "").toLowerCase();
      if (!/(?:rss|atom|xml)/.test(type)) continue;
      const url = helpers.normalizeHttpUrl(new URL(link.getAttribute("href"), baseUrl).href);
      if (!url || found.some((item) => item.url === url)) continue;
      found.push({
        url,
        title: helpers.cleanText(link.getAttribute("title"), 120) || "页面订阅源",
        type,
      });
    }
    return found.slice(0, 12);
  }

  function profileContainer(anchor, profile) {
    let best = anchor;
    let current = anchor.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const profiles = new Set(
        [...current.querySelectorAll('a[href*="space.bilibili.com/"]')]
          .map((item) => helpers.canonicalBilibiliProfile(item.href))
          .filter(Boolean),
      );
      if (profiles.size > 1 || (profiles.size === 1 && !profiles.has(profile))) break;
      best = current;
    }
    return best;
  }

  function usefulBilibiliName(value, externalId) {
    const name = helpers.cleanText(value, 120);
    if (!name || name === externalId || name === `B站 UP 主 ${externalId}`) return "";
    if (/^(?:关注|已关注|取消关注|私信|更多|访问主页)$/.test(name)) return "";
    if (/^https?:\/\//i.test(name)) return "";
    return name;
  }

  function candidateName(anchor, container, externalId) {
    const values = [];
    for (const item of container.querySelectorAll('a[href*="space.bilibili.com/"]')) {
      if (helpers.canonicalBilibiliProfile(item.href)?.endsWith(`/${externalId}`)) {
        values.push(item.getAttribute("title"), item.getAttribute("aria-label"), item.textContent);
      }
    }
    for (const image of container.querySelectorAll("img")) {
      values.push(image.getAttribute("alt"), image.getAttribute("title"));
    }
    values.push(anchor.getAttribute("title"), anchor.getAttribute("aria-label"), anchor.textContent);
    return values.map((value) => usefulBilibiliName(value, externalId)).find(Boolean) || "";
  }

  function candidateImage(container) {
    for (const image of container.querySelectorAll("img")) {
      const raw = image.currentSrc || image.src || image.getAttribute("data-src") || image.getAttribute("data-lazy-src");
      if (!raw) continue;
      try {
        const normalized = helpers.normalizeHttpUrl(new URL(raw, location.href).href);
        if (normalized) return normalized;
      } catch {
        // Ignore malformed lazy-image attributes.
      }
    }
    return null;
  }

  function bilibiliCandidates() {
    const values = [];
    for (const anchor of document.querySelectorAll('a[href*="space.bilibili.com/"]')) {
      const url = anchor.href;
      const profile = helpers.canonicalBilibiliProfile(url);
      if (!profile) continue;
      const externalId = profile.slice(profile.lastIndexOf("/") + 1);
      const container = profileContainer(anchor, profile);
      values.push({
        externalId,
        name: candidateName(anchor, container, externalId),
        url: profile,
        imageUrl: candidateImage(container),
      });
    }
    return helpers.dedupeBilibiliCandidates(values);
  }

  function isBilibiliFollowPage() {
    return location.hostname === "space.bilibili.com" && /\/\d+\/relation\/follow(?:\/|$)/.test(location.pathname);
  }

  function pageSignature(candidates) {
    return candidates.map((candidate) => candidate.externalId).sort().join(",");
  }

  function paginationRoot() {
    const selectors = [
      ".be-pager",
      '[class*="pagination"]',
      '[class*="pagenation"]',
      '[class*="pager"]',
      '[role="navigation"][aria-label*="页"]',
    ];
    return selectors.map((selector) => document.querySelector(selector)).find(Boolean) || null;
  }

  function controlText(element) {
    return helpers.cleanText([
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" "), 80).toLowerCase();
  }

  function disabledControl(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      /(?:^|[-_\s])disabled(?:$|[-_\s])/.test(String(element.className).toLowerCase()),
    );
  }

  function pageInfo() {
    const root = paginationRoot();
    if (!root) return { current: 1, total: 1, first: null, next: null };
    const controls = [...root.querySelectorAll("button, a, [role=button]")];
    const numeric = controls
      .map((element) => Number(helpers.cleanText(element.textContent, 8)))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= MAX_AUTO_SCAN_PAGES);
    const active =
      root.querySelector(
        '[aria-current="page"], .be-pager-item-active, [class*="page"][class*="active"], [class*="page"][class*="current"]',
      ) ||
      controls.find((element) =>
        /(?:active|current|selected)/i.test(String(element.className)),
      );
    const url = new URL(location.href);
    const current =
      Number(helpers.cleanText(active?.textContent, 8)) ||
      Number(url.searchParams.get("page") || url.searchParams.get("pn")) ||
      1;
    const total = numeric.length ? Math.max(...numeric) : current;
    const first = controls.find((element) => helpers.cleanText(element.textContent, 8) === "1") || null;
    const next =
      root.querySelector(".be-pager-next, [aria-label*='下一'], [title*='下一']") ||
      controls.find((element) => /(?:下一页|下一|next|›|»)/i.test(controlText(element))) ||
      null;
    return {
      current,
      total,
      first: first && !disabledControl(first) ? first : null,
      next: next && !disabledControl(next) ? next : null,
    };
  }

  function sleep(delay) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function waitForCandidates() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < AUTO_SCAN_PAGE_TIMEOUT_MS) {
      if (autoScanCancelled) throw new Error("扫描已取消，已收集结果仍会保留。");
      const candidates = bilibiliCandidates();
      if (candidates.length) return candidates;
      await sleep(250);
    }
    throw new Error("15 秒内没有找到关注账号；请确认已登录并打开“全部关注”页面。");
  }

  async function waitForPageChange(previousSignature) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < AUTO_SCAN_PAGE_TIMEOUT_MS) {
      if (autoScanCancelled) throw new Error("扫描已取消，已收集结果仍会保留。");
      const candidates = bilibiliCandidates();
      if (candidates.length && pageSignature(candidates) !== previousSignature) return candidates;
      await sleep(250);
    }
    throw new Error("翻页后 15 秒内内容没有更新；已停止以避免重复扫描。");
  }

  function scanOverlay() {
    let host = document.getElementById(AUTO_SCAN_OVERLAY_ID);
    if (host) return host;
    host = document.createElement("aside");
    host.id = AUTO_SCAN_OVERLAY_ID;
    host.style.cssText = "position:fixed;right:20px;top:20px;z-index:2147483647;width:280px;padding:16px;border:1px solid #cbdcd2;border-radius:14px;background:#fff;color:#22312b;box-shadow:0 12px 40px rgba(20,40,30,.22);font:13px/1.5 system-ui,sans-serif";
    const title = document.createElement("strong");
    title.textContent = "自选 · B站关注扫描";
    const detail = document.createElement("p");
    detail.dataset.role = "detail";
    detail.style.cssText = "margin:8px 0;color:#526b60";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消扫描";
    cancel.style.cssText = "border:1px solid #d6d5ce;border-radius:8px;padding:7px 10px;background:#fff;color:#26342e;cursor:pointer";
    cancel.addEventListener("click", () => {
      autoScanCancelled = true;
      void chrome.runtime.sendMessage({ type: "OUR_CHOICE_CANCEL_AUTO_FOLLOW_SCAN" });
      updateOverlay("正在取消；已扫描结果会保留。", true);
    });
    host.append(title, detail, cancel);
    document.documentElement.append(host);
    return host;
  }

  function updateOverlay(message, stopped = false) {
    const host = scanOverlay();
    const detail = host.querySelector('[data-role="detail"]');
    if (detail) detail.textContent = message;
    const button = host.querySelector("button");
    if (button) button.hidden = stopped;
  }

  async function stopAutoScan(error) {
    const message = error instanceof Error ? error.message : "自动扫描失败。";
    autoScanRunning = false;
    await chrome.runtime.sendMessage({
      type: "OUR_CHOICE_REPORT_AUTO_FOLLOW_SCAN",
      running: false,
      error: message,
    });
    updateOverlay(message, true);
    return { ok: false, error: message };
  }

  async function autoScanBilibili() {
    if (autoScanRunning) return { ok: true, running: true };
    if (!isBilibiliFollowPage()) {
      return stopAutoScan(new Error("请先打开 B站个人空间里的“全部关注”页面。"));
    }
    autoScanRunning = true;
    autoScanCancelled = false;
    updateOverlay("正在读取当前页…");
    try {
      const initialCandidates = await waitForCandidates();
      const initialInfo = pageInfo();
      if (initialInfo.current > 1 && initialInfo.first) {
        updateOverlay("正在返回第 1 页，以便扫描全部关注…");
        initialInfo.first.click();
        await waitForPageChange(pageSignature(initialCandidates));
      }
      for (let step = 0; step < MAX_AUTO_SCAN_PAGES; step += 1) {
        if (autoScanCancelled) throw new Error("扫描已取消，已收集结果仍会保留。");
        const candidates = await waitForCandidates();
        const signature = pageSignature(candidates);
        const info = pageInfo();
        const recorded = await chrome.runtime.sendMessage({
          type: "OUR_CHOICE_RECORD_AUTO_FOLLOW_PAGE",
          page: info.current,
          totalPages: info.total,
          signature,
          candidates,
        });
        if (!recorded?.ok) throw new Error(recorded?.error || "无法保存当前页扫描结果。");
        if (recorded.duplicatePage) throw new Error("检测到重复页面，已停止以避免循环翻页。");
        updateOverlay(`已扫描 ${recorded.auto.pagesScanned}${recorded.auto.totalPages ? ` / ${recorded.auto.totalPages}` : ""} 页，累计 ${recorded.count} 个账号。`);
        if (!info.next) {
          const finished = await chrome.runtime.sendMessage({ type: "OUR_CHOICE_FINISH_FOLLOW_SCAN" });
          if (!finished?.ok) throw new Error(finished?.error || "扫描完成，但发送到自选失败。");
          autoScanRunning = false;
          updateOverlay(`扫描完成：共 ${finished.count} 个账号，正在打开自选确认页。`, true);
          return finished;
        }
        info.next.click();
        await waitForPageChange(signature);
      }
      throw new Error("已达到 200 页安全上限，已扫描结果仍会保留。");
    } catch (error) {
      return stopAutoScan(error);
    }
  }

  function inspectPage() {
    const currentUrl = helpers.normalizeHttpUrl(location.href);
    if (!currentUrl) return { ok: false, error: "当前页面不是可保存的公开网页。" };
    const canonicalElement = document.querySelector('link[rel="canonical"][href]');
    const canonicalUrl = helpers.normalizeHttpUrl(canonicalElement?.href || currentUrl) || currentUrl;
    const pageCapture = helpers.sanitizeCapture({
      url: canonicalUrl,
      title: meta(["og:title", "twitter:title"]) || document.title,
      description: meta(["description", "og:description", "twitter:description"]),
      imageUrl: meta(["og:image", "twitter:image"]),
      siteName: meta(["og:site_name", "application-name"]) || location.hostname,
      selection: selectedText(),
      contentType: contentType(canonicalUrl),
    });
    if (!pageCapture) return { ok: false, error: "没有找到可安全保存的页面地址。" };

    const declaredFeeds = feedLinks(canonicalUrl);
    const currentProfile = helpers.canonicalBilibiliProfile(canonicalUrl);
    const pageBilibiliCandidates = bilibiliCandidates();
    const sourceCandidates = declaredFeeds.length
      ? declaredFeeds.map((item) => ({ url: item.url, name: item.title, kind: "feed" }))
      : currentProfile
        ? [{ url: currentProfile, name: pageCapture.title, kind: "creator" }]
        : [{ url: canonicalUrl, name: pageCapture.siteName || pageCapture.title, kind: "page" }];

    return {
      ok: true,
      page: pageCapture,
      sourceCandidates,
      bilibiliCandidates: pageBilibiliCandidates,
      isBilibili: /(^|\.)bilibili\.com$/i.test(location.hostname),
      isBilibiliFollowPage: isBilibiliFollowPage(),
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OUR_CHOICE_INSPECT_PAGE") {
      sendResponse(inspectPage());
      return false;
    }
    if (message?.type === "OUR_CHOICE_SCAN_BILIBILI") {
      sendResponse({ ok: true, candidates: bilibiliCandidates() });
      return false;
    }
    if (message?.type === "OUR_CHOICE_AUTO_SCAN_BILIBILI") {
      void autoScanBilibili().then(sendResponse);
      return true;
    }
    if (message?.type === "OUR_CHOICE_CANCEL_AUTO_SCAN_BILIBILI") {
      autoScanCancelled = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
