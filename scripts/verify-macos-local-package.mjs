#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import {
  MACOS_APP_ICON_FILENAME,
  validateMacOSAppIcon,
} from "./macos-app-icon.mjs";
import { validateSafariExtensionDisplayMetadata } from "./safari-extension-metadata.mjs";
import { verifySafariAppexResources } from "./safari-extension-resources.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPackageName = "Our-Choice-local-unsigned.pkg";

function parseArguments(argv) {
  if (argv.includes("--help")) return { help: true, packagePath: undefined };
  if (argv.some((argument) => argument.startsWith("--"))) {
    throw new Error("本机 PKG 验证器不接受降级或发行模式参数。");
  }
  if (argv.length > 1) throw new Error("只能验证一个本机测试 PKG。");
  return { help: false, packagePath: argv[0] };
}

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function currentProductArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持在 ${process.arch} 架构上验证本机测试 PKG。`);
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

async function requireUnsignedPackage(packagePath) {
  let details = "";
  let exitCode = 0;
  try {
    const result = await execute("pkgutil", ["--check-signature", packagePath]);
    details = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    exitCode = typeof error?.code === "number" ? error.code : -1;
    details = `${error?.stdout ?? ""}\n${error?.stderr ?? error?.message ?? ""}`;
  }
  assert.equal(exitCode, 1, "unsigned PKG 的 pkgutil --check-signature 应以状态 1 结束。");
  assert.match(details, /Status:\s+no signature/i, "PKG 必须明确为 unsigned。 ");
  assert.doesNotMatch(details, /Developer ID Installer:/i, "本机测试 PKG 不得带正式 Installer 签名。");
}

async function readBomEntries(bomPath) {
  const { stdout } = await execute("lsbom", ["-p", "fMUG", bomPath]);
  const entries = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [rawPath, rawMode, owner, group] = line.split("\t");
    if (!rawPath || !rawMode) continue;
    const path = rawPath.replace(/^\.\//, "");
    if (entries.has(path)) throw new Error(`PKG BOM 含重复路径：/${path}`);
    entries.set(path, { mode: rawMode.trim(), owner, group });
  }
  return entries;
}

async function architectures(path) {
  const { stdout } = await execute("xcrun", ["lipo", "-archs", path]);
  return stdout.trim().split(/\s+/).filter(Boolean);
}

async function requireOnlyArchitecture(path, expected, label) {
  const found = await architectures(path);
  assert.deepEqual(found, [expected], `${label} 必须只包含当前架构 ${expected}。`);
  return found;
}

async function requireUniversal(path, label) {
  const found = await architectures(path);
  for (const architecture of ["arm64", "x86_64"]) {
    assert.ok(found.includes(architecture), `${label} 不是 Universal：缺少 ${architecture}。`);
  }
  return found;
}

async function requireAdHocSignature(path, label, architectures_) {
  await execute("codesign", ["--verify", "--strict", "--verbose=2", path]);
  for (const architecture of architectures_) {
    const display = await execute("codesign", [
      "--display",
      "--arch",
      architecture,
      "--verbose=4",
      path,
    ]);
    const details = `${display.stdout}\n${display.stderr}`;
    const architectureLabel = `${label} (${architecture})`;
    assert.match(details, /^Signature=adhoc$/im, `${architectureLabel} 必须是 Signature=adhoc。`);
    assert.match(details, /^TeamIdentifier=not set$/im, `${architectureLabel} 不得含 TeamIdentifier。`);
    const flags = details.match(/^CodeDirectory[^\r\n]*flags=[^(]*\(([^)]*)\)/im)?.[1]
      ?.split(",")
      .map((value) => value.trim()) ?? [];
    assert.ok(flags.includes("adhoc"), `${architectureLabel} 签名 flags 缺少 adhoc。`);
    assert.ok(flags.includes("runtime"), `${architectureLabel} 签名 flags 缺少 Hardened Runtime。`);
    assert.doesNotMatch(details, /^Authority=/im, `${architectureLabel} 不得伪装成 Developer ID。`);
    assert.doesNotMatch(details, /^Timestamp=/im, `${architectureLabel} 不得带正式可信时间戳。`);
  }
}

async function requireBooleanEntitlements(path, names, label, architectures_) {
  for (const architecture of architectures_) {
    const result = await execute("codesign", [
      "--display",
      "--arch",
      architecture,
      "--entitlements",
      "-",
      path,
    ]);
    const details = `${result.stdout}\n${result.stderr}`;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const xml = new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`);
      const display = new RegExp(
        `\\[Key\\][\\t ]+${escaped}[\\t ]*\\r?\\n`
          + `(?:[\\t ]*\\[Value\\][\\t ]*\\r?\\n)?`
          + `[\\t ]*\\[Bool\\][\\t ]+true[\\t ]*(?:\\r?\\n|$)`,
      );
      assert.ok(
        xml.test(details) || display.test(details),
        `${label} (${architecture}) 缺少 entitlement：${name}`,
      );
    }
  }
}

