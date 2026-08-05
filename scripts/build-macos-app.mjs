#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MACOS_APP_ICON_FILENAME } from "./macos-app-icon.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`未知参数：${argument}`);
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (["help", "skip-extension-build"].includes(rawName)) {
      options[rawName] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`参数 --${rawName} 缺少值`);
    options[rawName] = value;
  }
  return options;
}

function absolutePath(value, fallback) {
  const candidate = value ?? fallback;
  return isAbsolute(candidate) ? candidate : resolve(root, candidate);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requirePath(path, advice) {
  if (!(await exists(path))) {
    throw new Error(`${path} 不存在。${advice ?? ""}`.trim());
  }
}

async function executableArchitectures(path) {
  const { stdout } = await run("xcrun", ["lipo", "-archs", path], { cwd: root });
  return stdout.trim().split(/\s+/).filter(Boolean);
}

function currentAppleArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持在 ${process.arch} 上构建 macOS 应用`);
}

async function buildExtensionResources(outputRoot) {
  const builder = join(root, "scripts", "build-browser-extensions.mjs");
  await requirePath(builder, "请先实现并提交浏览器扩展共源构建脚本。");
  await rm(outputRoot, { recursive: true, force: true });
  await run(process.execPath, [builder, "--out", outputRoot], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/build-macos-app.mjs [选项]

  --out <目录或.app>       输出位置，默认 build/macos
  --node <可执行文件>      要内置的当前架构 Node，默认当前 process.execPath
  --extensions-dir <目录>  已生成的 chrome/ 与 safari/ 扩展资源
  --bundle-id <标识符>     默认 com.ourchoice.app
  --version <版本>         默认读取 package.json
  --build-version <版本>   默认使用去除非数字字符的应用版本
  --skip-extension-build   使用现有扩展输出，不重新生成`);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("macOS 应用只能在 macOS 主机上构建。");
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = options.version ?? packageJson.version;
  const buildVersion = options["build-version"]
    ?? process.env.OUR_CHOICE_BUILD_VERSION
    ?? String(version).split(".").map((part) => part.replace(/\D/g, "") || "0").join(".");
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildVersion)) {
    throw new Error("构建版本必须是最多三段的数字点分格式。");
  }
  const bundleIdentifier = options["bundle-id"] ?? "com.ourchoice.app";
  const safariExtensionBundleIdentifier = `${bundleIdentifier}.SafariExtension`;

  const output = absolutePath(options.out, "build/macos");
  const appPath = output.endsWith(".app") ? output : join(output, "Our Choice.app");
  const contentsDirectory = join(appPath, "Contents");
  const macOSDirectory = join(contentsDirectory, "MacOS");
  const resourcesDirectory = join(appPath, "Contents", "Resources");
  const runtimeDirectory = join(resourcesDirectory, "runtime");
  const webRuntimeDirectory = join(runtimeDirectory, "web");
  const vinextRuntimeDirectory = join(runtimeDirectory, "vinext");
  const nodeDestination = join(runtimeDirectory, "node", "bin", "node");
  const executableDestination = join(macOSDirectory, "Our Choice");

  const webBuild = join(root, "dist");
  const vinextDist = join(root, "node_modules", "vinext", "dist");
  const vinextPackageJson = join(root, "node_modules", "vinext", "package.json");
  const runtimeServer = join(root, "macos", "runtime", "server.mjs");
  const assistantBridge = join(root, "macos", "runtime", "assistant-bridge.mjs");
  const swiftSource = join(root, "macos", "App", "OurChoiceApp.swift");
  const plistTemplate = join(root, "macos", "App", "Info.plist");
  const appIcon = join(root, "macos", "App", "OurChoice.icns");
  const nodeEntitlements = join(root, "macos", "App", "Node.entitlements");

  await requirePath(webBuild, "请先运行 npm run build。");
  await requirePath(join(webBuild, "client"), "请先运行 npm run build。");
  await requirePath(join(webBuild, "server"), "请先运行 npm run build。");
  await requirePath(vinextDist, "请先运行 npm install。");
  await requirePath(vinextPackageJson, "请先运行 npm install。");
  await requirePath(runtimeServer, "桌面 runtime 尚未生成。");
  await requirePath(assistantBridge, "桌面助手 runtime 尚未生成。");
  await requirePath(appIcon, "主应用图标尚未生成。");

  const extensionOutput = absolutePath(
    options["extensions-dir"],
    join(dirname(appPath), "browser-extensions"),
  );
  if (!options["skip-extension-build"]) await buildExtensionResources(extensionOutput);
  await requirePath(join(extensionOutput, "chrome", "manifest.json"), "请先生成 Chrome 扩展资源。");
  await requirePath(join(extensionOutput, "safari", "manifest.json"), "请先生成 Safari 扩展资源。");

  const requestedNode = absolutePath(options.node, process.execPath);
  const nodeSource = await realpath(requestedNode);
  const nodeArchitectures = await executableArchitectures(nodeSource);
  const expectedArchitecture = currentAppleArchitecture();
  if (!nodeArchitectures.includes(expectedArchitecture)) {
    throw new Error(`Node 不包含当前 ${expectedArchitecture} 架构：${nodeSource}`);
  }

  await rm(appPath, { recursive: true, force: true });
  await Promise.all([
    mkdir(macOSDirectory, { recursive: true }),
    mkdir(join(runtimeDirectory, "node", "bin"), { recursive: true }),
    mkdir(vinextRuntimeDirectory, { recursive: true }),
    mkdir(join(resourcesDirectory, "browser-extension"), { recursive: true }),
  ]);

  await Promise.all([
    cp(webBuild, join(webRuntimeDirectory, "dist"), { recursive: true, dereference: true }),
    cp(vinextDist, join(vinextRuntimeDirectory, "dist"), { recursive: true, dereference: true }),
    copyFile(vinextPackageJson, join(vinextRuntimeDirectory, "package.json")),
    copyFile(runtimeServer, join(runtimeDirectory, "server.mjs")),
    copyFile(assistantBridge, join(runtimeDirectory, "assistant-bridge.mjs")),
    copyFile(appIcon, join(resourcesDirectory, MACOS_APP_ICON_FILENAME)),
    copyFile(nodeSource, nodeDestination),
    copyFile(nodeEntitlements, join(runtimeDirectory, "Node.entitlements")),
    cp(join(extensionOutput, "chrome"), join(resourcesDirectory, "browser-extension", "chrome"), {
      recursive: true,
      dereference: true,
    }),
    cp(join(extensionOutput, "safari"), join(resourcesDirectory, "browser-extension", "safari"), {
      recursive: true,
      dereference: true,
    }),
  ]);
  await chmod(nodeDestination, 0o755);

  const moduleCache = join(dirname(appPath), ".swift-module-cache");
  await mkdir(moduleCache, { recursive: true });
  const target = `${expectedArchitecture}-apple-macos13.0`;
  await run("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-whole-module-optimization",
    "-module-cache-path",
    moduleCache,
    "-target",
    target,
    swiftSource,
    "-framework",
    "Cocoa",
    "-framework",
    "CoreServices",
    "-framework",
    "WebKit",
    "-framework",
    "SafariServices",
    "-o",
    executableDestination,
  ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  await chmod(executableDestination, 0o755);

  const plist = (await readFile(plistTemplate, "utf8"))
    .replaceAll("__OUR_CHOICE_BUNDLE_IDENTIFIER__", bundleIdentifier)
    .replaceAll("__OUR_CHOICE_SAFARI_EXTENSION_BUNDLE_IDENTIFIER__", safariExtensionBundleIdentifier)
    .replaceAll("__OUR_CHOICE_VERSION__", String(version))
    .replaceAll("__OUR_CHOICE_BUILD_VERSION__", buildVersion);
  await writeFile(join(contentsDirectory, "Info.plist"), plist);
  await run("plutil", ["-lint", join(contentsDirectory, "Info.plist")], { cwd: root });

  // Ad-hoc signing keeps local Apple Silicon builds runnable. The release
  // packager replaces these signatures with Developer ID signatures.
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    nodeEntitlements,
    "--sign",
    "-",
    nodeDestination,
  ], { cwd: root });
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--sign",
    "-",
    appPath,
  ], { cwd: root });
  await run("codesign", ["--verify", "--deep", "--strict", appPath], { cwd: root });

  console.log(JSON.stringify({
    app: appPath,
    architecture: expectedArchitecture,
    node: nodeSource,
    version,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[mac:build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
