import { parse as parseDomain } from "tldts";

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 7_000;
const RSSHUB_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const TRACKING_QUERY_KEYS = new Set([
  "from",
  "share_medium",
  "share_plat",
  "share_session_id",
  "share_source",
  "share_tag",
  "spm",
  "spm_id_from",
  "timestamp",
  "unique_k",
]);

const SHORT_LINK_TARGETS: Record<string, string[]> = {
  "b23.tv": ["bilibili.com"],
  "xhslink.com": ["xiaohongshu.com"],
  "v.douyin.com": ["douyin.com", "iesdouyin.com"],
};

type PreviewErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_FORMAT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_HTTP"
  | "FEED_TOO_LARGE"
  | "PARSE_FAILED"
  | "SOURCE_MISMATCH"
  | "INVALID_SELECTION"
  | "RSSHUB_NOT_CONFIGURED";

class PreviewError extends Error {
  constructor(
    public code: PreviewErrorCode,
    message: string,
    public retryable = false,
    public status = 400,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function parsePublicUrl(raw: string, base?: string) {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new PreviewError("INVALID_URL", "请输入完整、有效的网址。", false, 400);
  }

  const hostname = url.hostname.toLowerCase();
  const isPrivateIpv6 =
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:");

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6
  ) {
    throw new PreviewError(
      "INVALID_URL",
      "只支持公开的 HTTP 或 HTTPS 内容源。",
      false,
      400,
    );
  }

  if (url.port && !["80", "443"].includes(url.port)) {
    throw new PreviewError("INVALID_URL", "这个网址使用了不支持的端口。", false, 400);
  }

  return url;
}

function inputUrl(raw: string) {
  const trimmed = raw.trim();
  try {
    return parsePublicUrl(trimmed);
  } catch (directError) {
    const matches = trimmed.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
    if (matches.length !== 1) throw directError;
    const extracted = matches[0]!.replace(/[),.;!?，。；！？）】》]+$/u, "");
    return parsePublicUrl(extracted);
  }
}

function normalizePublicUrl(url: URL) {
  const normalized = new URL(url);
  if (normalized.pathname.length > 1) {
    normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  }
  for (const key of [...normalized.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_QUERY_KEYS.has(key)) {
      normalized.searchParams.delete(key);
    }
  }
  return normalized;
}

async function resolveAllowedShortLink(initialUrl: URL) {
  const allowedTargets = SHORT_LINK_TARGETS[initialUrl.hostname];
  if (!allowedTargets) return initialUrl;

  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: { "User-Agent": "OurChoice/1.0 (+short-link resolver)" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return initialUrl;
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      return currentUrl;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirectCount === MAX_REDIRECTS) return initialUrl;

    const redirected = parsePublicUrl(location, currentUrl.href);
    if (
      !allowedTargets.some((hostname) =>
        redirected.hostname === hostname || redirected.hostname.endsWith(`.${hostname}`),
      )
    ) {
      return initialUrl;
    }
    currentUrl = redirected;
    if (!SHORT_LINK_TARGETS[currentUrl.hostname]) return currentUrl;
  }
  return initialUrl;
}

async function fetchWithLimits(initialUrl: URL) {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.2",
          "User-Agent": "OurChoice/1.0 (+local feed reader)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new PreviewError(
          "UPSTREAM_TIMEOUT",
          "这个来源响应得有些慢，请稍后重试。",
          true,
          504,
        );
      }
      throw new PreviewError(
        "UPSTREAM_HTTP",
        "暂时无法连接这个来源，请检查网络后重试。",
        true,
        502,
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new PreviewError(
          "UPSTREAM_HTTP",
          "这个来源经过了太多次跳转。",
          false,
          502,
        );
      }
      currentUrl = parsePublicUrl(location, currentUrl.href);
      continue;
    }

    if (!response.ok) {
      throw new PreviewError(
        "UPSTREAM_HTTP",
        `来源返回了 ${response.status}，旧内容不会受影响。`,
        response.status >= 500,
        502,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new PreviewError(
        "FEED_TOO_LARGE",
        "这个订阅源体积过大，暂时无法读取。",
        false,
        413,
      );
    }

    const body = await readLimitedBody(response);
    return {
      body,
      url: currentUrl,
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  throw new PreviewError("UPSTREAM_HTTP", "无法读取这个来源。", true, 502);
}

async function readLimitedBody(response: Response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PreviewError(
        "FEED_TOO_LARGE",
        "这个订阅源体积过大，暂时无法读取。",
        false,
        413,
      );
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function decodeXml(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    nbsp: " ",
  };

  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name] ?? entity);
}

function plainText(value: string, maxLength = 360) {
  const text = decodeXml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagValue(fragment: string, ...tagNames: string[]) {
  for (const tagName of tagNames) {
    const pattern = new RegExp(
      `<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`,
      "i",
    );
    const match = fragment.match(pattern);
    if (match?.[1]) return decodeXml(match[1]).trim();
  }
  return "";
}

function attributeValue(fragment: string, attribute: string) {
  const pattern = new RegExp(
    `${escapeRegExp(attribute)}\\s*=\\s*["']([^"']+)["']`,
    "i",
  );
  return decodeXml(fragment.match(pattern)?.[1] ?? "").trim();
}

function safeOutputUrl(raw: string, base: string) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, base);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function atomLink(fragment: string) {
  const tags = fragment.match(/<link\b[^>]*>/gi) ?? [];
  const preferred =
    tags.find((tag) => {
      const rel = attributeValue(tag, "rel");
      return !rel || rel === "alternate";
    }) ?? tags[0];
  return preferred ? attributeValue(preferred, "href") : "";
}

