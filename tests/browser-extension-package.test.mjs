import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { createDeterministicZip } from "../scripts/chrome-extension-package-validation.mjs";
import {
  readPNGMetadata,
  validateChromeStoreIcon,
} from "../scripts/png-validation.mjs";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

async function runNode(arguments_, options = {}) {
  return run(process.execPath, arguments_, {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function storeZip(files) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [
    name,
    [data, {
      attrs: (0o100644 << 16) >>> 0,
      mtime: new Date("1980-01-01T00:00:00.000Z"),
      os: 3,
    }],
  ])), { level: 9 });
}

test("browser extension rebuild removes stale generated resources", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "our-choice-extension-clean-build-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  for (const browser of ["chrome", "safari"]) {
    const browserRoot = join(output, browser);
    await mkdir(browserRoot, { recursive: true });
    await writeFile(join(browserRoot, "stale-injected.js"), "throw new Error('stale');\n");
  }

  await runNode(["scripts/build-browser-extensions.mjs", "--out", output]);

  for (const browser of ["chrome", "safari"]) {
    await assert.rejects(
      access(join(output, browser, "stale-injected.js")),
      /ENOENT/,
    );
  }
});

test("creates and independently verifies an exact Chrome Web Store ZIP", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "our-choice-chrome-package-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const extensionsRoot = join(output, "extensions");
  const chromeRoot = join(extensionsRoot, "chrome");
  const packagePath = join(output, "Our-Choice-Chrome-0.2.0.zip");

  await runNode(["scripts/build-browser-extensions.mjs", "--out", extensionsRoot]);
  const packaged = await runNode([
    "scripts/package-chrome-extension.mjs",
    "--source",
    chromeRoot,
    "--out",
    packagePath,
  ]);
  const result = JSON.parse(packaged.stdout);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.package, packagePath);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.bytes > 0);
  assert.equal(
    await readFile(`${packagePath}.sha256`, "utf8"),
    `${result.sha256}  Our-Choice-Chrome-0.2.0.zip\n`,
  );

  await runNode([
    "scripts/verify-chrome-extension-package.mjs",
    packagePath,
    "--source",
    chromeRoot,
  ]);

  const archive = unzipSync(new Uint8Array(await readFile(packagePath)));
  const entries = Object.keys(archive).sort();
  assert.ok(entries.includes("manifest.json"));
  assert.equal(entries.some((entry) => entry.startsWith("chrome/")), false);
  assert.equal(new Set(entries).size, entries.length);
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");

  const archiveEntries = Object.entries(archive);
  assert.equal(
    createDeterministicZip(new Map(archiveEntries)).equals(
      createDeterministicZip(new Map(archiveEntries.toReversed())),
    ),
    true,
  );

  const repeatedDirectory = join(output, "repeated");
  await mkdir(repeatedDirectory);
  const repeatedPath = join(repeatedDirectory, "Our-Choice-Chrome-0.2.0.zip");
  await runNode([
    "scripts/package-chrome-extension.mjs",
    "--source",
    chromeRoot,
    "--out",
    repeatedPath,
    "--expected-version",
    "0.2.0",
  ]);
  assert.deepEqual(await readFile(repeatedPath), await readFile(packagePath));
  await assert.rejects(
    runNode([
      "scripts/package-chrome-extension.mjs",
      "--source",
      chromeRoot,
      "--out",
      join(output, "Our-Choice-Chrome-0.2.0.zip"),
      "--expected-version",
      "0.2.1",
    ]),
    /版本|version/i,
  );

  const unsafeDirectory = join(output, "unsafe");
  await mkdir(unsafeDirectory);
  const unsafePath = join(unsafeDirectory, "Our-Choice-Chrome-0.2.0.zip");
  await writeFile(unsafePath, storeZip({
    ...archive,
    "../escaped.txt": new TextEncoder().encode("unsafe"),
  }));
  await assert.rejects(
    runNode([
      "scripts/verify-chrome-extension-package.mjs",
      unsafePath,
      "--source",
      chromeRoot,
    ]),
    /不安全|路径|path/i,
  );

  const extraDirectory = join(output, "extra");
  await mkdir(extraDirectory);
  const extraPath = join(extraDirectory, "Our-Choice-Chrome-0.2.0.zip");
  await writeFile(extraPath, storeZip({
    ...archive,
    "unexpected.txt": new TextEncoder().encode("extra"),
  }));
  await assert.rejects(
    runNode([
      "scripts/verify-chrome-extension-package.mjs",
      extraPath,
      "--source",
      chromeRoot,
    ]),
    /文件列表|额外|不一致/,
  );

  const linkedDirectory = join(output, "linked-zip");
  await mkdir(linkedDirectory);
  const linkedPath = join(linkedDirectory, "Our-Choice-Chrome-0.2.0.zip");
  await symlink(packagePath, linkedPath, "file");
  await assert.rejects(
    runNode([
      "scripts/verify-chrome-extension-package.mjs",
      linkedPath,
      "--source",
      chromeRoot,
    ]),
    /普通 ZIP|符号链接/,
  );
});

