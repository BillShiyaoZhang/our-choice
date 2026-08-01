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
