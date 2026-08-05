#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  requireExactDirectoryEntries,
  verifyBomAllowlist,
} from "./macos-payload-validation.mjs";
import {
  MINIMUM_MACOS_VERSION,
  validateMacOSDistributionRequirements,
  validatePackageInfoRootAttributes,
  validatePayloadMinimumSystemVersions,
} from "./macos-distribution-validation.mjs";
import { resolveVerifierChromeExtensionID } from "./macos-chrome-registration.mjs";
import {
  MACOS_APP_ICON_FILENAME,
  validateMacOSAppIcon,
} from "./macos-app-icon.mjs";
import {
  hasEnabledEntitlement,
  validateExactEntitlements,
} from "./macos-entitlements-validation.mjs";
import { validateSafariExtensionDisplayMetadata } from "./safari-extension-metadata.mjs";
import { verifySafariAppexResources } from "./safari-extension-resources.mjs";

export { hasEnabledEntitlement };

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeWebStoreUpdateURL = "https://clients2.google.com/service/update2/crx";

export function parseArguments(argv) {
  const options = {
    packagePath: undefined,
    allowUnnotarized: false,
    manualChromeInstall: false,
    deferRuntimeSmoke: false,
    help: false,
  };
  for (const argument of argv) {
    if (argument === "--allow-unnotarized") {
      options.allowUnnotarized = true;
    } else if (argument === "--manual-chrome-install") {
      options.manualChromeInstall = true;
    } else if (argument === "--defer-runtime-smoke") {
      options.deferRuntimeSmoke = true;
    } else if (argument === "--help") {
      options.help = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`未知参数：${argument}`);
    } else if (options.packagePath) {
      throw new Error(`只能验证一个 PKG：${argument}`);
    } else {
      options.packagePath = argument;
    }
  }
  if (options.deferRuntimeSmoke && !options.allowUnnotarized) {
    throw new Error("--defer-runtime-smoke 必须与 --allow-unnotarized 同时使用。");
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
  if (!(await exists(path))) throw new Error(message ?? `${path} 不存在`);
}

async function execute(command, arguments_, options = {}) {
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "TMPDIR", "LANG", "DEVELOPER_DIR"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return run(command, arguments_, {
    cwd: root,
    env: environment,
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
}

async function collectDirectories(directory, predicate) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (predicate(path, entry)) matches.push(path);
    matches.push(...await collectDirectories(path, predicate));
  }
  return matches;
}

