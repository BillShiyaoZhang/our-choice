#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePackagingChromeExtensionID } from "./macos-chrome-registration.mjs";
import { validateExactEntitlements } from "./macos-entitlements-validation.mjs";
import { writeReleaseCandidateManifest } from "./macos-release-candidate.mjs";
import {
  SAFARI_GENERATED_APP_NAME,
  SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS,
  validateSafariExtensionDisplayMetadata,
} from "./safari-extension-metadata.mjs";
import { verifySafariAppexResources } from "./safari-extension-resources.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function toolEnvironment() {
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "TMPDIR", "LANG", "DEVELOPER_DIR"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
}

function run(command, arguments_, options = {}) {
  return execFileAsync(command, arguments_, {
    cwd: root,
    env: toolEnvironment(),
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
}

export function parseArguments(argv) {
  const booleanOptions = new Set(["help", "skip-notarization"]);
  const valueOptions = new Set([
    "app",
    "out",
    "manifest",
    "node-arm64",
    "node-x64",
    "safari-resources",
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`未知参数：${argument}`);
    const body = argument.slice(2);
    const separator = body.indexOf("=");
    const rawName = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    if (!booleanOptions.has(rawName) && !valueOptions.has(rawName)) {
      throw new Error(`未知参数：--${rawName}`);
    }
    if (Object.hasOwn(options, rawName)) throw new Error(`重复参数：--${rawName}`);
    if (booleanOptions.has(rawName)) {
      if (inlineValue !== undefined) throw new Error(`参数 --${rawName} 不接受值`);
      options[rawName] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${rawName} 缺少值`);
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

async function requirePath(path, message) {
  if (!(await exists(path))) throw new Error(message ?? `${path} 不存在`);
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
  const { stdout } = await run("plutil", ["-extract", key, "raw", "-o", "-", plist]);
  return stdout.trim();
}

async function replacePlistValue(plist, key, value) {
  await run("plutil", ["-replace", key, "-string", value, plist]);
}

async function lipoArchitectures(path) {
  const { stdout } = await run("xcrun", ["lipo", "-archs", path]);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

async function requireUniversal(path, label) {
  const architectures = await lipoArchitectures(path);
  for (const required of ["arm64", "x86_64"]) {
    if (!architectures.includes(required)) {
      throw new Error(`${label} 不是 Universal：缺少 ${required}（${path}）`);
    }
  }
  return architectures;
}

async function compileUniversalApp(appPath, workDirectory) {
  const source = join(root, "macos", "App", "OurChoiceApp.swift");
  const destination = join(appPath, "Contents", "MacOS", "Our Choice");
  const slices = [];
  for (const architecture of ["arm64", "x86_64"]) {
    const output = join(workDirectory, `Our Choice-${architecture}`);
    const moduleCache = join(workDirectory, `swift-cache-${architecture}`);
    await mkdir(moduleCache, { recursive: true });
    await run("xcrun", [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-whole-module-optimization",
      "-module-cache-path",
      moduleCache,
      "-target",
      `${architecture}-apple-macos13.0`,
      source,
      "-framework",
      "Cocoa",
      "-framework",
      "WebKit",
      "-framework",
      "SafariServices",
      "-o",
      output,
    ]);
    slices.push(output);
  }
  await run("xcrun", ["lipo", "-create", ...slices, "-output", destination]);
  await chmod(destination, 0o755);
  await requireUniversal(destination, "发行候选主应用可执行文件");
}

async function installUniversalNode(appPath, options, workDirectory) {
  const destination = join(appPath, "Contents", "Resources", "runtime", "node", "bin", "node");
  const arm64 = options["node-arm64"] ?? process.env.OUR_CHOICE_NODE_ARM64;
  const x64 = options["node-x64"] ?? process.env.OUR_CHOICE_NODE_X64;
  if (!arm64 && !x64) {
    await requireUniversal(
      destination,
      "内置 Node；请设置 OUR_CHOICE_NODE_ARM64 与 OUR_CHOICE_NODE_X64",
    );
    return destination;
  }
  if (!arm64 || !x64) {
    throw new Error("Universal 发行必须同时提供 --node-arm64 与 --node-x64。");
  }
  const arm64Path = absolutePath(arm64);
  const x64Path = absolutePath(x64);
  await requirePath(arm64Path, `找不到 arm64 Node：${arm64Path}`);
  await requirePath(x64Path, `找不到 x86_64 Node：${x64Path}`);
  if (!(await lipoArchitectures(arm64Path)).includes("arm64")) {
    throw new Error(`arm64 Node 不包含 arm64 slice：${arm64Path}`);
  }
  if (!(await lipoArchitectures(x64Path)).includes("x86_64")) {
    throw new Error(`x86_64 Node 不包含 x86_64 slice：${x64Path}`);
  }
  const universal = join(workDirectory, "node-universal");
  await run("xcrun", ["lipo", "-create", arm64Path, x64Path, "-output", universal]);
  await copyFile(universal, destination);
  await chmod(destination, 0o755);
  await requireUniversal(destination, "发行候选内置 Node");
  return destination;
}

async function requireExactSignedEntitlements(path, architectures, expected, label) {
  for (const architecture of architectures) {
    const result = await run("codesign", [
      "--display",
      "--arch",
      architecture,
      "--entitlements",
      "-",
      path,
    ]);
    const details = `${result.stdout}\n${result.stderr}`;
    validateExactEntitlements(details, expected, `${label}（${architecture}）`);
  }
}

async function buildSafariExtension({
  appPath,
  bundleIdentifier,
  version,
  buildVersion,
  workDirectory,
  safariResources,
}) {
  const packager = (await run("xcrun", ["--find", "safari-web-extension-packager"])).stdout.trim();
  if (!packager) throw new Error("完整 Xcode 未提供 safari-web-extension-packager。");
  const projectLocation = join(workDirectory, "SafariWebExtension");
  await mkdir(projectLocation, { recursive: true });
  await run("xcrun", [
    "safari-web-extension-packager",
    safariResources,
    "--project-location",
    projectLocation,
    "--app-name",
    SAFARI_GENERATED_APP_NAME,
    "--bundle-identifier",
    bundleIdentifier,
    "--swift",
    "--macos-only",
    "--copy-resources",
    "--no-open",
    "--no-prompt",
    "--force",
  ]);

  const project = requireExactlyOne(
    await collectFiles(projectLocation, (path) => path.endsWith(".xcodeproj")),
    "Safari Xcode 项目",
  );
  const extensionTarget = `${SAFARI_GENERATED_APP_NAME} Extension`;
  const projectList = await run("xcodebuild", ["-project", project, "-list", "-json"], {
    cwd: projectLocation,
  });
  if (!(JSON.parse(projectList.stdout)?.project?.targets ?? []).includes(extensionTarget)) {
    throw new Error(`生成的 Safari Xcode 项目缺少扩展 target：${extensionTarget}`);
  }

  const productsDirectory = join(workDirectory, "SafariBuild");
  const intermediatesDirectory = join(workDirectory, "SafariIntermediates");
  await run("xcodebuild", [
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
    "CODE_SIGNING_ALLOWED=NO",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO",
    `MARKETING_VERSION=${version}`,
    `CURRENT_PROJECT_VERSION=${buildVersion}`,
    ...SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS,
    `SYMROOT=${productsDirectory}`,
    `OBJROOT=${intermediatesDirectory}`,
    "build",
  ], { cwd: projectLocation });

  const sourceAppex = requireExactlyOne(
    await collectFiles(productsDirectory, (path) => path.endsWith(".appex")),
    "预构建 Safari .appex",
  );
  const safariEntitlements = join(root, "macos", "App", "SafariExtension.entitlements");
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    safariEntitlements,
    "--sign",
    "-",
    sourceAppex,
  ]);
  const pluginsDirectory = join(appPath, "Contents", "PlugIns");
  const destinationAppex = join(pluginsDirectory, "Our Choice Safari Extension.appex");
  await mkdir(pluginsDirectory, { recursive: true });
  await rm(destinationAppex, { recursive: true, force: true });
  await cp(sourceAppex, destinationAppex, { recursive: true, verbatimSymlinks: true });
  await verifySafariAppexResources({ sourceRoot: safariResources, appexPath: destinationAppex });

  const extensionPlist = join(destinationAppex, "Contents", "Info.plist");
  const extensionExecutable = await plistValue(extensionPlist, "CFBundleExecutable");
  const extensionBundleIdentifier = await plistValue(extensionPlist, "CFBundleIdentifier");
  const extensionVersion = await plistValue(extensionPlist, "CFBundleShortVersionString");
  const extensionBuildVersion = await plistValue(extensionPlist, "CFBundleVersion");
  const extensionDisplayName = await plistValue(extensionPlist, "CFBundleDisplayName");
  const extensionName = await plistValue(extensionPlist, "CFBundleName");
  const extensionPoint = await plistValue(
    extensionPlist,
    "NSExtension.NSExtensionPointIdentifier",
  );
  if (!extensionBundleIdentifier.startsWith(`${bundleIdentifier}.`)) {
    throw new Error(`Safari 扩展 Bundle ID 必须以 ${bundleIdentifier}. 开头。`);
  }
  if (extensionVersion !== version || extensionBuildVersion !== buildVersion) {
    throw new Error("Safari 扩展版本与发行候选主应用不一致。");
  }
  if (extensionPoint !== "com.apple.Safari.web-extension") {
    throw new Error(`Safari 扩展点无效：${extensionPoint}`);
  }
  validateSafariExtensionDisplayMetadata(extensionDisplayName, extensionName);
  const architectures = await requireUniversal(
    join(destinationAppex, "Contents", "MacOS", extensionExecutable),
    "预构建 Safari 扩展可执行文件",
  );
  await run("codesign", ["--verify", "--strict", "--verbose=2", destinationAppex]);
  await requireExactSignedEntitlements(
    destinationAppex,
    architectures,
    ["com.apple.security.app-sandbox"],
    "预构建 Safari 扩展",
  );
  await replacePlistValue(
    join(appPath, "Contents", "Info.plist"),
    "OurChoiceSafariExtensionBundleIdentifier",
    extensionBundleIdentifier,
  );
  return destinationAppex;
}

async function signCandidateAdHoc(appPath, nodePath) {
  const nodeEntitlements = join(root, "macos", "App", "Node.entitlements");
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    nodeEntitlements,
    "--sign",
    "-",
    nodePath,
  ]);
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--sign",
    "-",
    appPath,
  ]);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`用法：node scripts/prepare-macos-release.mjs [选项]

  --app <路径>            当前架构开发 App，默认 build/macos/Our Choice.app
  --out <路径>            冻结的 Universal App，默认 build/macos/Our Choice-release-prepared.app
  --manifest <路径>       完整性摘要，默认 build/macos/Our-Choice-release-prepared.integrity.json
  --node-arm64 <路径>     官方 Node 22 arm64 可执行文件
  --node-x64 <路径>       官方 Node 22 x86_64 可执行文件
  --skip-notarization     仅允许开发预检省略 Chrome Web Store ID`);
    return;
  }
  resolvePackagingChromeExtensionID(process.env.OUR_CHOICE_CHROME_EXTENSION_ID, {
    skipNotarization: Boolean(options["skip-notarization"]),
  });
  if (process.platform !== "darwin") throw new Error("macOS 发行候选件只能在 macOS 主机构建。");

  const developerDirectory = (await run("xcode-select", ["-p"])).stdout.trim();
  if (developerDirectory.endsWith("CommandLineTools")) {
    throw new Error("Safari 扩展预构建需要完整 Xcode；当前仅启用了 Command Line Tools。");
  }
  await run("xcodebuild", ["-version"]);

  const sourceApp = absolutePath(options.app, "build/macos/Our Choice.app");
  const outputApp = absolutePath(options.out, "build/macos/Our Choice-release-prepared.app");
  const manifestPath = absolutePath(
    options.manifest,
    "build/macos/Our-Choice-release-prepared.integrity.json",
  );
  if (sourceApp === outputApp) throw new Error("发行候选输出不得覆盖开发 App。");
  await requirePath(join(sourceApp, "Contents", "Info.plist"), "找不到开发 App；请先运行 mac:build。");

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-release-prepare-"));
  const stagingApp = `${outputApp}.staging-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(outputApp), { recursive: true });
    await rm(stagingApp, { recursive: true, force: true });
    await cp(sourceApp, stagingApp, { recursive: true, verbatimSymlinks: true });
    await compileUniversalApp(stagingApp, workDirectory);
    const nodePath = await installUniversalNode(stagingApp, options, workDirectory);
    const appPlist = join(stagingApp, "Contents", "Info.plist");
    const bundleIdentifier = await plistValue(appPlist, "CFBundleIdentifier");
    const version = await plistValue(appPlist, "CFBundleShortVersionString");
    const buildVersion = await plistValue(appPlist, "CFBundleVersion");
    const safariResources = absolutePath(
      options["safari-resources"],
      join(stagingApp, "Contents", "Resources", "browser-extension", "safari"),
    );
    await requirePath(join(safariResources, "manifest.json"), "发行候选 App 缺少 Safari 共源资源。");
    const appexPath = await buildSafariExtension({
      appPath: stagingApp,
      bundleIdentifier,
      version,
      buildVersion,
      workDirectory,
      safariResources,
    });
    await signCandidateAdHoc(stagingApp, nodePath);
    const mainExecutable = join(stagingApp, "Contents", "MacOS", "Our Choice");
    const appexPlist = join(appexPath, "Contents", "Info.plist");
    const appexExecutable = join(
      appexPath,
      "Contents",
      "MacOS",
      await plistValue(appexPlist, "CFBundleExecutable"),
    );
    const appArchitectures = await requireUniversal(mainExecutable, "发行候选主应用可执行文件");
    const nodeArchitectures = await requireUniversal(nodePath, "发行候选内置 Node");
    const appexArchitectures = await requireUniversal(
      appexExecutable,
      "发行候选 Safari 扩展可执行文件",
    );
    await requireExactSignedEntitlements(stagingApp, appArchitectures, [], "发行候选主应用");
    await requireExactSignedEntitlements(
      nodePath,
      nodeArchitectures,
      [
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
      ],
      "发行候选内置 Node",
    );
    await requireExactSignedEntitlements(
      appexPath,
      appexArchitectures,
      ["com.apple.security.app-sandbox"],
      "发行候选 Safari 扩展",
    );
    await run(process.execPath, [join(root, "scripts", "smoke-macos-runtime.mjs"), stagingApp]);

    await rm(outputApp, { recursive: true, force: true });
    await rename(stagingApp, outputApp);
    const manifest = await writeReleaseCandidateManifest(outputApp, manifestPath);
    console.log(JSON.stringify({
      app: outputApp,
      manifest: manifestPath,
      files: manifest.entries.length,
      treeSha256: manifest.treeSha256,
      architectures: ["arm64", "x86_64"],
      signing: "ad-hoc preparation only",
    }, null, 2));
  } finally {
    await rm(stagingApp, { recursive: true, force: true });
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mac:prepare-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
