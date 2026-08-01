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

test("the project has no OpenAI Sites deployment configuration", async () => {
  const viteConfig = await readFile(new URL("vite.config.ts", templateRoot), "utf8");
  await assert.rejects(
    readFile(new URL(".openai/hosting.json", templateRoot), "utf8"),
  );
  assert.doesNotMatch(viteConfig, /hostingConfig|sites\(\)/);
});
