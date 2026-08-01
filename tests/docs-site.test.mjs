import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("ships a self-contained user and developer documentation site", async () => {
  const [html, css, script] = await Promise.all([
    text("docs/index.html"),
    text("docs/assets/docs.css"),
    text("docs/assets/docs.js"),
    access(new URL("docs/.nojekyll", root)),
  ]);

  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /href="\.\/assets\/docs\.css"/);
  assert.match(html, /src="\.\/assets\/docs\.js"/);
  assert.match(html, /id="user-guide"/);
  assert.match(html, /id="developer-guide"/);
  assert.match(html, /id="capabilities"/);
  assert.match(html, /id="project-structure"/);
  assert.match(html, /our-choice:state:v1/);
  assert.match(html, /\/api\/source-preview/);
  assert.match(html, /Bilibili/);
  assert.match(html, /微信公众号、知乎、小红书、抖音、快手、微博、小宇宙/);
  assert.match(html, /今日头条、百家号、豆瓣和喜马拉雅/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(script, /data-doc-search/);
  assert.match(script, /navigator\.clipboard/);
});

test("integrates docs with development, builds, and product navigation", async () => {
  const [packageJson, app, syncScript, gitignore] = await Promise.all([
    text("package.json"),
    text("app/our-choice-app.tsx"),
    text("scripts/sync-docs.mjs"),
    text(".gitignore"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.equal(scripts["docs:sync"], "node scripts/sync-docs.mjs");
  assert.equal(scripts.predev, "npm run docs:sync");
  assert.equal(scripts.prebuild, "npm run docs:sync");
  assert.match(syncScript, /public["'],\s*["']docs/);
  assert.match(gitignore, /^\/public\/docs\/$/m);
  assert.match(app, /href="\/docs\/"/);
  assert.match(app, />文档</);
});

test("Dev Container starts the workspace and RSSHub as isolated Compose services", async () => {
  const [devContainerText, compose, packageJsonText, viteConfig] = await Promise.all([
    text(".devcontainer/devcontainer.json"),
    text(".devcontainer/compose.yaml"),
    text("package.json"),
    text("vite.config.ts"),
  ]);
  const devContainer = JSON.parse(devContainerText);
  const packageJson = JSON.parse(packageJsonText);

  assert.equal(devContainer.dockerComposeFile, "compose.yaml");
  assert.equal(devContainer.service, "workspace");
  assert.equal(devContainer.workspaceFolder, "/workspaces/our-choice");
  assert.equal(devContainer.shutdownAction, "stopCompose");
  assert.deepEqual(devContainer.forwardPorts, [3000]);
  assert.equal(
    devContainer.postCreateCommand,
    "npm ci --ignore-scripts --no-audit --no-fund",
  );
  assert.equal(devContainer.remoteUser, "node");
  assert.equal("image" in devContainer, false);
  assert.match(packageJson.scripts.dev, /vinext dev --hostname 0\.0\.0\.0$/);

  assert.match(compose, /^services:\s*\n\s{2}workspace:/m);
  assert.match(compose, /mcr\.microsoft\.com\/devcontainers\/javascript-node:1-22-bookworm/);
  assert.match(compose, /\.\.:\/workspaces\/our-choice:cached/);
  assert.match(compose, /command:\s*sleep infinity/);
  assert.match(compose, /RSSHUB_BASE_URL:\s*http:\/\/rsshub:1200/);
  assert.match(compose, /RSSHUB_ACCESS_KEY:\s*\$\{RSSHUB_ACCESS_KEY:-\}/);
  assert.match(compose, /depends_on:\s*\n\s{6}rsshub:/m);
  assert.match(compose, /^\s{2}rsshub:\s*$/m);
  assert.match(compose, /ghcr\.io\/diygod\/rsshub:chromium-bundled/);
  assert.match(compose, /ACCESS_KEY:\s*\$\{RSSHUB_ACCESS_KEY:-\}/);
  for (const name of [
    "BILIBILI_COOKIE_1",
    "ZHIHU_COOKIES",
    "XIAOHONGSHU_COOKIE",
    "WEIBO_COOKIES",
    "XIMALAYA_TOKEN",
  ]) {
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}:-\\}`));
  }
  assert.match(viteConfig, /vars:\s*runtimeBindings/);
  assert.match(viteConfig, /RSSHUB_BASE_URL/);
  assert.match(viteConfig, /RSSHUB_ACCESS_KEY/);
  assert.match(
    compose,
    /ports:\s*\n\s+- "127\.0\.0\.1:\$\{APP_PORT:-3000\}:3000"/,
  );
  assert.equal(compose.match(/^\s+ports:/gm)?.length, 1);
});

test("documents and exposes one parser, multi-scope sources, and source settings", async () => {
  const [html, app, model] = await Promise.all([
    text("docs/index.html"),
    text("app/our-choice-app.tsx"),
    text("app/lib/model.ts"),
  ]);

  assert.match(html, /唯一的“链接或 RSS”输入/);
  assert.match(html, /同时勾选投稿、动态、图文、回答、专栏/);
  assert.match(html, /始终视为一个来源/);
  assert.match(app, /supported-platform-list/);
  assert.doesNotMatch(app, /className="platform-entry-grid"/);
  assert.match(app, /选择要订阅的内容/);
  assert.match(app, /微信公众号高级设置/);
  assert.match(app, /selectedOptionIds/);
  assert.match(app, /function SourceSettingsModal/);
  assert.match(app, /设置 \$\{source\.name\}/);
  assert.match(app, /rsshubSelections/);
  assert.match(model, /export interface RssHubSelection/);
  assert.match(model, /rsshubSelections\?: RssHubSelection\[\]/);
  assert.match(app, /topbar-add[^>]+aria-label="添加订阅"/);
});

test("opens source details by content type and respects Bilibili video open preferences", async () => {
  const [html, app, model] = await Promise.all([
    text("docs/index.html"),
    text("app/our-choice-app.tsx"),
    text("app/lib/model.ts"),
  ]);

  assert.match(html, /视频、文章和播客分区展示/);
  assert.match(html, /在新窗口打开 Bilibili/);
  assert.match(app, /function SourceDetailView/);
  assert.match(app, /sourceContentSections/);
  assert.match(app, /comparePublishedAtDescending/);
  assert.match(app, /onOpenDetails/);
  assert.match(app, /视频打开方式/);
  assert.match(app, /bilibiliOpenMode/);
  assert.match(app, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(model, /bilibiliOpenMode\?: "embedded" \| "external"/);
});

test("deploys docs through a least-privilege GitHub Pages workflow", async () => {
  const workflow = await text(".github/workflows/docs-pages.yml");

  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /path:\s*docs/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /environment:\s*\n\s*name:\s*github-pages/);
});