function extractImage(fragment: string, baseUrl: string) {
  const candidates = [
    ...(fragment.match(/<media:thumbnail\b[^>]*>/gi) ?? []),
    ...(fragment.match(/<itunes:image\b[^>]*>/gi) ?? []),
    ...(fragment.match(/<media:content\b[^>]*>/gi) ?? []).filter((tag) =>
      /medium\s*=\s*["']image|type\s*=\s*["']image\//i.test(tag),
    ),
    ...(fragment.match(/<enclosure\b[^>]*>/gi) ?? []).filter((tag) =>
      /type\s*=\s*["']image\//i.test(tag),
    ),
  ];

  for (const tag of candidates) {
    const raw = attributeValue(tag, "url") || attributeValue(tag, "href");
    const safe = safeOutputUrl(raw, baseUrl);
    if (safe) return safe;
  }

  const description = tagValue(
    fragment,
    "content:encoded",
    "description",
    "summary",
    "content",
  );
  const imageTag = description.match(/<img\b[^>]*>/i)?.[0];
  return imageTag
    ? safeOutputUrl(attributeValue(imageTag, "src"), baseUrl)
    : undefined;
}

function parseFeed(xml: string, feedUrl: string, limit: number) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new PreviewError(
      "PARSE_FAILED",
      "这个订阅源包含不支持的 XML 声明。",
      false,
      422,
    );
  }

  const rssEntries = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  const atomEntries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? [];
  const entries = rssEntries.length ? rssEntries : atomEntries;
  const isAtom = !rssEntries.length && atomEntries.length > 0;

  if (!entries.length || (!/<rss\b/i.test(xml) && !/<feed\b/i.test(xml))) {
    throw new PreviewError(
      "UNSUPPORTED_FORMAT",
      "这个地址不是可识别的 RSS 或 Atom 订阅源。",
      false,
      422,
    );
  }

  const header = xml.slice(0, Math.max(0, xml.indexOf(entries[0]!)));
  const title = plainText(tagValue(header, "title"), 120) || "未命名订阅";
  const description = plainText(
    tagValue(header, "description", "subtitle"),
    240,
  );
  const siteLinkRaw = isAtom ? atomLink(header) : tagValue(header, "link");
  const siteUrl = safeOutputUrl(siteLinkRaw, feedUrl);
  const feedImage = extractImage(header, feedUrl);

  const items = entries.slice(0, limit).flatMap((entry, index) => {
    const itemTitle = plainText(tagValue(entry, "title"), 180);
    const linkRaw = isAtom ? atomLink(entry) : tagValue(entry, "link");
    const link = safeOutputUrl(linkRaw, siteUrl ?? feedUrl);
    if (!itemTitle || !link) return [];

    const enclosureTag = entry.match(/<enclosure\b[^>]*>/i)?.[0] ?? "";
    const enclosureType = attributeValue(enclosureTag, "type");
    const enclosureUrl = safeOutputUrl(
      attributeValue(enclosureTag, "url"),
      feedUrl,
    );
    const lowerLink = link.toLowerCase();
    const type = enclosureType.startsWith("audio/")
      ? "podcast"
      : enclosureType.startsWith("video/") ||
          lowerLink.includes("youtube.com") ||
          lowerLink.includes("youtu.be") ||
          lowerLink.includes("bilibili.com/video")
        ? "video"
        : "article";

    const summary = plainText(
      tagValue(entry, "content:encoded", "description", "summary", "content"),
      360,
    );
    const publishedAt = tagValue(
      entry,
      "pubDate",
      "published",
      "updated",
      "dc:date",
    );
    const duration = plainText(tagValue(entry, "itunes:duration"), 32);
    const upstreamId =
      plainText(tagValue(entry, "guid", "id"), 240) || link || String(index);

    return [
      {
        upstreamId,
        title: itemTitle,
        url: link,
        summary,
        type,
        thumbnailUrl: extractImage(entry, feedUrl),
        enclosureUrl,
        publishedAt: publishedAt || new Date().toISOString(),
        publishedAtReliable: Boolean(publishedAt),
        duration:
          duration || (type === "article" ? "阅读" : type === "podcast" ? "收听" : "观看"),
      },
    ];
  });

  return {
    source: {
      kind: "rss" as const,
      title,
      description,
      feedUrl,
      siteUrl,
      imageUrl: feedImage,
    },
    items,
  };
}

function discoverFeedUrl(html: string, pageUrl: string) {
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = attributeValue(tag, "rel").toLowerCase();
    const type = attributeValue(tag, "type").toLowerCase();
    if (
      rel.split(/\s+/).includes("alternate") &&
      ["application/rss+xml", "application/atom+xml"].includes(
        type,
      )
    ) {
      const href = attributeValue(tag, "href");
      if (href) return parsePublicUrl(href, pageUrl);
    }
  }
  return null;
}

