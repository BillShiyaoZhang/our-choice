import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const workerModule = await import(workerUrl.href);
  return workerModule.default;
}

function env() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  };
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("server-renders the finished local-first product", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env(),
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>自选｜只看你主动选择的内容<\/title>/i);
  assert.match(html, /今天，只看你主动选择的/);
  assert.match(html, /内容选择留在本机/);
  assert.match(html, /添加订阅/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("keeps persistence local and removes the disposable starter", async () => {
  const [page, app, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/our-choice-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<OurChoiceApp \/>/);
  assert.match(app, /our-choice:state:v1/);
  assert.match(app, /window\.localStorage/);
  assert.match(app, /\/api\/source-preview/);
  assert.match(layout, /lang="zh-CN"/);
  assert.doesNotMatch(page, /_sites-preview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(readFile(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("keeps channels and content inside the app with a new-content baseline", async () => {
  const [app, model, previewRoute] = await Promise.all([
    readFile(new URL("../app/our-choice-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/model.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/source-preview/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function EmbeddedViewer/);
  assert.match(app, /<iframe/);
  assert.match(app, /返回自选/);
  assert.match(app, /allow-forms/);
  assert.match(app, /allow-storage-access-by-user-activation/);
  assert.match(app, /在当前页打开并登录 B站/);
  assert.match(app, /source\.knownItemIds/);
  assert.match(app, /isNew:\s*false/);
  assert.match(app, /历史内容（不计入新增）/);
  assert.doesNotMatch(app, /target="_blank"/);
  assert.match(model, /platformSessions:\s*PlatformSession\[\]/);
  assert.match(model, /viewedAt\?:\s*string/);
  assert.match(previewRoute, /publishedAtReliable:\s*Boolean\(publishedAt\)/);
});

test("source preview rejects non-public URLs", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/api/source-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:8000/private-feed" }),
    }),
    env(),
    context,
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "INVALID_URL");
});

test("Bilibili creator pages use an explicit link-only mode", async () => {
  const app = await worker();
  const response = await app.fetch(
    new Request("http://localhost/api/source-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://space.bilibili.com/946974" }),
    }),
    env(),
    context,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "link-only");
  assert.equal(payload.source.kind, "bilibili");
  assert.equal(payload.source.mid, "946974");
  assert.equal(payload.warning.code, "BILIBILI_LINK_ONLY");
});

test("mainstream Chinese content platforms use explicit link-only previews", async () => {
  const app = await worker();
  const cases = [
    ["https://mp.weixin.qq.com/s/example", "wechat", "微信公众号"],
    ["https://www.zhihu.com/people/example", "zhihu", "知乎"],
    ["https://www.xiaohongshu.com/user/profile/example", "xiaohongshu", "小红书"],
    ["https://www.douyin.com/user/example", "douyin", "抖音"],
    ["https://www.kuaishou.com/profile/example", "kuaishou", "快手"],
    ["https://weibo.com/u/example", "weibo", "微博"],
    ["https://www.xiaoyuzhoufm.com/podcast/example", "xiaoyuzhou", "小宇宙"],
    ["https://www.toutiao.com/c/user/example", "toutiao", "今日头条"],
    ["https://baijiahao.baidu.com/s?id=example", "baijiahao", "百家号"],
    ["https://www.douban.com/people/example", "douban", "豆瓣"],
    ["https://www.ximalaya.com/zhubo/example", "ximalaya", "喜马拉雅"],
  ];

  for (const [url, platform, label] of cases) {
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      }),
      env(),
      context,
    );

    assert.equal(response.status, 200, `${label} should be recognized`);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "link-only");
    assert.equal(payload.source.kind, platform);
    assert.equal(payload.source.platformLabel, label);
    assert.equal(payload.source.profileUrl, url);
    assert.deepEqual(payload.items, []);
    assert.equal(payload.warning.code, "PLATFORM_LINK_ONLY");
    assert.match(payload.warning.message, new RegExp(label));
  }
});

test("configured RSSHub resolves Radar rules without exposing its instance or access key", async () => {
  const previousBaseUrl = process.env.RSSHUB_BASE_URL;
  const previousAccessKey = process.env.RSSHUB_ACCESS_KEY;
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const sourceUrl = "https://space.bilibili.com/946974";
  const accessKey = "server-only-secret";

  process.env.RSSHUB_BASE_URL = "http://rsshub.internal:1200";
  process.env.RSSHUB_ACCESS_KEY = accessKey;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestedUrls.push(url);

    if (url.startsWith("http://rsshub.internal:1200/api/radar/rules/bilibili.com")) {
      return Response.json({
        _name: "哔哩哔哩",
        space: [
          {
            title: "UP 主投稿",
            docs: "https://docs.rsshub.app/routes/social-media",
            source: ["/:mid"],
            target: "/bilibili/user/video/:mid",
          },
        ],
      });
    }

    if (url.startsWith("http://rsshub.internal:1200/bilibili/user/video/946974")) {
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>影视飓风</title><link>${sourceUrl}</link><description>来自 B 站的更新</description><item><guid>BV1test</guid><title>一条新视频</title><link>https://www.bilibili.com/video/BV1test</link><pubDate>Sat, 01 Aug 2026 01:00:00 GMT</pubDate><description>视频简介</description></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      );
    }

    throw new Error(`Unexpected upstream request: ${url}`);
  };

  try {
    const app = await worker();
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env(),
      context,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "live");
    assert.equal(payload.source.kind, "bilibili");
    assert.equal(payload.source.provider, "rsshub");
    assert.equal(payload.source.refreshUrl, sourceUrl);
    assert.equal(payload.source.rsshubRoute, "/bilibili/user/video/946974");
    assert.equal(payload.source.feedUrl, undefined);
    assert.equal(payload.items[0].title, "一条新视频");
    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls.every((url) => new URL(url).searchParams.get("key") === accessKey));
    assert.doesNotMatch(JSON.stringify(payload), /rsshub\.internal|server-only-secret/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.RSSHUB_BASE_URL;
    else process.env.RSSHUB_BASE_URL = previousBaseUrl;
    if (previousAccessKey === undefined) delete process.env.RSSHUB_ACCESS_KEY;
    else process.env.RSSHUB_ACCESS_KEY = previousAccessKey;
  }
});

