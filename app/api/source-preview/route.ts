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

function bilibiliPreview(url: URL) {
  const isBilibili =
    url.hostname === "b23.tv" || url.hostname.endsWith("bilibili.com");
  if (!isBilibili) return null;

  const mid =
    url.hostname === "space.bilibili.com"
      ? url.pathname.match(/^\/(\d+)/)?.[1]
      : undefined;
  const isVideo = /\/video\//.test(url.pathname);

  return {
    ok: true,
    mode: "link-only" as const,
    source: {
      kind: "bilibili" as const,
      title: mid ? `B站创作者 ${mid}` : isVideo ? "B站视频来源" : "B站订阅",
      mid,
      profileUrl: url.href,
      description: "链接模式：保留这个来源，并在自选的主显示区查看 B站页面。",
    },
    items: [],
    warning: {
      code: "BILIBILI_LINK_ONLY",
      message:
        "B站暂不提供稳定的匿名订阅接口，因此以站内链接模式保存；如果你有 RSS 转换地址，也可以直接粘贴以获取预览。",
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
    const bilibili = bilibiliPreview(initialUrl);
    if (bilibili) return json(bilibili);

    const requestedLimit = Number(payload.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(20, Math.max(1, Math.round(requestedLimit)))
      : 12;
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