const LINK_PLATFORMS = [
  {
    kind: "bilibili",
    label: "B 站",
    hostnames: ["bilibili.com", "b23.tv"],
    description: "B站公开页面",
  },
  {
    kind: "wechat",
    label: "微信公众号",
    hostnames: ["mp.weixin.qq.com"],
    description: "微信公众号文章",
  },
  {
    kind: "zhihu",
    label: "知乎",
    hostnames: ["zhihu.com"],
    description: "知乎创作者或内容页面",
  },
  {
    kind: "xiaohongshu",
    label: "小红书",
    hostnames: ["xiaohongshu.com", "xhslink.com"],
    description: "小红书创作者或内容页面",
  },
  {
    kind: "douyin",
    label: "抖音",
    hostnames: ["douyin.com", "iesdouyin.com"],
    description: "抖音创作者或内容页面",
  },
  {
    kind: "kuaishou",
    label: "快手",
    hostnames: ["kuaishou.com", "gifshow.com"],
    description: "快手创作者或内容页面",
  },
  {
    kind: "weibo",
    label: "微博",
    hostnames: ["weibo.com", "weibo.cn"],
    description: "微博用户或内容页面",
  },
  {
    kind: "xiaoyuzhou",
    label: "小宇宙",
    hostnames: ["xiaoyuzhoufm.com"],
    description: "小宇宙播客或单集页面",
  },
  {
    kind: "toutiao",
    label: "今日头条",
    hostnames: ["toutiao.com"],
    description: "今日头条创作者或内容页面",
  },
  {
    kind: "baijiahao",
    label: "百家号",
    hostnames: ["baijiahao.baidu.com"],
    description: "百家号创作者或内容页面",
  },
  {
    kind: "douban",
    label: "豆瓣",
    hostnames: ["douban.com"],
    description: "豆瓣用户或内容页面",
  },
  {
    kind: "ximalaya",
    label: "喜马拉雅",
    hostnames: ["ximalaya.com"],
    description: "喜马拉雅主播、专辑或单集页面",
  },
] as const;

type LinkPlatform = (typeof LINK_PLATFORMS)[number];

interface RssHubConfig {
  baseUrl: URL;
  accessKey?: string;
}

interface RadarRule {
  title?: string;
  docs?: string;
  source: string[];
  target: string;
}

interface RadarMatch {
  id: string;
  route: string;
  title?: string;
  docs?: string;
  score: number;
}

interface PreviewOption {
  id: string;
  title: string;
  description: string;
  docsUrl?: string;
}

interface RssHubSelectionDescriptor {
  id: string;
  title: string;
  docsUrl?: string;
}

type ManualSubscription =
  | { kind: "wechat-uread"; userid: string }
  | { kind: "wechat-mp"; biz: string; hid: string; cid?: string }
  | { kind: "wechat-wechat2rss"; id: string };

type RssHubOutcome =
  | { kind: "success"; payload: unknown }
  | { kind: "no-route" }
  | {
      kind: "failed";
      message: string;
      match?: RadarMatch;
      reason?: "source-mismatch";
    };

function hostnameMatches(hostname: string, expected: string) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

function findLinkPlatform(url: URL) {
  return LINK_PLATFORMS.find((candidate) =>
    candidate.hostnames.some((hostname) => hostnameMatches(url.hostname, hostname)),
  );
}

function normalizePlatformUrl(url: URL) {
  const normalized = normalizePublicUrl(url);
  let preferredTitle: string | undefined;

  if (normalized.hostname === "space.bilibili.com") {
    const tab = normalized.pathname.match(
      /^\/(\d+)\/(video|dynamic|article|favlist)$/,
    );
    if (tab) {
      normalized.pathname = `/${tab[1]}`;
      preferredTitle = {
        video: "UP 主投稿",
        dynamic: "UP 主动态",
        article: "UP 主图文",
        favlist: "UP 主默认收藏夹",
      }[tab[2]!];
    }
  }

  return { url: normalized, preferredTitle };
}

function bilibiliProfileId(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.hostname !== "space.bilibili.com") return undefined;
    return url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}

function verifyRssHubSourceIdentity(
  initialUrl: URL,
  platform: LinkPlatform | undefined,
  match: RadarMatch,
  siteUrl: string | undefined,
) {
  if (platform?.kind !== "bilibili") return false;
  const expectedId = bilibiliProfileId(initialUrl.href);
  if (!expectedId) return false;

  const routeId = match.route.match(
    /^\/bilibili\/user\/(?:video|article|dynamic)\/(\d+)(?:\/|$)/,
  )?.[1];
  const returnedId = bilibiliProfileId(siteUrl);
  if (routeId !== expectedId || returnedId !== expectedId) {
    throw new PreviewError(
      "SOURCE_MISMATCH",
      "RSSHub 返回的内容与所选 B站 UP 主不一致，已拒绝把这些条目加入来源。",
      true,
      502,
    );
  }
  return true;
}

function platformCredentialHint(platform?: LinkPlatform) {
  if (!platform) return undefined;
  const hints: Partial<Record<LinkPlatform["kind"], string>> = {
    bilibili: "部署者可配置 BILIBILI_COOKIE_1 后重试。",
    zhihu: "部署者可配置 ZHIHU_COOKIES 后重试。",
    xiaohongshu: "部署者可配置 XIAOHONGSHU_COOKIE 后重试。",
    weibo: "部署者可配置 WEIBO_COOKIES 后重试。",
    ximalaya: "付费专辑需要部署者配置 XIMALAYA_TOKEN。",
  };
  return hints[platform.kind];
}

function subscriptionScopeHint(url: URL, platform: LinkPlatform) {
  const path = url.pathname;
  if (platform.kind === "bilibili" && /^\/video\//.test(path)) {
    return "单个视频不是持续订阅范围，请改用这个作者的 UP 主主页。";
  }
  if (platform.kind === "wechat" && /^\/s\//.test(path)) {
    return "普通文章不能推导公众号历史，请使用微信公众号专用参数入口。";
  }
  if (platform.kind === "xiaohongshu" && /^\/(explore|discovery\/item)\//.test(path)) {
    return "单篇笔记不能持续更新，请改用作者的公开用户主页。";
  }
  if (platform.kind === "douyin" && /^\/video\//.test(path)) {
    return "单个视频不能持续更新，请改用博主主页。";
  }
  if (platform.kind === "kuaishou" && /^\/short-video\//.test(path)) {
    return "单个视频不能持续更新，请改用 Profile 主页。";
  }
  if (platform.kind === "weibo" && !/^\/u\/[^/]+$/.test(path)) {
    return "单条微博不能持续更新，请改用 /u/{uid} 博主主页。";
  }
  if (platform.kind === "toutiao" && /^\/(article|video)\//.test(path)) {
    return "单篇内容不能持续更新，请改用包含用户 token 的主页。";
  }
  if (platform.kind === "douban" && /^\/subject\//.test(path)) {
    return "单个条目不是更新流；目前可订阅豆瓣小组或榜单页面。";
  }
  if (platform.kind === "ximalaya" && /^\/sound\//.test(path)) {
    return "单集不能持续更新，请改用所属专辑页面。";
  }
  return undefined;
}