test("RSSHub discovery failures preserve the platform link-only fallback", async () => {
  const previousBaseUrl = process.env.RSSHUB_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.RSSHUB_BASE_URL = "https://rsshub.example";
  globalThis.fetch = async () => new Response("Unavailable", { status: 503 });

  try {
    const app = await worker();
    const sourceUrl = "https://www.zhihu.com/people/example";
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env(),
      context,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, "link-only");
    assert.equal(payload.source.kind, "zhihu");
    assert.equal(payload.source.profileUrl, sourceUrl);
    assert.equal(payload.warning.code, "RSSHUB_FALLBACK");
    assert.match(payload.warning.message, /RSSHub/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.RSSHUB_BASE_URL;
    else process.env.RSSHUB_BASE_URL = previousBaseUrl;
  }
});

test("RSSHub Radar extends discovery to websites outside the built-in platform list", async () => {
  const previousBaseUrl = process.env.RSSHUB_BASE_URL;
  const originalFetch = globalThis.fetch;
  const sourceUrl = "https://blog.example.com/author/alice";
  process.env.RSSHUB_BASE_URL = "https://rsshub.example";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === sourceUrl) {
      return new Response("<!doctype html><title>Alice</title>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url === "https://rsshub.example/api/radar/rules/example.com") {
      return Response.json({
        _name: "Example",
        blog: [
          {
            title: "作者文章",
            source: ["/author/:name"],
            target: "/example/author/:name",
          },
        ],
      });
    }
    if (url === "https://rsshub.example/example/author/alice") {
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Alice 的文章</title><link>${sourceUrl}</link><item><title>第一篇</title><link>https://blog.example.com/posts/one</link><guid>one</guid></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      );
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };

  try {
    const app = await worker();
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env(),
      context,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.mode, "live");
    assert.equal(payload.source.kind, "rss");
    assert.equal(payload.source.provider, "rsshub");
    assert.equal(payload.source.refreshUrl, sourceUrl);
    assert.equal(payload.source.rsshubRoute, "/example/author/alice");
    assert.equal(payload.items[0].url, "https://blog.example.com/posts/one");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.RSSHUB_BASE_URL;
    else process.env.RSSHUB_BASE_URL = previousBaseUrl;
  }
});

test("RSSHub Radar uses the registrable domain for multi-level public suffixes", async () => {
  const previousBaseUrl = process.env.RSSHUB_BASE_URL;
  const originalFetch = globalThis.fetch;
  const sourceUrl = "https://news.example.co.uk/writers/bob";
  process.env.RSSHUB_BASE_URL = "https://rsshub.example";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === sourceUrl) {
      return new Response("<!doctype html><title>Bob</title>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url === "https://rsshub.example/api/radar/rules/example.co.uk") {
      return Response.json({
        _name: "Example UK",
        news: [
          {
            title: "作者文章",
            source: ["/writers/:name"],
            target: "/example-uk/writers/:name",
          },
        ],
      });
    }
    if (url === "https://rsshub.example/example-uk/writers/bob") {
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Bob</title><link>${sourceUrl}</link><item><title>UK post</title><link>https://news.example.co.uk/posts/one</link></item></channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      );
    }
    throw new Error(`Unexpected upstream request: ${url}`);
  };

  try {
    const app = await worker();
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      }),
      env(),
      context,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.mode, "live");
    assert.equal(payload.source.rsshubRoute, "/example-uk/writers/bob");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.RSSHUB_BASE_URL;
    else process.env.RSSHUB_BASE_URL = previousBaseUrl;
  }
});

test("RSSHub Radar routes cannot escape the configured instance", async () => {
  const previousBaseUrl = process.env.RSSHUB_BASE_URL;
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  process.env.RSSHUB_BASE_URL = "https://rsshub.example";
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestedUrls.push(url);
    return Response.json({
      _name: "哔哩哔哩",
      space: [
        {
          title: "不安全路由",
          source: ["/:mid"],
          target: "//attacker.example/:mid",
        },
      ],
    });
  };

  try {
    const app = await worker();
    const response = await app.fetch(
      new Request("http://localhost/api/source-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://space.bilibili.com/946974" }),
      }),
      env(),
      context,
    );
    const payload = await response.json();
    assert.equal(payload.mode, "link-only");
    assert.equal(payload.warning.code, "RSSHUB_NO_ROUTE");
    assert.equal(requestedUrls.length, 1);
    assert.equal(new URL(requestedUrls[0]).hostname, "rsshub.example");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.RSSHUB_BASE_URL;
    else process.env.RSSHUB_BASE_URL = previousBaseUrl;
  }
});

test("the project has no OpenAI Sites deployment configuration", async () => {
  const viteConfig = await readFile(new URL("vite.config.ts", templateRoot), "utf8");
  await assert.rejects(
    readFile(new URL(".openai/hosting.json", templateRoot), "utf8"),
  );
  assert.doesNotMatch(viteConfig, /hostingConfig|sites\(\)/);
});
