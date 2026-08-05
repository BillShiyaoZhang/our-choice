#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  SAFARI_GENERATED_APP_NAME,
  SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS,
  validateSafariExtensionDisplayMetadata,
} from "./safari-extension-metadata.mjs";
import { verifySafariAppexResources } from "./safari-extension-resources.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAppName = SAFARI_GENERATED_APP_NAME;

function parseArguments(argv) {
  const options = {
    resources: undefined,
    bundleIdentifier: undefined,
    embedApp: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--resources") {
      options.resources = argv[++index];
      if (!options.resources) throw new Error("参数 --resources 缺少路径。");
      continue;
    }
    if (argument.startsWith("--resources=")) {
      options.resources = argument.slice("--resources=".length);
      continue;
    }
    if (argument === "--bundle-id") {
      options.bundleIdentifier = argv[++index];
      if (!options.bundleIdentifier) throw new Error("参数 --bundle-id 缺少标识符。");
      continue;
    }
    if (argument.startsWith("--bundle-id=")) {
      options.bundleIdentifier = argument.slice("--bundle-id=".length);
      continue;
    }
    if (argument === "--embed-app") {
      options.embedApp = argv[++index];
      if (!options.embedApp) throw new Error("参数 --embed-app 缺少 App 路径。");
      continue;
    }
    if (argument.startsWith("--embed-app=")) {
      options.embedApp = argument.slice("--embed-app=".length);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requirePath(path, message) {
  if (!(await exists(path))) throw new Error(message ?? `找不到 ${path}`);
}

async function execute(command, arguments_, options = {}) {
  return run(command, arguments_, {
    cwd: root,
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
}

async function collectFiles(directory, predicate) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (predicate(path, entry)) matches.push(path);
      matches.push(...await collectFiles(path, predicate));
    } else if (predicate(path, entry)) {
      matches.push(path);
    }
  }
  return matches;
}

function requireExactlyOne(paths, label) {
  if (paths.length !== 1) {
    throw new Error(`${label} 应恰好有一个，实际为 ${paths.length} 个。`);
  }
  return paths[0];
}

async function plistValue(plist, key) {
  const { stdout } = await execute("plutil", ["-extract", key, "raw", "-o", "-", plist]);
  return stdout.trim();
}

async function requireUniversal(path) {
  const { stdout } = await execute("xcrun", ["lipo", "-archs", path]);
  const architectures = stdout.trim().split(/\s+/).filter(Boolean);
  for (const architecture of ["arm64", "x86_64"]) {
    if (!architectures.includes(architecture)) {
      throw new Error(`Safari 扩展不是 Universal：缺少 ${architecture}。`);
    }
  }
  return architectures;
}

async function requireBooleanEntitlement(path, entitlement, label) {
  const result = await execute("codesign", [
    "--display",
    "--entitlements",
    "-",
    path,
  ]);
  const details = `${result.stdout}\n${result.stderr}`;
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xml = new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`);
  const display = new RegExp(
    `\\[Key\\]\\s+${escaped}[\\s\\S]{0,100}\\[Bool\\]\\s+true`,
  );
  if (!xml.test(details) && !display.test(details)) {
    throw new Error(`${label} 缺少启用的 entitlement：${entitlement}`);
  }
}

async function verifyPlugInKitRegistration(appPath, appexPath, extensionIdentifier) {
  const launchServicesRegister = [
    "/System/Library/Frameworks/CoreServices.framework",
    "Frameworks/LaunchServices.framework/Support/lsregister",
  ].join("/");
  await requirePath(launchServicesRegister, "找不到 LaunchServices 注册工具 lsregister。");
  const [canonicalAppPath, canonicalAppexPath] = await Promise.all([
    realpath(appPath),
    realpath(appexPath),
  ]);
  await execute(launchServicesRegister, ["-f", "-R", "-trusted", canonicalAppPath]);

  const escapedIdentifier = extensionIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let lastDetails = "";
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    try {
      const match = await execute("pluginkit", [
        "-m",
        "-A",
        "-D",
        "-vv",
        "-i",
        extensionIdentifier,
      ]);
      lastDetails = `${match.stdout}\n${match.stderr}`;
    } catch (error) {
      lastDetails = `${error?.stdout ?? ""}\n${error?.stderr ?? error?.message ?? ""}`;
    }
    const identifiers = lastDetails.match(
      new RegExp(`^\\s*(?:[+!-]\\s*)?${escapedIdentifier}\\(`, "gm"),
    ) ?? [];
    const paths = lastDetails
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Path = "))
      .map((line) => line.slice("Path = ".length));
    const reportedCount = Number(lastDetails.match(/\((\d+)\s+plug-ins?\)/i)?.[1]);
    const reportedPath = paths.length === 1
      ? await realpath(paths[0]).catch(() => null)
      : null;
    if (
      identifiers.length === 1
      && paths.length === 1
      && reportedPath === canonicalAppexPath
      && reportedCount === 1
    ) {
      return;
    }
    if (attempt < 20) await delay(250);
  }
  throw new Error(
    `PlugInKit 未唯一识别开发 App 内的 Safari 扩展：${extensionIdentifier}\n${lastDetails.trim() || "(no matches)"}`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/check-safari-extension.mjs [--resources <Safari 共源目录>] [--bundle-id <主应用标识符>] [--embed-app <开发 App>]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("Safari Xcode 检查只能在 macOS 上运行。");

  const developerDirectory = (await execute("xcode-select", ["-p"])).stdout.trim();
  if (developerDirectory.endsWith("CommandLineTools")) {
    throw new Error("Safari Xcode 检查需要完整 Xcode；当前仅启用了 Command Line Tools。");
  }
  const xcodeVersion = (await execute("xcodebuild", ["-version"])).stdout.trim();
  await execute("xcrun", ["--find", "safari-web-extension-packager"]);

  const safariResources = absolutePath(
    options.resources ?? "build/browser-extensions/safari",
  );
  const sourceManifestPath = join(safariResources, "manifest.json");
  await requirePath(sourceManifestPath, "找不到 Safari 共源产物；请先运行 npm run extensions:build。");
  const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const embedApp = options.embedApp ? absolutePath(options.embedApp) : null;
  let version = packageMetadata.version;
  let buildVersion = version;
  let bundleIdentifier = options.bundleIdentifier ?? "com.ourchoice.app";
  let embedAppInfoPlist = null;
  if (embedApp) {
    embedAppInfoPlist = join(embedApp, "Contents", "Info.plist");
    await requirePath(embedAppInfoPlist, `找不到待嵌入 Safari 扩展的开发 App：${embedApp}`);
    const appBundleIdentifier = await plistValue(embedAppInfoPlist, "CFBundleIdentifier");
    if (options.bundleIdentifier && options.bundleIdentifier !== appBundleIdentifier) {
      throw new Error("--bundle-id 与待嵌入开发 App 的 Bundle ID 不一致。");
    }
    bundleIdentifier = appBundleIdentifier;
    version = await plistValue(embedAppInfoPlist, "CFBundleShortVersionString");
    buildVersion = await plistValue(embedAppInfoPlist, "CFBundleVersion");
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-safari-check-"));
  try {
    const projectLocation = join(workDirectory, "Project");
    const conversion = await execute("xcrun", [
      "safari-web-extension-packager",
      safariResources,
      "--project-location",
      projectLocation,
      "--app-name",
      generatedAppName,
      "--bundle-identifier",
      bundleIdentifier,
      "--swift",
      "--macos-only",
      "--copy-resources",
      "--no-open",
      "--no-prompt",
      "--force",
    ]);
    const conversionOutput = `${conversion.stdout}\n${conversion.stderr}`;
    if (/Unable to parse manifest|manifest\.json is missing icons|manifest key .*not supported/i.test(conversionOutput)) {
      throw new Error(`Safari 转换器报告 Manifest 问题：\n${conversionOutput.trim()}`);
    }

    const project = requireExactlyOne(
      await collectFiles(projectLocation, (path) => path.endsWith(".xcodeproj")),
      "Safari Xcode 项目",
    );
    const projectList = await execute("xcodebuild", ["-project", project, "-list", "-json"], {
      cwd: projectLocation,
    });
    const description = JSON.parse(projectList.stdout)?.project ?? {};
    const extensionTarget = `${generatedAppName} Extension`;
    assert.ok(
      (description.targets ?? []).includes(extensionTarget),
      `生成项目缺少扩展 target：${extensionTarget}`,
    );

    const productsDirectory = join(workDirectory, "Build");
    const intermediatesDirectory = join(workDirectory, "Intermediates");
    const codeSigningSettings = embedApp
      ? [
          "CODE_SIGN_STYLE=Manual",
          "CODE_SIGN_IDENTITY=-",
          "CODE_SIGNING_ALLOWED=YES",
          "CODE_SIGNING_REQUIRED=YES",
          "AD_HOC_CODE_SIGNING_ALLOWED=YES",
        ]
      : [
          "CODE_SIGNING_ALLOWED=NO",
          "CODE_SIGNING_REQUIRED=NO",
        ];
    await execute("xcodebuild", [
      "-project",
      project,
      "-target",
      extensionTarget,
      "-configuration",
      "Release",
      "ARCHS=arm64 x86_64",
      "ONLY_ACTIVE_ARCH=NO",
      "MACOSX_DEPLOYMENT_TARGET=13.0",
      "DEVELOPMENT_TEAM=",
      ...codeSigningSettings,
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${buildVersion}`,
      ...SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS,
      `SYMROOT=${productsDirectory}`,
      `OBJROOT=${intermediatesDirectory}`,
      "build",
    ], { cwd: projectLocation });

    const appex = requireExactlyOne(
      await collectFiles(productsDirectory, (path) => path.endsWith(".appex")),
      embedApp ? "本机签名 Safari .appex" : "无签名 Safari .appex",
    );
    const infoPlist = join(appex, "Contents", "Info.plist");
    const executableName = await plistValue(infoPlist, "CFBundleExecutable");
    const extensionBundleIdentifier = await plistValue(infoPlist, "CFBundleIdentifier");
    const extensionPoint = await plistValue(
      infoPlist,
      "NSExtension.NSExtensionPointIdentifier",
    );
    const marketingVersion = await plistValue(infoPlist, "CFBundleShortVersionString");
    const extensionBuildVersion = await plistValue(infoPlist, "CFBundleVersion");
    const extensionDisplayName = await plistValue(infoPlist, "CFBundleDisplayName");
    const extensionName = await plistValue(infoPlist, "CFBundleName");
    assert.ok(
      extensionBundleIdentifier.startsWith(`${bundleIdentifier}.`),
      "Safari 扩展 Bundle ID 必须使用主应用 Bundle ID 前缀。",
    );
    assert.equal(extensionPoint, "com.apple.Safari.web-extension");
    assert.equal(marketingVersion, version);
    assert.equal(extensionBuildVersion, buildVersion);
    validateSafariExtensionDisplayMetadata(extensionDisplayName, extensionName);
    const architectures = await requireUniversal(
      join(appex, "Contents", "MacOS", executableName),
    );

    const { manifest: embeddedManifest } = await verifySafariAppexResources({
      sourceRoot: safariResources,
      appexPath: appex,
    });

    if (embedApp) {
      await execute("codesign", ["--verify", "--strict", "--verbose=2", appex]);
      await requireBooleanEntitlement(
        appex,
        "com.apple.security.app-sandbox",
        "Xcode 本机签名的 Safari 扩展",
      );
    }

    let embeddedApp = null;
    if (embedApp) {
      const pluginsDirectory = join(embedApp, "Contents", "PlugIns");
      const destinationAppex = join(
        pluginsDirectory,
        "Our Choice Safari Extension.appex",
      );
      await mkdir(pluginsDirectory, { recursive: true });
      await rm(destinationAppex, { recursive: true, force: true });
      await cp(appex, destinationAppex, {
        recursive: true,
        verbatimSymlinks: true,
      });
      await execute("plutil", [
        "-replace",
        "OurChoiceSafariExtensionBundleIdentifier",
        "-string",
        extensionBundleIdentifier,
        embedAppInfoPlist,
      ]);
      await execute("codesign", ["--verify", "--strict", "--verbose=2", destinationAppex]);
      await requireBooleanEntitlement(
        destinationAppex,
        "com.apple.security.app-sandbox",
        "嵌入开发 App 的 Safari 扩展",
      );
      await execute("codesign", [
        "--force",
        "--options",
        "runtime",
        "--sign",
        "-",
        embedApp,
      ]);
      await execute("codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        embedApp,
      ]);
      const embeddedAppexCandidates = await collectFiles(
        pluginsDirectory,
        (path) => path.endsWith(".appex"),
      );
      assert.equal(
        requireExactlyOne(embeddedAppexCandidates, "开发 App 中的 Safari .appex"),
        destinationAppex,
      );
      await verifyPlugInKitRegistration(
        embedApp,
        destinationAppex,
        extensionBundleIdentifier,
      );
      embeddedApp = embedApp;
    }

    console.log(JSON.stringify({
      xcode: xcodeVersion.replace(/\n/g, "; "),
      bundleIdentifier: extensionBundleIdentifier,
      version: marketingVersion,
      architectures,
      manifestVersion: embeddedManifest.manifest_version,
      embeddedApp,
      signing: embeddedApp ? "Xcode Sign to Run Locally; ad-hoc testing only" : "disabled",
    }, null, 2));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[mac:safari:check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