function configuredRssHub(): RssHubConfig | null {
  const rawBaseUrl = process.env.RSSHUB_BASE_URL?.trim();
  if (!rawBaseUrl) return null;

  try {
    const baseUrl = new URL(rawBaseUrl);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      !["", "/"].includes(baseUrl.pathname)
    ) {
      return null;
    }
    baseUrl.pathname = "/";
    return {
      baseUrl,
      accessKey: process.env.RSSHUB_ACCESS_KEY?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function rssHubRequestUrl(config: RssHubConfig, route: string) {
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) {
    throw new PreviewError("PARSE_FAILED", "RSSHub 返回了不安全的路由。", false, 422);
  }
  const url = new URL(route, config.baseUrl);
  if (url.origin !== config.baseUrl.origin) {
    throw new PreviewError("PARSE_FAILED", "RSSHub 返回了不安全的路由。", false, 422);
  }
  if (config.accessKey) url.searchParams.set("key", config.accessKey);
  return url;
}

async function fetchRssHubResource(
  config: RssHubConfig,
  route: string,
  accept: string,
) {
  let currentUrl = rssHubRequestUrl(config, route);

  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          Accept: accept,
          "User-Agent": "OurChoice/1.0 (+RSSHub integration)",
        },
        signal: AbortSignal.timeout(RSSHUB_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new PreviewError(
          "UPSTREAM_TIMEOUT",
          "RSSHub 响应得有些慢，已保留平台链接模式。",
          true,
          504,
        );
      }
      throw new PreviewError(
        "UPSTREAM_HTTP",
        "暂时无法连接 RSSHub，已保留平台链接模式。",
        true,
        502,
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 1) {
        throw new PreviewError(
          "UPSTREAM_HTTP",
          "RSSHub 返回了过多跳转，已保留平台链接模式。",
          false,
          502,
        );
      }
      const redirected = new URL(location, currentUrl);
      if (redirected.origin !== config.baseUrl.origin) {
        throw new PreviewError(
          "UPSTREAM_HTTP",
          "RSSHub 尝试跳转到其他服务，已拒绝该请求。",
          false,
          502,
        );
      }
      if (config.accessKey) redirected.searchParams.set("key", config.accessKey);
      currentUrl = redirected;
      continue;
    }

    if (!response.ok) {
      throw new PreviewError(
        "UPSTREAM_HTTP",
        `RSSHub 返回了 ${response.status}，已保留平台链接模式。`,
        response.status >= 500,
        502,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new PreviewError(
        "FEED_TOO_LARGE",
        "RSSHub 响应体积过大，已保留平台链接模式。",
        false,
        413,
      );
    }

    return {
      body: await readLimitedBody(response),
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  throw new PreviewError("UPSTREAM_HTTP", "无法读取 RSSHub。", true, 502);
}

function radarDomainCandidates(url: URL, platform?: LinkPlatform) {
  const knownDomain = platform?.hostnames.find((hostname) =>
    hostnameMatches(url.hostname, hostname),
  );
  if (knownDomain) return [knownDomain];

  const domain = parseDomain(url.hostname).domain;
  return domain ? [domain] : [];
}

function radarRulesForHost(
  value: unknown,
  hostname: string,
  domain: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const subdomain = hostname === domain ? "." : hostname.slice(0, -(domain.length + 1));
  const keys = subdomain === "www" ? ["www", "."] : [subdomain || "."];
  const rules: RadarRule[] = [];

  for (const key of keys) {
    const candidates = record[key];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const rule = candidate as Record<string, unknown>;
      if (
        Array.isArray(rule.source) &&
        rule.source.every((source) => typeof source === "string") &&
        typeof rule.target === "string"
      ) {
        rules.push({
          title: typeof rule.title === "string" ? rule.title : undefined,
          docs: typeof rule.docs === "string" ? rule.docs : undefined,
          source: rule.source as string[],
          target: rule.target,
        });
      }
    }
  }
  return rules;
}

function matchRadarSource(pattern: string, url: URL) {
  if (!pattern.startsWith("/") || pattern.length > 1_024) return null;

  const keys: string[] = [];
  let expression = "^";
  let hasLiteralQueryOrHash = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === ":") {
      const name = pattern.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      if (!name) return null;
      index += name.length;
      const modifier = pattern[index + 1];
      const optional = modifier === "?" || modifier === "*";
      const repeated = modifier === "*" || modifier === "+";
      if (optional || modifier === "+") index += 1;
      keys.push(name);

      const capture = repeated ? "(.+?)" : "([^/?#&]+)";
      if (optional && expression.endsWith("\\/")) {
        expression = `${expression.slice(0, -2)}(?:\\/${capture})?`;
      } else {
        expression += optional ? `${capture}?` : capture;
      }
      continue;
    }

    if (character === "*") {
      keys.push(`wildcard${keys.length}`);
      expression += "(.*?)";
      continue;
    }

    if (character === "?" || character === "#") hasLiteralQueryOrHash = true;
    expression += escapeRegExp(character);
  }

  expression += hasLiteralQueryOrHash ? "$" : "(?:[?#].*)?$";
  let match: RegExpMatchArray | null;
  try {
    match = `${url.pathname}${url.search}${url.hash}`.match(new RegExp(expression));
  } catch {
    return null;
  }
  if (!match) return null;

  return Object.fromEntries(keys.map((key, index) => [key, match?.[index + 1] ?? ""]));
}

