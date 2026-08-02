(function attachOurChoiceHelpers(root) {
  "use strict";

  function cleanText(value, limit) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalizeHttpUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.hash = "";
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
      return url.href;
    } catch {
      return null;
    }
  }

  function canonicalBilibiliProfile(value) {
    const normalized = normalizeHttpUrl(value);
    if (!normalized) return null;
    const url = new URL(normalized);
    if (url.hostname !== "space.bilibili.com") return null;
    const match = url.pathname.match(/^\/(\d+)(?:\/|$)/);
    return match ? `https://space.bilibili.com/${match[1]}` : null;
  }

  function dedupeBilibiliCandidates(values) {
    const byId = new Map();
    for (const value of Array.isArray(values) ? values : []) {
      const url = canonicalBilibiliProfile(value && value.url);
      if (!url) continue;
      const externalId = url.slice(url.lastIndexOf("/") + 1);
      if (value && String(value.externalId || externalId) !== externalId) continue;
      const fallbackName = `B站 UP 主 ${externalId}`;
      const name = cleanText(value && value.name, 120) || fallbackName;
      const imageUrl = normalizeHttpUrl(value && value.imageUrl);
      const existing = byId.get(externalId);
      if (existing) {
        if (existing.name === fallbackName && name !== fallbackName) existing.name = name;
        if (!existing.imageUrl && imageUrl) existing.imageUrl = imageUrl;
        continue;
      }
      const candidate = {
        externalId,
        name,
        url,
      };
      if (imageUrl) candidate.imageUrl = imageUrl;
      byId.set(externalId, candidate);
    }
    return [...byId.values()].sort((left, right) =>
      left.externalId.localeCompare(right.externalId, "en", { numeric: true }),
    );
  }

  function diffFollowSnapshot(previous, current) {
    const before = dedupeBilibiliCandidates(previous);
    const after = dedupeBilibiliCandidates(current);
    const previousIds = new Set(before.map((item) => item.externalId));
    const currentIds = new Set(after.map((item) => item.externalId));
    return {
      added: after.filter((item) => !previousIds.has(item.externalId)),
      removed: before.filter((item) => !currentIds.has(item.externalId)),
      unchanged: after.filter((item) => previousIds.has(item.externalId)),
    };
  }

  function sanitizeCapture(value) {
    if (!value || typeof value !== "object") return null;
    const url = normalizeHttpUrl(value.url);
    if (!url) return null;
    const imageUrl = normalizeHttpUrl(value.imageUrl);
    const contentType = ["article", "video", "podcast"].includes(value.contentType)
      ? value.contentType
      : "article";
    const result = {
      url,
      title: cleanText(value.title, 240) || new URL(url).hostname,
      description: cleanText(value.description, 800),
      selection: cleanText(value.selection, 2000),
      siteName: cleanText(value.siteName, 120),
      contentType,
    };
    if (imageUrl) result.imageUrl = imageUrl;
    for (const key of ["description", "selection", "siteName"]) {
      if (!result[key]) delete result[key];
    }
    return result;
  }

  const api = {
    cleanText,
    normalizeHttpUrl,
    canonicalBilibiliProfile,
    dedupeBilibiliCandidates,
    diffFollowSnapshot,
    sanitizeCapture,
  };

  root.OurChoiceExtension = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
