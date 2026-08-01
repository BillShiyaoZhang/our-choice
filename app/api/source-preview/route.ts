import { parse as parseDomain } from "tldts";

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 7_000;
const MAX_REDIRECTS = 3;

type PreviewErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_FORMAT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_HTTP"
  | "FEED_TOO_LARGE"
  | "PARSE_FAILED";

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
  route: string;
  title?: string;
  docs?: string;
}

type RssHubOutcome =
  | { kind: "success"; payload: unknown }
  | { kind: "no-route" }
  | { kind: "failed" };

function hostnameMatches(hostname: string, expected: string) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

function findLinkPlatform(url: URL) {
  return LINK_PLATFORMS.find((candidate) =>
    candidate.hostnames.some((hostname) => hostnameMatches(url.hostname, hostname)),
  );
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

function matchRadarRule(rule: RadarRule, url: URL): RadarMatch | null {
  for (const source of rule.source) {
    const params = matchRadarSource(source, url);
    if (!params) continue;
    const route = fillRadarTarget(rule.target, params);
    if (route) return { route, title: rule.title, docs: rule.docs };
  }
  return null;
}

async function discoverRssHubRoute(
  config: RssHubConfig,
  url: URL,
  platform?: LinkPlatform,
) {
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
      if (match) return match;
    }
  }
  return null;
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
  platform?: LinkPlatform,
): Promise<RssHubOutcome> {
  try {
    const match = await discoverRssHubRoute(config, initialUrl, platform);
    if (!match) return { kind: "no-route" };

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
          kind: platform?.kind ?? "rss",
          platformLabel: platform?.label,
          siteUrl: isSyntheticRssHubUrl(safeSource.siteUrl)
            ? initialUrl.href
            : safeSource.siteUrl ?? initialUrl.href,
          imageUrl: isSyntheticRssHubUrl(safeSource.imageUrl)
            ? undefined
            : safeSource.imageUrl,
          provider: "rsshub",
          refreshUrl: initialUrl.href,
          rsshubRoute: match.route,
          routeTitle: match.title,
          docsUrl: match.docs,
        },
        items,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch {
    return { kind: "failed" };
  }
}

function platformLinkPreview(
  url: URL,
  platform = findLinkPlatform(url),
  rssHubFallback?: "no-route" | "failed",
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
    warning:
      rssHubFallback === "failed"
        ? {
            code: "RSSHUB_FALLBACK",
            message: `RSSHub 暂时无法转换这个${platform.label}来源，已安全降级为站内链接；稍后可以重新识别。`,
          }
        : rssHubFallback === "no-route"
          ? {
              code: "RSSHUB_NO_ROUTE",
              message: `当前 RSSHub Radar 规则没有匹配这个${platform.label}地址，因此以站内链接模式保存。`,
            }
          : {
              code: isBilibili ? "BILIBILI_LINK_ONLY" : "PLATFORM_LINK_ONLY",
              message: `${platform.label}暂不使用非公开订阅接口，因此以站内链接模式保存；如果你有公开 RSS 地址，也可以直接粘贴以获取预览。`,
            },
  };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { url?: unknown; limit?: unknown };
    if (typeof payload.url !== "string" || payload.url.length > 2_048) {
      throw new PreviewError("INVALID_URL", "请输入一个有效的订阅地址。", false, 400);
    }

    const initialUrl = parsePublicUrl(payload.url.trim());
    const platform = findLinkPlatform(initialUrl);

    const requestedLimit = Number(payload.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(20, Math.max(1, Math.round(requestedLimit)))
      : 12;
    const rssHub = configuredRssHub();

    if (platform) {
      if (rssHub) {
        const outcome = await tryRssHubPreview(rssHub, initialUrl, limit, platform);
        if (outcome.kind === "success") return json(outcome.payload);
        return json(platformLinkPreview(initialUrl, platform, outcome.kind));
      }
      return json(platformLinkPreview(initialUrl, platform));
    }

    try {
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
        const outcome = await tryRssHubPreview(rssHub, initialUrl, limit);
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