async function collectFiles(directory, predicate) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await collectFiles(path, predicate));
    } else if (entry.isFile() && predicate(path, entry)) {
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

async function requireDistributionRequirements(expandedDirectory) {
  const distributionPath = join(expandedDirectory, "Distribution");
  await requirePath(distributionPath, "最终 PKG 缺少 Distribution。");
  const distribution = await readFile(distributionPath, "utf8");
  return validateMacOSDistributionRequirements(distribution, {
    expectedArchitectures: ["x86_64", "arm64"],
    expectedMinimumSystemVersion: MINIMUM_MACOS_VERSION,
    label: "正式 PKG Distribution",
  });
}

async function lipoArchitectures(path) {
  const { stdout } = await execute("xcrun", ["lipo", "-archs", path]);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

async function requireUniversal(path, label) {
  await requirePath(path, `找不到 ${label}：${path}`);
  const architectures = await lipoArchitectures(path);
  for (const architecture of ["arm64", "x86_64"]) {
    if (!architectures.includes(architecture)) {
      throw new Error(`${label} 不是 Universal：缺少 ${architecture}（${path}）`);
    }
  }
  return architectures;
}

async function requireDeveloperIDSignature(path, architectures, label) {
  await execute("codesign", ["--verify", "--strict", "--verbose=2", path]);
  const teamIdentifiers = [];
  for (const architecture of architectures) {
    const display = await execute("codesign", [
      "--display",
      "--arch",
      architecture,
      "--verbose=4",
      path,
    ]);
    const details = `${display.stdout}\n${display.stderr}`;
    const sliceLabel = `${label}（${architecture}）`;
    if (!/Authority=Developer ID Application:/i.test(details) || /Signature=adhoc/i.test(details)) {
      throw new Error(`${sliceLabel} 没有有效的 Developer ID Application 签名。`);
    }
    if (!/flags=.*runtime/im.test(details)) {
      throw new Error(`${sliceLabel} 没有启用 Hardened Runtime。`);
    }
    if (!/^Timestamp=/im.test(details)) {
      throw new Error(`${sliceLabel} 的 Developer ID 签名没有可信时间戳。`);
    }
    const teamIdentifier = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/im)?.[1];
    if (!teamIdentifier) throw new Error(`${sliceLabel} 的签名没有有效 TeamIdentifier。`);
    teamIdentifiers.push(teamIdentifier);
  }
  const [teamIdentifier] = teamIdentifiers;
  if (!teamIdentifiers.every((candidate) => candidate === teamIdentifier)) {
    throw new Error(`${label} 各架构 slice 的 Team ID 不一致。`);
  }
  return teamIdentifier;
}

async function verifyPackageSignature(packagePath) {
  const signature = await execute("pkgutil", ["--check-signature", packagePath]);
  const details = `${signature.stdout}\n${signature.stderr}`;
  if (!/Status:\s+signed by (?:a certificate trusted by (?:macOS|Mac OS X)|a developer certificate issued by Apple for distribution)/i.test(details)) {
    throw new Error("PKG 没有受 macOS 信任的 Installer 签名。");
  }
  if (!/Developer ID Installer:/i.test(details)) {
    throw new Error("PKG 签名不是 Developer ID Installer。");
  }
  if (!/Signed with a trusted timestamp/i.test(details)) {
    throw new Error("PKG 签名没有可信时间戳。");
  }
  const teamIdentifier = details.match(
    /Developer ID Installer:[^\r\n]*\(([A-Z0-9]{10})\)/i,
  )?.[1];
  if (!teamIdentifier) throw new Error("无法从 Installer 签名提取 Team ID。");
  return teamIdentifier;
}

async function locateComponentPayload(expandedDirectory) {
  const packageInfoPath = requireExactlyOne(
    await collectFiles(expandedDirectory, (path) => basename(path) === "PackageInfo"),
    "最终 PKG component 的 PackageInfo",
  );
  const componentDirectory = dirname(packageInfoPath);
  const packageInfo = await readFile(packageInfoPath, "utf8");
  validatePackageInfoRootAttributes(packageInfo, {
    "install-location": "/",
    relocatable: "false",
  }, "正式 PKG component PackageInfo");
  if (await exists(join(componentDirectory, "Scripts"))) {
    throw new Error("最终 PKG 不得包含安装脚本。");
  }
  const payloadRoot = join(componentDirectory, "Payload");
  const bomPath = join(componentDirectory, "Bom");
  await requirePath(payloadRoot, "最终 PKG component 缺少展开后的 Payload。");
  await requirePath(bomPath, "最终 PKG component 缺少 Bom。");
  return { componentDirectory, payloadRoot, bomPath };
}

async function readBomEntries(bomPath) {
  const { stdout } = await execute("lsbom", ["-p", "fMUG", bomPath]);
  const entries = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [rawPath, rawMode, owner, group] = line.split("\t");
    if (!rawPath || !rawMode) continue;
    entries.set(rawPath.replace(/^\.\//, ""), {
      mode: rawMode.trim(),
      owner,
      group,
    });
  }
  return entries;
}

function verifyChromeBom(entries, chromeExtensionID) {

  const chromePathParts = [
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "External Extensions",
  ];
  for (let index = 1; index <= chromePathParts.length; index += 1) {
    const path = chromePathParts.slice(0, index).join("/");
    const entry = entries.get(path);
    assert.ok(entry, `PKG BOM 缺少 Chrome 注册目录：/${path}`);
    assert.equal(entry.mode, "drwxr-xr-x", `Chrome 注册目录权限必须为 0755：/${path}`);
    assert.equal(entry.owner, "root", `Chrome 注册目录必须由 root 所有：/${path}`);
    assert.ok(["wheel", "admin"].includes(entry.group), `Chrome 注册目录组无效：/${path}`);
  }

  const preferencePath = `${chromePathParts.join("/")}/${chromeExtensionID}.json`;
  const preferenceEntry = entries.get(preferencePath);
  assert.ok(preferenceEntry, `PKG BOM 缺少 Chrome 注册文件：/${preferencePath}`);
  assert.equal(preferenceEntry.mode, "-rw-r--r--", "Chrome 注册文件权限必须为 0644 且不能是符号链接。");
  assert.equal(preferenceEntry.owner, "root", "Chrome 注册文件必须由 root 所有。");
  assert.ok(["wheel", "admin"].includes(preferenceEntry.group), "Chrome 注册文件组必须为 wheel 或 admin。");
}