function fillRadarTarget(target: string, params: Record<string, string>) {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    target.length > 2_048
  ) {
    return null;
  }

  let failed = false;
  const route = target.replace(
    /:([A-Za-z_][A-Za-z0-9_]*)([?*+]?)/g,
    (_, name: string, modifier: string) => {
      const value = params[name];
      if (!value && !["?", "*"].includes(modifier)) {
        failed = true;
        return "";
      }
      return value ?? "";
    },
  );
  if (failed || /(^|[/=?&#]):[A-Za-z_]/.test(route)) return null;
  return route.replace(/\/{2,}/g, "/");
}

function radarPatternScore(pattern: string) {
  return pattern
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)([?*+]?)/g, "")
    .replace(/\*/g, "").length;
}

function matchRadarRule(rule: RadarRule, url: URL): RadarMatch | null {
  for (const source of rule.source) {
    const params = matchRadarSource(source, url);
    if (!params) continue;
    const route = fillRadarTarget(rule.target, params);
    if (route) {
      return {
        id: `radar:${route}`,
        route,
        title: rule.title,
        docs: rule.docs,
        score: radarPatternScore(source),
      };
    }
  }
  return null;
}

function explicitRssHubMatches(url: URL, platform?: LinkPlatform): RadarMatch[] {
  if (platform?.kind !== "ximalaya") return [];
  const match = url.pathname.match(/^\/([A-Za-z][A-Za-z0-9_-]*)\/(\d+)$/);
  if (!match || match[1] === "sound") return [];
  const type = match[1]!;
  const id = match[2]!;
  return [
    {
      id: "manual:ximalaya-album",
      route: `/ximalaya/${type}/${id}`,
      title: "喜马拉雅专辑",
      docs: "https://docs.rsshub.app/routes/multimedia#xi-ma-la-ya",
      score: 10_000,
    },
  ];
}

function dedupeRadarMatches(matches: RadarMatch[]) {
  return [...new Map(matches.map((match) => [match.id, match])).values()];
}

async function discoverRssHubRoutes(
  config: RssHubConfig,
  url: URL,
  platform?: LinkPlatform,
  preferredTitle?: string,
) {
  const matches = explicitRssHubMatches(url, platform);
  if (matches.length > 0) return matches;

  for (const domain of radarDomainCandidates(url, platform)) {
    const response = await fetchRssHubResource(
      config,
      `/api/radar/rules/${encodeURIComponent(domain)}`,
      "application/json",
    );
    let payload: unknown;
    try {
      payload = response.body ? JSON.parse(response.body) : undefined;
    } catch {
      continue;
    }

    const rules = radarRulesForHost(payload, url.hostname, domain);
    for (const rule of rules) {
      const match = matchRadarRule(rule, url);
      if (match) matches.push(match);
    }
  }

  const unique = dedupeRadarMatches(matches);
  if (preferredTitle) {
    const preferred = unique.filter((match) => match.title === preferredTitle);
    if (preferred.length > 0) return preferred;
  }
  const maxScore = Math.max(...unique.map((match) => match.score), -1);
  return unique.filter((match) => match.score === maxScore);
}

function isSyntheticRssHubUrl(raw: string | undefined) {
  if (!raw) return false;
  try {
    return new URL(raw).hostname === "rsshub.invalid";
  } catch {
    return false;
  }
}