test("rejects source symlinks and preserves equals signs in inline CLI values", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "our-choice-chrome-cli="));
  t.after(() => rm(output, { recursive: true, force: true }));
  const extensionsRoot = join(output, "extensions=inline");
  const chromeRoot = join(extensionsRoot, "chrome");
  const packageDirectory = join(output, "packages=inline");
  const packagePath = join(packageDirectory, "Our-Choice-Chrome-0.2.0.zip");

  await runNode(["scripts/build-browser-extensions.mjs", "--out", extensionsRoot]);
  await runNode([
    "scripts/package-chrome-extension.mjs",
    `--source=${chromeRoot}`,
    `--out=${packagePath}`,
    "--expected-version=0.2.0",
  ]);
  await runNode([
    "scripts/verify-chrome-extension-package.mjs",
    packagePath,
    `--source=${chromeRoot}`,
    "--expected-version=0.2.0",
  ]);

  const linkedSource = join(output, "chrome=linked");
  await symlink(chromeRoot, linkedSource, "dir");
  await assert.rejects(
    runNode([
      "scripts/package-chrome-extension.mjs",
      `--source=${linkedSource}`,
      "--out",
      join(output, "Our-Choice-Chrome-0.2.0.zip"),
    ]),
    /非符号链接目录|符号链接/,
  );
});

test("ships exact Chrome Web Store visual assets and a transparent 128 icon", async () => {
  const [icon, screenshot, smallPromo] = await Promise.all([
    readFile(new URL("../browser-extension/icons/icon-128.png", import.meta.url)),
    readFile(new URL(
      "../docs/store/assets/chrome-extension-screenshot-1280x800.png",
      import.meta.url,
    )),
    readFile(new URL(
      "../docs/store/assets/chrome-small-promo-440x280.png",
      import.meta.url,
    )),
  ]);

  assert.equal(validateChromeStoreIcon(icon), true);
  assert.deepEqual(readPNGMetadata(screenshot), { width: 1280, height: 800 });
  assert.deepEqual(readPNGMetadata(smallPromo), { width: 440, height: 280 });
});

test("documents the Chrome Web Store submission and privacy contract", async () => {
  const [packageJsonText, spec, privacy, listing, docsIndex, workflow] = await Promise.all([
    text("package.json"),
    text("docs/spec/browser-extension-release.md"),
    text("docs/browser-extension-privacy.html"),
    text("docs/store/chrome-web-store.md"),
    text("docs/index.html"),
    text(".github/workflows/chrome-extension-package.yml"),
  ]);
  const scripts = JSON.parse(packageJsonText).scripts;

  assert.equal(
    scripts["extensions:package:chrome"],
    "npm run extensions:build && node scripts/package-chrome-extension.mjs",
  );
  assert.equal(
    scripts["extensions:verify-package:chrome"],
    "node scripts/verify-chrome-extension-package.mjs",
  );
  assert.match(spec, /manifest\.json.*ZIP 根目录/s);
  assert.match(spec, /符号链接/);
  assert.match(spec, /GitHub Pages[^。]*HTTP 200/);
  assert.match(spec, /1280[×x]800[^。]*640[×x]400/);
  assert.match(spec, /440[×x]280/);
  assert.match(spec, /128[×x]128[^。]*透明/);
  assert.match(privacy, /localhost/);
  assert.match(privacy, /不.*出售/);
  assert.match(privacy, /选中文字/);
  assert.match(privacy, /打开扩展弹窗时[^。]*URL[^。]*标题[^。]*选中文字/);
  assert.match(privacy, /打开扩展弹窗时[^。]*Bilibili[^。]*MID[^。]*昵称/);
  assert.match(privacy, /收藏、订阅或扫描[^。]*(?:保存|发送|使用)/);
  assert.match(listing, /activeTab/);
  assert.match(listing, /scripting/);
  assert.match(listing, /storage/);
  assert.match(listing, /scripting[^\n]*打开扩展弹窗[^\n]*页面检查器[^\n]*Bilibili/);
  assert.match(listing, /Personally identifiable information[^\n]*昵称[^\n]*MID/);
  assert.match(listing, /Limited Use/);
  assert.match(listing, /curl[^\n]*--fail[^\n]*browser-extension-privacy\.html/);
  assert.match(listing, /返回 HTTP 200/);
  assert.match(listing, /1280[×x]800[^\n]*640[×x]400/);
  assert.match(listing, /440[×x]280/);
  assert.match(listing, /128[×x]128[^\n]*96[×x]96[^\n]*16[^\n]*透明/);
  assert.match(listing, /chrome-extension-screenshot-1280x800\.png/);
  assert.match(listing, /chrome-small-promo-440x280\.png/);
  assert.match(listing, /OUR_CHOICE_CHROME_EXTENSION_ID/);
  assert.match(docsIndex, /browser-extension-privacy\.html/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /extensions:package:chrome/);
  assert.match(workflow, /extensions:verify-package:chrome/);
  assert.match(workflow, /Our-Choice-Chrome-\$\{\{ inputs\.extension_version \}\}\.zip/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
});