async function entitlementDetails(path, architecture) {
  const result = await execute("codesign", [
    "--display",
    "--arch",
    architecture,
    "--entitlements",
    "-",
    path,
  ]);
  return `${result.stdout}\n${result.stderr}`;
}

async function requireExactSignedEntitlements(path, architectures, entitlementNames, label) {
  for (const architecture of architectures) {
    const details = await entitlementDetails(path, architecture);
    validateExactEntitlements(details, entitlementNames, `${label}（${architecture}）`);
  }
}

async function requireNodeEntitlements(nodeExecutable, architectures) {
  await requireExactSignedEntitlements(
    nodeExecutable,
    architectures,
    [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ],
    "内置 Node",
  );
}

async function verifyExpandedPayload(expandedDirectory, chromeExtensionID) {
  const { hostArchitectures, minimumSystemVersion } = await requireDistributionRequirements(
    expandedDirectory,
  );
  const { payloadRoot, bomPath } = await locateComponentPayload(expandedDirectory);
  const bomEntries = await readBomEntries(bomPath);
  verifyBomAllowlist(bomEntries, chromeExtensionID);
  await requireExactDirectoryEntries(
    payloadRoot,
    chromeExtensionID ? ["Applications", "Library"] : ["Applications"],
    "PKG Payload 顶层",
  );
  await requireExactDirectoryEntries(
    join(payloadRoot, "Applications"),
    ["Our Choice.app"],
    "PKG Applications 目录",
  );
  if (chromeExtensionID) {
    let directory = join(payloadRoot, "Library");
    for (const [entry, label] of [
      ["Application Support", "PKG Library 目录"],
      ["Google", "PKG Application Support 目录"],
      ["Chrome", "PKG Google 目录"],
      ["External Extensions", "PKG Chrome 目录"],
    ]) {
      await requireExactDirectoryEntries(directory, [entry], label);
      directory = join(directory, entry);
    }
    await requireExactDirectoryEntries(
      directory,
      [`${chromeExtensionID}.json`],
      "PKG Chrome External Extensions 目录",
    );
  }
  const appCandidates = await collectDirectories(
    expandedDirectory,
    (path) => basename(path) === "Our Choice.app",
  );
  const appPath = requireExactlyOne(appCandidates, "最终 PKG 中的 Our Choice.app");
  const expectedAppPath = join(payloadRoot, "Applications", "Our Choice.app");
  assert.equal(appPath, expectedAppPath, "主应用必须精确安装到 /Applications/Our Choice.app。 ");
  const appexCandidates = await collectDirectories(
    appPath,
    (path) => path.endsWith(".appex"),
  );
  const appexPath = requireExactlyOne(appexCandidates, "最终 PKG 中的 Safari .appex");
  if (basename(appexPath) !== "Our Choice Safari Extension.appex") {
    throw new Error(`Safari 扩展名称不正确：${basename(appexPath)}`);
  }

  const appPlist = join(appPath, "Contents", "Info.plist");
  const appexPlist = join(appexPath, "Contents", "Info.plist");
  const appExecutable = await plistValue(appPlist, "CFBundleExecutable");
  const appBundleIdentifier = await plistValue(appPlist, "CFBundleIdentifier");
  const appVersion = await plistValue(appPlist, "CFBundleShortVersionString");
  const appBuildVersion = await plistValue(appPlist, "CFBundleVersion");
  const appIconFile = await plistValue(appPlist, "CFBundleIconFile");
  const appMinimumSystemVersion = await plistValue(appPlist, "LSMinimumSystemVersion");
  const configuredExtensionIdentifier = await plistValue(
    appPlist,
    "OurChoiceSafariExtensionBundleIdentifier",
  );
  const appexExecutable = await plistValue(appexPlist, "CFBundleExecutable");
  const appexBundleIdentifier = await plistValue(appexPlist, "CFBundleIdentifier");
  const appexVersion = await plistValue(appexPlist, "CFBundleShortVersionString");
  const appexBuildVersion = await plistValue(appexPlist, "CFBundleVersion");
  const appexMinimumSystemVersion = await plistValue(appexPlist, "LSMinimumSystemVersion");
  const appexDisplayName = await plistValue(appexPlist, "CFBundleDisplayName");
  const appexName = await plistValue(appexPlist, "CFBundleName");
  const extensionPoint = await plistValue(
    appexPlist,
    "NSExtension.NSExtensionPointIdentifier",
  );

  assert.equal(
    configuredExtensionIdentifier,
    appexBundleIdentifier,
    "主应用记录的 Safari 扩展 Bundle ID 与嵌入扩展不一致。",
  );
  assert.ok(
    appexBundleIdentifier.startsWith(`${appBundleIdentifier}.`),
    "Safari 扩展 Bundle ID 必须使用主应用 Bundle ID 前缀。",
  );
  assert.equal(appexVersion, appVersion, "Safari 扩展营销版本与主应用不一致。");
  assert.equal(appexBuildVersion, appBuildVersion, "Safari 扩展构建版本与主应用不一致。");
  validatePayloadMinimumSystemVersions({
    appMinimumSystemVersion,
    appexMinimumSystemVersion,
    distributionMinimumSystemVersion: minimumSystemVersion,
    expectedMinimumSystemVersion: MINIMUM_MACOS_VERSION,
    label: "正式 Payload",
  });
  validateSafariExtensionDisplayMetadata(appexDisplayName, appexName);
  assert.equal(
    extensionPoint,
    "com.apple.Safari.web-extension",
    "Safari 扩展点不正确。",
  );

  const mainExecutable = join(appPath, "Contents", "MacOS", appExecutable);
  const nodeExecutable = join(
    appPath,
    "Contents",
    "Resources",
    "runtime",
    "node",
    "bin",
    "node",
  );
  const extensionExecutable = join(appexPath, "Contents", "MacOS", appexExecutable);
  const appArchitectures = await requireUniversal(mainExecutable, "主应用可执行文件");
  const nodeArchitectures = await requireUniversal(nodeExecutable, "内置 Node");
  const extensionArchitectures = await requireUniversal(
    extensionExecutable,
    "Safari 扩展可执行文件",
  );

  await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const appTeamIdentifier = await requireDeveloperIDSignature(
    appPath,
    appArchitectures,
    "主应用",
  );
  const extensionTeamIdentifier = await requireDeveloperIDSignature(
    appexPath,
    extensionArchitectures,
    "Safari 扩展",
  );
  const nodeTeamIdentifier = await requireDeveloperIDSignature(
    nodeExecutable,
    nodeArchitectures,
    "内置 Node",
  );
  assert.equal(extensionTeamIdentifier, appTeamIdentifier, "Safari 扩展与主应用 Team ID 不一致。");
  assert.equal(nodeTeamIdentifier, appTeamIdentifier, "内置 Node 与主应用 Team ID 不一致。");
  await requireExactSignedEntitlements(
    appexPath,
    extensionArchitectures,
    ["com.apple.security.app-sandbox"],
    "Safari 扩展",
  );
  await requireNodeEntitlements(nodeExecutable, nodeArchitectures);
  await requireExactSignedEntitlements(
    appPath,
    appArchitectures,
    [],
    "正式主应用",
  );

  const resources = join(appPath, "Contents", "Resources");
  assert.equal(appIconFile, MACOS_APP_ICON_FILENAME, "主应用图标引用不正确。");
  validateMacOSAppIcon(
    await readFile(join(resources, appIconFile)),
    "正式 PKG 主应用图标",
  );
  await requirePath(join(resources, "runtime", "server.mjs"), "最终 App 缺少桌面服务器。");
  await requirePath(join(resources, "runtime", "web", "dist"), "最终 App 缺少网站产物。");
  const chromeManifestPath = join(resources, "browser-extension", "chrome", "manifest.json");
  const safariManifestPath = join(resources, "browser-extension", "safari", "manifest.json");
  await requirePath(chromeManifestPath, "最终 App 缺少 Chrome 扩展资源。");
  await requirePath(safariManifestPath, "最终 App 缺少 Safari 扩展资源。");
  const [chromeManifest, safariManifest] = await Promise.all([
    readFile(chromeManifestPath, "utf8").then(JSON.parse),
    readFile(safariManifestPath, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(safariManifest, chromeManifest, "Chrome 与 Safari 扩展资源不是同一版本。");
  await verifySafariAppexResources({
    sourceRoot: join(resources, "browser-extension", "safari"),
    appexPath,
  });

  let chromeRegistered = false;
  if (chromeExtensionID) {
    const preferencePath = join(
      payloadRoot,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "External Extensions",
      `${chromeExtensionID}.json`,
    );
    await requirePath(preferencePath, "最终 PKG 缺少精确路径下的 Chrome 外部注册文件。");
    const preference = JSON.parse(await readFile(preferencePath, "utf8"));
    assert.deepEqual(preference, {
      external_update_url: chromeWebStoreUpdateURL,
    }, "Chrome 外部注册文件内容不正确。");
    verifyChromeBom(bomEntries, chromeExtensionID);
    chromeRegistered = true;
  }

  return {
    app: appPath,
    appex: appexPath,
    bundleIdentifier: appBundleIdentifier,
    extensionBundleIdentifier: appexBundleIdentifier,
    version: appVersion,
    buildVersion: appBuildVersion,
    appIcon: appIconFile,
    hostArchitectures,
    minimumSystemVersion,
    teamIdentifier: appTeamIdentifier,
    chromeRegistered,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "用法：node scripts/verify-macos-package.mjs [PKG] [--allow-unnotarized] [--manual-chrome-install] [--defer-runtime-smoke]",
    );
    return;
  }
  const chromeExtensionID = resolveVerifierChromeExtensionID(
    process.env.OUR_CHOICE_CHROME_EXTENSION_ID,
    options,
  );
  if (process.platform !== "darwin") throw new Error("macOS PKG 只能在 macOS 主机上验证。");

  const packagePath = absolutePath(options.packagePath ?? "build/macos/Our-Choice.pkg");
  await requirePath(packagePath, `找不到待验证的 PKG：${packagePath}`);
  const installerTeamIdentifier = await verifyPackageSignature(packagePath);

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-verify-package-"));
  try {
    const expandedDirectory = join(workDirectory, "expanded");
    await execute("pkgutil", ["--expand-full", packagePath, expandedDirectory]);
    const payload = await verifyExpandedPayload(expandedDirectory, chromeExtensionID);
    assert.equal(
      payload.teamIdentifier,
      installerTeamIdentifier,
      "Developer ID Installer 与应用签名 Team ID 不一致。",
    );
    if (process.env.OUR_CHOICE_DEVELOPMENT_TEAM) {
      assert.equal(
        payload.teamIdentifier,
        process.env.OUR_CHOICE_DEVELOPMENT_TEAM,
        "最终 PKG 的 Team ID 与 OUR_CHOICE_DEVELOPMENT_TEAM 不一致。",
      );
    }
    if (!options.deferRuntimeSmoke) {
      await execute(process.execPath, [
        join(root, "scripts", "smoke-macos-runtime.mjs"),
        payload.app,
      ]);
    }

    if (!options.allowUnnotarized) {
      await execute("xcrun", ["stapler", "validate", packagePath]);
      await execute("spctl", ["--assess", "--type", "install", "--verbose=4", packagePath]);
    }

    console.log(JSON.stringify({
      pkg: packagePath,
      notarized: !options.allowUnnotarized,
      chromeInstallMode: options.manualChromeInstall ? "manual" : "store",
      runtimeVerified: !options.deferRuntimeSmoke,
      ...payload,
    }, null, 2));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mac:verify-package] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