async function tryRssHubPreview(
  config: RssHubConfig,
  initialUrl: URL,
  limit: number,
  match: RadarMatch,
  platform?: LinkPlatform,
  manualSubscription?: ManualSubscription,
): Promise<RssHubOutcome> {
  try {
    const feed = await fetchRssHubResource(
      config,
      match.route,
      "application/rss+xml, application/atom+xml, application/xml, text/xml",
    );
    const parsed = parseFeed(
      feed.body,
      new URL(match.route, "https://rsshub.invalid").href,
      limit,
    );
    const safeSource = { ...parsed.source, feedUrl: undefined };
    const identityVerified = verifyRssHubSourceIdentity(
      initialUrl,
      platform,
      match,
      safeSource.siteUrl,
    );
    const parsedTitle = safeSource.title?.trim();
    const title =
      !parsedTitle || /^(undefined|null)(?:\b|\s)/i.test(parsedTitle)
        ? `${platform?.label ?? "RSSHub"} · ${match.title ?? "订阅"}`
        : parsedTitle;
    const items = parsed.items
      .filter((item) => !isSyntheticRssHubUrl(item.url))
      .map((item) => ({
        ...item,
        thumbnailUrl: isSyntheticRssHubUrl(item.thumbnailUrl)
          ? undefined
          : item.thumbnailUrl,
        enclosureUrl: isSyntheticRssHubUrl(item.enclosureUrl)
          ? undefined
          : item.enclosureUrl,
      }));

    return {
      kind: "success",
      payload: {
        ok: true,
        mode: "live",
        source: {
          ...safeSource,
          title,
          kind: platform?.kind ?? "rss",
          platformLabel: platform?.label,
          siteUrl: isSyntheticRssHubUrl(safeSource.siteUrl)
            ? initialUrl.href
            : safeSource.siteUrl ?? initialUrl.href,
          imageUrl: isSyntheticRssHubUrl(safeSource.imageUrl)
            ? undefined
            : safeSource.imageUrl,
          provider: "rsshub",
          refreshUrl: manualSubscription ? undefined : initialUrl.href,
          rsshubRoute: match.route,
          rsshubSelection: match.id,
          routeTitle: match.title,
          docsUrl: match.docs,
          manualSubscription,
          identityVerified: identityVerified || undefined,
        },
        items,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      kind: "failed",
      match,
      reason:
        error instanceof PreviewError && error.code === "SOURCE_MISMATCH"
          ? "source-mismatch"
          : undefined,
      message:
        error instanceof PreviewError
          ? error.message
          : "RSSHub 路由暂时无法生成订阅内容。",
    };
  }
}

function selectionDescriptors(matches: RadarMatch[]): RssHubSelectionDescriptor[] {
  return matches.map((match) => ({
    id: match.id,
    title: match.title ?? "RSSHub 订阅",
    docsUrl: match.docs,
  }));
}

async function tryCombinedRssHubPreview(
  config: RssHubConfig,
  initialUrl: URL,
  limit: number,
  matches: RadarMatch[],
  platform?: LinkPlatform,
): Promise<RssHubOutcome> {
  const outcomes = new Array<RssHubOutcome>(matches.length);
  let nextIndex = 0;
  const workerCount = Math.min(3, matches.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < matches.length) {
        const index = nextIndex;
        nextIndex += 1;
        outcomes[index] = await tryRssHubPreview(
          config,
          initialUrl,
          limit,
          matches[index]!,
          platform,
        );
      }
    }),
  );

  const successes = outcomes.flatMap((outcome) =>
    outcome.kind === "success" ? [outcome.payload] : [],
  ) as Array<{
    source: Record<string, unknown>;
    items: Array<{ upstreamId?: string; url?: string } & Record<string, unknown>>;
    fetchedAt?: string;
  }>;
  const failures = outcomes.filter((outcome) => outcome.kind === "failed");
  const sourceMismatch = failures.find(
    (outcome) => outcome.kind === "failed" && outcome.reason === "source-mismatch",
  );
  if (sourceMismatch?.kind === "failed") return sourceMismatch;
  if (!successes.length) {
    return {
      kind: "failed",
      match: matches[0],
      reason: failures[0]?.kind === "failed" ? failures[0].reason : undefined,
      message:
        failures[0]?.kind === "failed"
          ? failures[0].message
          : "RSSHub 路由暂时无法生成订阅内容。",
    };
  }

  const first = successes[0]!;
  const deduplicated = new Map<string, (typeof first.items)[number]>();
  for (const payload of successes) {
    for (const item of payload.items) {
      const key = item.url || item.upstreamId;
      if (key && !deduplicated.has(key)) deduplicated.set(key, item);
    }
  }
  const selections = selectionDescriptors(matches);
  const firstSource = first.source;
  const routeTitles = selections.map((selection) => selection.title).join("、");

  return {
    kind: "success",
    payload: {
      ok: true,
      mode: "live",
      source: {
        ...firstSource,
        description:
          selections.length > 1
            ? `合并订阅：${routeTitles}`
            : firstSource.description,
        refreshUrl: initialUrl.href,
        provider: "rsshub",
        rsshubSelections: selections,
        rsshubSelection: selections.length === 1 ? selections[0]!.id : undefined,
        rsshubRoute: matches.length === 1 ? matches[0]!.route : undefined,
        routeTitle: selections.length === 1 ? selections[0]!.title : routeTitles,
        docsUrl: selections.length === 1 ? selections[0]!.docsUrl : undefined,
      },
      items: [...deduplicated.values()].slice(0, limit),
      fetchedAt: successes.map((payload) => payload.fetchedAt).find(Boolean) ?? new Date().toISOString(),
      warning:
        failures.length > 0
          ? {
              code: "RSSHUB_PARTIAL",
              message: `${failures.length} 个内容范围暂时更新失败；已保留全部选择，并显示其余范围的内容。`,
            }
          : undefined,
    },
  };
}

function previewOptions(matches: RadarMatch[]): PreviewOption[] {
  return matches.map((match) => ({
    id: match.id,
    title: match.title ?? "RSSHub 订阅",
    description: `订阅范围：${match.title ?? match.route}`,
    docsUrl: match.docs,
  }));
}

function selectRssHubPreview(
  url: URL,
  platform: LinkPlatform | undefined,
  matches: RadarMatch[],
) {
  return {
    ok: true,
    mode: "select" as const,
    source: {
      kind: platform?.kind ?? "rss",
      platformLabel: platform?.label,
      title: platform ? `${platform.label}订阅` : "选择 RSSHub 订阅",
      description: "这个页面可以生成多种订阅，请选择你真正想持续接收的内容。",
      profileUrl: url.href,
      refreshUrl: url.href,
      provider: "rsshub" as const,
    },
    options: previewOptions(matches),
    items: [],
  };
}

function requiredManualValue(value: unknown, label: string, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new PreviewError(
      "INVALID_SELECTION",
      `请输入有效的${label}。`,
      false,
      400,
    );
  }
  return value.trim();
}

function manualRssHubMatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewError("INVALID_SELECTION", "请选择微信公众号订阅方式。", false, 400);
  }
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind === "wechat-uread") {
    const userid = requiredManualValue(input.userid, "公众号 ID", /^[A-Za-z0-9_-]{1,128}$/);
    const manual: ManualSubscription = { kind, userid };
    return {
      manual,
      url: new URL("https://mp.weixin.qq.com/"),
      platform: LINK_PLATFORMS.find((candidate) => candidate.kind === "wechat")!,
      match: {
        id: `manual:${kind}`,
        route: `/wechat/uread/${encodeURIComponent(userid)}`,
        title: "公众号（优读来源）",
        docs: "https://docs.rsshub.app/routes/new-media#wei-xin",
        score: 10_000,
      } satisfies RadarMatch,
    };
  }
  if (kind === "wechat-mp") {
    const biz = requiredManualValue(input.biz, "公众号 Biz", /^[A-Za-z0-9+/=_-]{4,256}$/);
    const hid = requiredManualValue(input.hid, "栏目 HID", /^\d{1,12}$/);
    const cid =
      input.cid === undefined || input.cid === ""
        ? undefined
        : requiredManualValue(input.cid, "栏目 CID", /^\d{1,12}$/);
    const manual: ManualSubscription = { kind, biz, hid, cid };
    const route = `/wechat/mp/homepage/${encodeURIComponent(biz)}/${encodeURIComponent(hid)}${
      cid ? `/${encodeURIComponent(cid)}` : ""
    }`;
    return {
      manual,
      url: new URL("https://mp.weixin.qq.com/"),
      platform: LINK_PLATFORMS.find((candidate) => candidate.kind === "wechat")!,
      match: {
        id: `manual:${kind}`,
        route,
        title: "公众号栏目",
        docs: "https://docs.rsshub.app/routes/new-media#wei-xin",
        score: 10_000,
      } satisfies RadarMatch,
    };
  }
  if (kind === "wechat-wechat2rss") {
    const id = requiredManualValue(input.id, "Wechat2RSS ID", /^[A-Fa-f0-9]{16,128}$/);
    const manual: ManualSubscription = { kind, id };
    return {
      manual,
      url: new URL("https://mp.weixin.qq.com/"),
      platform: LINK_PLATFORMS.find((candidate) => candidate.kind === "wechat")!,
      match: {
        id: `manual:${kind}`,
        route: `/wechat/wechat2rss/${encodeURIComponent(id)}`,
        title: "公众号（Wechat2RSS 来源）",
        docs: "https://docs.rsshub.app/routes/new-media#wei-xin",
        score: 10_000,
      } satisfies RadarMatch,
    };
  }
  throw new PreviewError("INVALID_SELECTION", "不支持这个微信公众号订阅方式。", false, 400);
}

function platformLinkPreview(
  url: URL,
  platform = findLinkPlatform(url),
  rssHubFallback?: "no-route" | "failed",
  matches: RadarMatch[] = [],
  attempted?: RadarMatch,
  failureReason?: "source-mismatch",
) {
  if (!platform) return null;

  const mid =
    platform.kind === "bilibili" && url.hostname === "space.bilibili.com"
      ? url.pathname.match(/^\/(\d+)/)?.[1]
      : undefined;
  const isVideo = platform.kind === "bilibili" && /\/video\//.test(url.pathname);
  const isBilibili = platform.kind === "bilibili";

  return {
    ok: true,
    mode: "link-only" as const,
    source: {
      kind: platform.kind,
      platformLabel: platform.label,
      title: isBilibili
        ? mid
          ? `B站创作者 ${mid}`
          : isVideo
            ? "B站视频来源"
            : "B站订阅"
        : `${platform.label}来源`,
      mid,
      profileUrl: url.href,
      description: `链接模式：保留这个${platform.description}，并在自选的主显示区查看。`,
    },
    items: [],
    options: previewOptions(matches),
    warning:
      rssHubFallback === "failed"
        ? {
            code:
              failureReason === "source-mismatch"
                ? "RSSHUB_SOURCE_MISMATCH"
                : attempted
                  ? "RSSHUB_ROUTE_FAILED"
                  : "RSSHUB_FALLBACK",
            message: failureReason === "source-mismatch"
              ? "RSSHub 返回的内容不属于这个 B站 UP 主；已停止导入，并会清理未收藏的可疑条目。"
              : attempted
              ? `RSSHub 路由${attempted.title ? `「${attempted.title}」` : ""}暂时无法生成内容，已保留链接。${platformCredentialHint(platform) ?? "可以稍后重试或改选其他订阅范围。"}`
              : `RSSHub 暂时无法转换这个${platform.label}来源，已安全降级为站内链接；稍后可以重新识别。`,
          }
        : rssHubFallback === "no-route"
          ? {
              code: "RSSHUB_NO_ROUTE",
              message:
                subscriptionScopeHint(url, platform) ??
                `当前 RSSHub Radar 规则没有匹配这个${platform.label}地址，因此以站内链接模式保存。`,
            }
          : {
              code: isBilibili ? "BILIBILI_LINK_ONLY" : "PLATFORM_LINK_ONLY",
              message:
                subscriptionScopeHint(url, platform) ??
                `${platform.label}暂不使用非公开订阅接口，因此以站内链接模式保存；如果你有公开 RSS 地址，也可以直接粘贴以获取预览。`,
            },
  };
}

async function rssHubCandidateOutcome(
  config: RssHubConfig,
  url: URL,
  limit: number,
  platform: LinkPlatform | undefined,
  selections: string[],
  preferredTitle?: string,
) {
  let matches: RadarMatch[];
  try {
    matches = await discoverRssHubRoutes(
      config,
      url,
      platform,
      preferredTitle,
    );
  } catch {
    return {
      outcome: { kind: "failed", message: "暂时无法连接 RSSHub。" } as RssHubOutcome,
      matches: [] as RadarMatch[],
      selectedMatches: [] as RadarMatch[],
    };
  }
  if (matches.length === 0) {
    return {
      outcome: { kind: "no-route" } as RssHubOutcome,
      matches,
      selectedMatches: [] as RadarMatch[],
    };
  }

  if (!selections.length && matches.length > 1) {
    return {
      outcome: {
        kind: "success",
        payload: selectRssHubPreview(url, platform, matches),
      } as RssHubOutcome,
      matches,
      selectedMatches: [] as RadarMatch[],
    };
  }

  const selectedMatches = selections.length
    ? selections.map((selection) => matches.find((candidate) => candidate.id === selection))
    : [matches[0]];
  if (selectedMatches.some((match) => !match)) {
    throw new PreviewError(
      "INVALID_SELECTION",
      "这个订阅选项已经变化，请重新识别来源后再选择。",
      false,
      409,
    );
  }
  const verifiedMatches = selectedMatches as RadarMatch[];
  return {
    outcome: await tryCombinedRssHubPreview(
      config,
      url,
      limit,
      verifiedMatches,
      platform,
    ),
    matches,
    selectedMatches: verifiedMatches,
  };
}

