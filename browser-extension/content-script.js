(function installOurChoicePageInspector() {
  "use strict";
  if (globalThis.__ourChoicePageInspectorInstalled) return;
  globalThis.__ourChoicePageInspectorInstalled = true;

  const helpers = globalThis.OurChoiceExtension;

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

  function bilibiliCandidates() {
    const values = [];
    for (const anchor of document.querySelectorAll('a[href*="space.bilibili.com/"]')) {
      const url = anchor.href;
      const profile = helpers.canonicalBilibiliProfile(url);
      if (!profile) continue;
      values.push({
        externalId: profile.slice(profile.lastIndexOf("/") + 1),
        name:
          helpers.cleanText(anchor.getAttribute("title"), 120) ||
          helpers.cleanText(anchor.getAttribute("aria-label"), 120) ||
          helpers.cleanText(anchor.textContent, 120),
        url: profile,
      });
    }
    return helpers.dedupeBilibiliCandidates(values);
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
    return false;
  });
})();