export function validateLocalDistributionRequirements(distribution, expectedArchitecture) {
  return validateMacOSDistributionRequirements(distribution, {
    expectedArchitectures: [expectedArchitecture],
    label: "本机 PKG Distribution",
  });
}

export function validateLocalAppMinimumSystemVersion(
  appMinimumSystemVersion,
  distributionMinimumSystemVersion,
  appexMinimumSystemVersion = appMinimumSystemVersion,
) {
  return validatePayloadMinimumSystemVersions({
    appMinimumSystemVersion,
    appexMinimumSystemVersion,
    distributionMinimumSystemVersion,
    expectedMinimumSystemVersion: MINIMUM_MACOS_VERSION,
    label: "最终 Payload",
  });
}

async function requireDistributionRequirements(expandedDirectory, expectedArchitecture) {
  const distributionPath = join(expandedDirectory, "Distribution");
  await requirePath(distributionPath, "本机 PKG 缺少最终 Distribution。");
  const distribution = await readFile(distributionPath, "utf8");
  return validateLocalDistributionRequirements(distribution, expectedArchitecture);
}

async function verifyExpandedPackage(expandedDirectory, expectedArchitecture) {
  const { hostArchitectures, minimumSystemVersion } = await requireDistributionRequirements(
    expandedDirectory,
    expectedArchitecture,
  );
  const packageInfoPath = requireExactlyOne(
    await collectFiles(expandedDirectory, (path) => basename(path) === "PackageInfo"),
    "本机 PKG component 的 PackageInfo",
  );
  const componentDirectory = dirname(packageInfoPath);
  const packageInfo = await readFile(packageInfoPath, "utf8");
  const packageInfoAttributes = validatePackageInfoRootAttributes(packageInfo, {
    "install-location": "/",
    relocatable: "false",
  }, "本机 PKG component PackageInfo");
  assert.ok(
    packageInfoAttributes.get("identifier")?.endsWith(".installer.local.component"),
    "本机 PKG 必须使用 installer.local.component 专属 ID。",
  );
  assert.equal(await exists(join(componentDirectory, "Scripts")), false, "本机 PKG 禁止安装脚本。");

  const payloadRoot = join(componentDirectory, "Payload");
  const bomPath = join(componentDirectory, "Bom");
  await requirePath(payloadRoot, "本机 PKG 缺少展开后的 Payload。");
  await requirePath(bomPath, "本机 PKG 缺少 Bom。");
  await requireExactDirectoryEntries(payloadRoot, ["Applications"], "本机 PKG Payload 顶层");
  await requireExactDirectoryEntries(
    join(payloadRoot, "Applications"),
    ["Our Choice.app"],
    "本机 PKG Applications 目录",
  );
  const bomEntries = await readBomEntries(bomPath);
  verifyBomAllowlist(bomEntries);

  const appPath = join(payloadRoot, "Applications", "Our Choice.app");
  const appCandidates = await collectDirectories(
    expandedDirectory,
    (path) => basename(path) === "Our Choice.app",
  );
  assert.equal(requireExactlyOne(appCandidates, "本机 PKG 中的 Our Choice.app"), appPath);
  const appexPath = requireExactlyOne(
    await collectDirectories(appPath, (path) => path.endsWith(".appex")),
    "本机 PKG 中的 Safari .appex",
  );
  assert.equal(basename(appexPath), "Our Choice Safari Extension.appex");

  const appPlist = join(appPath, "Contents", "Info.plist");
  const appexPlist = join(appexPath, "Contents", "Info.plist");
  const appExecutable = await plistValue(appPlist, "CFBundleExecutable");
  const appIdentifier = await plistValue(appPlist, "CFBundleIdentifier");
  const appVersion = await plistValue(appPlist, "CFBundleShortVersionString");
  const appBuildVersion = await plistValue(appPlist, "CFBundleVersion");
  const appIconFile = await plistValue(appPlist, "CFBundleIconFile");
  const appMinimumSystemVersion = await plistValue(appPlist, "LSMinimumSystemVersion");
  const configuredExtensionIdentifier = await plistValue(
    appPlist,
    "OurChoiceSafariExtensionBundleIdentifier",
  );
  const appexExecutable = await plistValue(appexPlist, "CFBundleExecutable");
  const appexIdentifier = await plistValue(appexPlist, "CFBundleIdentifier");
  const appexMinimumSystemVersion = await plistValue(appexPlist, "LSMinimumSystemVersion");
  validateLocalAppMinimumSystemVersion(
    appMinimumSystemVersion,
    minimumSystemVersion,
    appexMinimumSystemVersion,
  );
  const appexDisplayName = await plistValue(appexPlist, "CFBundleDisplayName");
  const appexName = await plistValue(appexPlist, "CFBundleName");
  assert.equal(configuredExtensionIdentifier, appexIdentifier);
  assert.ok(appexIdentifier.startsWith(`${appIdentifier}.`));
  assert.equal(await plistValue(appexPlist, "CFBundleShortVersionString"), appVersion);
  assert.equal(await plistValue(appexPlist, "CFBundleVersion"), appBuildVersion);
  validateSafariExtensionDisplayMetadata(appexDisplayName, appexName);
  assert.equal(
    await plistValue(appexPlist, "NSExtension.NSExtensionPointIdentifier"),
    "com.apple.Safari.web-extension",
  );
  assert.equal(
    packageInfoAttributes.get("identifier"),
    `${appIdentifier}.installer.local.component`,
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
  const mainArchitectures = await requireOnlyArchitecture(
    mainExecutable,
    expectedArchitecture,
    "本机主应用",
  );
  const nodeArchitectures = await requireOnlyArchitecture(
    nodeExecutable,
    expectedArchitecture,
    "本机内置 Node",
  );
  const appexArchitectures = await requireUniversal(extensionExecutable, "本机 Safari 扩展");

  await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await requireAdHocSignature(appPath, "本机主应用", mainArchitectures);
  await requireAdHocSignature(nodeExecutable, "本机内置 Node", nodeArchitectures);
  await requireAdHocSignature(appexPath, "本机 Safari 扩展", appexArchitectures);
  await requireBooleanEntitlements(nodeExecutable, [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ], "本机内置 Node", nodeArchitectures);
  await requireBooleanEntitlements(appexPath, [
    "com.apple.security.app-sandbox",
    "com.apple.security.get-task-allow",
  ], "本机 Safari 扩展", appexArchitectures);

  const resources = join(appPath, "Contents", "Resources");
  assert.equal(appIconFile, MACOS_APP_ICON_FILENAME, "本机主应用图标引用不正确。");
  validateMacOSAppIcon(
    await readFile(join(resources, appIconFile)),
    "本机 PKG 主应用图标",
  );
  const chromeManifestPath = join(resources, "browser-extension", "chrome", "manifest.json");
  const safariManifestPath = join(resources, "browser-extension", "safari", "manifest.json");
  const [chromeManifest, safariManifest] = await Promise.all([
    readFile(chromeManifestPath, "utf8").then(JSON.parse),
    readFile(safariManifestPath, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(safariManifest, chromeManifest, "本机 PKG 的 Chrome/Safari 共源资源不一致。");
  await verifySafariAppexResources({
    sourceRoot: join(resources, "browser-extension", "safari"),
    appexPath,
  });
  await execute(process.execPath, [join(root, "scripts", "smoke-macos-runtime.mjs"), appPath]);

  return {
    app: appPath,
    appex: appexPath,
    bundleIdentifier: appIdentifier,
    extensionBundleIdentifier: appexIdentifier,
    version: appVersion,
    buildVersion: appBuildVersion,
    appIcon: appIconFile,
    architecture: expectedArchitecture,
    hostArchitectures,
    minimumSystemVersion,
    appexArchitectures,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/verify-macos-local-package.mjs [build/macos/Our-Choice-local-unsigned.pkg]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("本机 PKG 只能在 macOS 上验证。");
  const packagePath = absolutePath(
    options.packagePath ?? "build/macos/Our-Choice-local-unsigned.pkg",
  );
  assert.equal(basename(packagePath), expectedPackageName, "本机 PKG 文件名必须明确标记 local-unsigned。");
  await requirePath(packagePath, `找不到本机测试 PKG：${packagePath}`);
  await requireUnsignedPackage(packagePath);
  const expectedArchitecture = currentProductArchitecture();

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-verify-local-package-"));
  try {
    const expandedDirectory = join(workDirectory, "expanded");
    await execute("pkgutil", ["--expand-full", packagePath, expandedDirectory]);
    const payload = await verifyExpandedPackage(expandedDirectory, expectedArchitecture);
    console.log(JSON.stringify({
      pkg: packagePath,
      packageSigning: "none",
      appSigning: "ad-hoc",
      notarized: false,
      distribution: "local-test",
      ...payload,
    }, null, 2));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mac:verify-package-local] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