function requestedRssHubSelections(value: unknown, legacyValue: unknown) {
  if (value === undefined) {
    if (legacyValue === undefined) return [];
    if (typeof legacyValue !== "string" || !legacyValue || legacyValue.length > 2_048) {
      throw new PreviewError("INVALID_SELECTION", "订阅选项无效，请重新识别。", false, 400);
    }
    return [legacyValue];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new PreviewError(
      "INVALID_SELECTION",
      "请至少选择一个、最多选择二十个订阅内容范围。",
      false,
      400,
    );
  }
  const selections: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate || candidate.length > 2_048) {
      throw new PreviewError("INVALID_SELECTION", "订阅选项无效，请重新识别。", false, 400);
    }
    if (!selections.includes(candidate)) selections.push(candidate);
  }
  return selections;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      url?: unknown;
      limit?: unknown;
      selection?: unknown;
      selections?: unknown;
      manual?: unknown;
    };
    const requestedLimit = Number(payload.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(20, Math.max(1, Math.round(requestedLimit)))
      : 12;
    const rssHub = configuredRssHub();
    const selections = requestedRssHubSelections(payload.selections, payload.selection);

    if (payload.manual !== undefined) {
      if (!rssHub) {
        throw new PreviewError(
          "RSSHUB_NOT_CONFIGURED",
          "微信公众号专用订阅需要先配置 RSSHub。",
          false,
          503,
        );
      }
      const manual = manualRssHubMatch(payload.manual);
      const outcome = await tryRssHubPreview(
        rssHub,
        manual.url,
        limit,
        manual.match,
        manual.platform,
        manual.manual,
      );
      if (outcome.kind === "success") return json(outcome.payload);
      const fallback = platformLinkPreview(
        manual.url,
        manual.platform,
        "failed",
        [manual.match],
        manual.match,
      )!;
      return json({
        ...fallback,
        source: {
          ...fallback.source,
          provider: "rsshub",
          rsshubSelection: manual.match.id,
          manualSubscription: manual.manual,
        },
      });
    }

    if (typeof payload.url !== "string" || payload.url.length > 2_048) {
      throw new PreviewError("INVALID_URL", "请输入一个有效的订阅地址。", false, 400);
    }

    const resolvedUrl = await resolveAllowedShortLink(inputUrl(payload.url));
    const normalized = normalizePlatformUrl(resolvedUrl);
    const initialUrl = normalized.url;
    const platform = findLinkPlatform(initialUrl);

    if (platform) {
      if (rssHub) {
        const { outcome, matches, selectedMatches } = await rssHubCandidateOutcome(
          rssHub,
          initialUrl,
          limit,
          platform,
          selections,
          normalized.preferredTitle,
        );
        if (outcome.kind === "success") return json(outcome.payload);
        const fallback = platformLinkPreview(
          initialUrl,
          platform,
          outcome.kind,
          matches,
          outcome.kind === "failed" ? outcome.match : undefined,
          outcome.kind === "failed" ? outcome.reason : undefined,
        )!;
        return json(
          selectedMatches.length
            ? {
                ...fallback,
                source: {
                  ...fallback.source,
                  provider: "rsshub",
                  refreshUrl: initialUrl.href,
                  rsshubSelections: selectionDescriptors(selectedMatches),
                  rsshubSelection:
                    selectedMatches.length === 1 ? selectedMatches[0]!.id : undefined,
                },
              }
            : fallback,
        );
      }
      return json(platformLinkPreview(initialUrl, platform));
    }

    try {
      if (rssHub && selections.length) {
        const { outcome } = await rssHubCandidateOutcome(
          rssHub,
          initialUrl,
          limit,
          undefined,
          selections,
        );
        if (outcome.kind === "success") return json(outcome.payload);
      }

      const first = await fetchWithLimits(initialUrl);

      const looksLikeHtml =
        first.contentType.includes("text/html") || /^\s*<!doctype html/i.test(first.body);
      let feed = first;

      if (looksLikeHtml) {
        const discovered = discoverFeedUrl(first.body, first.url.href);
        if (!discovered) {
          throw new PreviewError(
            "UNSUPPORTED_FORMAT",
            "这个网页没有公开可读取的 RSS。你也可以直接粘贴它的 RSS 地址。",
            false,
            422,
          );
        }
        feed = await fetchWithLimits(discovered);
      }

      const parsed = parseFeed(feed.body, feed.url.href, limit);
      return json({
        ok: true,
        mode: "live",
        ...parsed,
        fetchedAt: new Date().toISOString(),
      });
    } catch (directError) {
      if (rssHub) {
        const { outcome } = await rssHubCandidateOutcome(
          rssHub,
          initialUrl,
          limit,
          undefined,
          selections,
        );
        if (outcome.kind === "success") return json(outcome.payload);
      }
      throw directError;
    }
  } catch (error) {
    const known =
      error instanceof PreviewError
        ? error
        : new PreviewError(
            "PARSE_FAILED",
            "暂时没能读懂这个订阅源，请确认地址后重试。",
            false,
            422,
          );
    return json(
      {
        ok: false,
        error: {
          code: known.code,
          message: known.message,
          retryable: known.retryable,
        },
      },
      known.status,
    );
  }
}
