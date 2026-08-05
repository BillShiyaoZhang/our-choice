#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MINIMUM_MACOS_VERSION,
  validatePayloadMinimumSystemVersions,
} from "./macos-distribution-validation.mjs";
import { resolvePackagingChromeExtensionID } from "./macos-chrome-registration.mjs";
import { verifyReleaseCandidateManifest } from "./macos-release-candidate.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeWebStoreUpdateURL = "https://clients2.google.com/service/update2/crx";

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
  const booleanOptions = new Set(["help", "skip-notarization", "manual-chrome-install"]);
  const valueOptions = new Set([
    "app",
    "manifest",
    "out",
    "app-identity",
    "installer-identity",
    "team-id",
    "notary-profile",
    "notary-key",
    "notary-key-id",
    "notary-issuer",
    // Accepted by the release wrapper and consumed during candidate preparation.
    "node-arm64",
    "node-x64",
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

export function defaultOutputPackage({ skipNotarization }) {
  return join(
    root,
    "build",
    "macos",
    skipNotarization ? "Our-Choice-signed-unnotarized.pkg" : "Our-Choice.pkg",
  );
}

export function stagingPackagePath(
  outputPackage,
  { processID = process.pid, timestamp = Date.now() } = {},
) {
  const outputName = basename(outputPackage);
  const packageStem = outputName.replace(/\.pkg$/i, "");
  return join(
    dirname(outputPackage),
    `.${packageStem}.staging-${processID}-${timestamp}.pkg`,
  );
}

export function validateOutputPackagePath(outputPackage, { skipNotarization }) {
  if (
    skipNotarization
    && basename(outputPackage) !== "Our-Choice-signed-unnotarized.pkg"
  ) {
    throw new Error(
      "--skip-notarization 的输出文件名必须精确为 Our-Choice-signed-unnotarized.pkg。",
    );
  }
  return outputPackage;
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

export async function copyVerifiedReleaseCandidate(sourceApp, signingApp, manifestPath) {
  await mkdir(dirname(signingApp), { recursive: true, mode: 0o700 });
  await cp(sourceApp, signingApp, { recursive: true, verbatimSymlinks: true });
  await verifyReleaseCandidateManifest(signingApp, manifestPath);
  return signingApp;
}

async function createDirectoryChain(rootDirectory, components) {
  let directory = rootDirectory;
  for (const component of components) {
    directory = join(directory, component);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
  }
  return directory;
}

async function plistValue(plist, key) {
  const { stdout } = await run("plutil", ["-extract", key, "raw", "-o", "-", plist]);
  return stdout.trim();
}

async function signApplication({ appPath, nodePath, appexPath, applicationIdentity }) {
  const nodeEntitlements = join(root, "macos", "App", "Node.entitlements");
  const safariEntitlements = join(root, "macos", "App", "SafariExtension.entitlements");
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    nodeEntitlements,
    "--sign",
    applicationIdentity,
    nodePath,
  ]);

  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    safariEntitlements,
    "--sign",
    applicationIdentity,
    appexPath,
  ]);
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    applicationIdentity,
    appPath,
  ]);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

async function buildInstallerPayload({
  appPath,
  destinationPackage,
  bundleIdentifier,
  version,
  installerIdentity,
  chromeExtensionID,
  workDirectory,
}) {
  const payloadRoot = join(workDirectory, "payload");
  const applicationsDirectory = await createDirectoryChain(payloadRoot, ["Applications"]);
  await cp(appPath, join(applicationsDirectory, "Our Choice.app"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const payloadApp = join(applicationsDirectory, "Our Choice.app");
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", payloadApp]);
  const payloadAppex = join(
    payloadApp,
    "Contents",
    "PlugIns",
    "Our Choice Safari Extension.appex",
  );
  const appMinimumSystemVersion = await plistValue(
    join(payloadApp, "Contents", "Info.plist"),
    "LSMinimumSystemVersion",
  );
  const appexMinimumSystemVersion = await plistValue(
    join(payloadAppex, "Contents", "Info.plist"),
    "LSMinimumSystemVersion",
  );
  validatePayloadMinimumSystemVersions({
    appMinimumSystemVersion,
    appexMinimumSystemVersion,
    distributionMinimumSystemVersion: MINIMUM_MACOS_VERSION,
    label: "正式 Payload",
  });

  if (chromeExtensionID) {
    const externalExtensionsDirectory = await createDirectoryChain(payloadRoot, [
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "External Extensions",
    ]);
    const externalPreference = join(externalExtensionsDirectory, `${chromeExtensionID}.json`);
    await writeFile(externalPreference, `${JSON.stringify({
      external_update_url: chromeWebStoreUpdateURL,
    }, null, 2)}\n`, { mode: 0o644 });
    await chmod(externalPreference, 0o644);
    console.log("PKG 将注册 Chrome Web Store 扩展；Chrome 仍会要求用户确认启用。");
  } else {
    console.log("Chrome manual 模式：PKG 只在 App 内携带可手动加载的 Chrome/Edge 扩展资源。");
  }

  const componentPackage = join(workDirectory, "OurChoice-component.pkg");
  const componentPlist = join(workDirectory, "OurChoice-components.plist");
  await run("pkgbuild", ["--analyze", "--root", payloadRoot, componentPlist]);
  await run("plutil", [
    "-replace",
    "0.BundleIsRelocatable",
    "-bool",
    "NO",
    componentPlist,
  ]);
  await run("pkgbuild", [
    "--root",
    payloadRoot,
    "--identifier",
    `${bundleIdentifier}.installer.component`,
    "--version",
    version,
    "--install-location",
    "/",
    "--ownership",
    "recommended",
    "--component-plist",
    componentPlist,
    componentPackage,
  ]);

  await mkdir(dirname(destinationPackage), { recursive: true });
  await rm(destinationPackage, { force: true });
  const productRequirements = join(workDirectory, "OurChoice-product-requirements.plist");
  await writeFile(productRequirements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>arch</key>
  <array>
    <string>x86_64</string>
    <string>arm64</string>
  </array>
  <key>os</key>
  <array><string>${MINIMUM_MACOS_VERSION}</string></array>
</dict>
</plist>
`, "utf8");
  await run("productbuild", [
    "--product",
    productRequirements,
    "--package",
    componentPackage,
    "--sign",
    installerIdentity,
    destinationPackage,
  ]);
}

function resolveNotarizationCredentials(options) {
  if (options["skip-notarization"]) return null;

  const profile = options["notary-profile"] ?? process.env.OUR_CHOICE_NOTARY_PROFILE;
  const keyPathValue = options["notary-key"] ?? process.env.OUR_CHOICE_NOTARY_KEY_PATH;
  const keyID = options["notary-key-id"] ?? process.env.OUR_CHOICE_NOTARY_KEY_ID;
  const issuerID = options["notary-issuer"] ?? process.env.OUR_CHOICE_NOTARY_ISSUER_ID;
  const directKeyValues = [keyPathValue, keyID];
  const hasAnyDirectValue = [...directKeyValues, issuerID].some(Boolean);
  const hasAllDirectKeyValues = directKeyValues.every(Boolean);

  if (hasAnyDirectValue && !hasAllDirectKeyValues) {
    throw new Error(
      "App Store Connect API 公证必须同时提供 OUR_CHOICE_NOTARY_KEY_PATH 与 OUR_CHOICE_NOTARY_KEY_ID；Team API Key 另需 issuer，Individual API Key 不得提供 issuer。",
    );
  }
  if (profile && hasAllDirectKeyValues) {
    throw new Error("OUR_CHOICE_NOTARY_PROFILE 与 App Store Connect API key 公证方式只能二选一。");
  }
  if (profile) return { type: "profile", profile };
  if (hasAllDirectKeyValues) {
    return {
      type: "api-key",
      keyPath: absolutePath(keyPathValue),
      keyID,
      issuerID,
    };
  }
  throw new Error(
    "正式 PKG 必须配置 OUR_CHOICE_NOTARY_PROFILE 或完整的 App Store Connect API key；如仅做本地验证，必须显式传入 --skip-notarization。",
  );
}

export function redactNotarizationDiagnostic(value, credentials = {}) {
  let redacted = String(value ?? "");
  for (const secret of [
    credentials.keyPath,
    credentials.keyID,
    credentials.issuerID,
    credentials.profile,
  ]) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted.replace(/[^\s"']*AuthKey_[^\s"']*\.p8/gi, "[REDACTED_KEY]");
}

function diagnosticPaths(packagePath) {
  const base = packagePath.toLowerCase().endsWith(".pkg")
    ? packagePath.slice(0, -4)
    : packagePath;
  return {
    resultPath: `${base}.notary.json`,
    logPath: `${base}.notary-log.json`,
  };
}

export async function writeRedactedJSON(path, value, credentials) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, redactNotarizationDiagnostic(serialized, credentials), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function collectPrivateNotarizationLog({
  workDirectory,
  diagnosticPath,
  credentials,
  fetchLog,
}) {
  const rawDirectory = await mkdtemp(join(workDirectory, "notary-raw-log-"));
  await chmod(rawDirectory, 0o700);
  const rawPath = join(rawDirectory, "notary-log.json");
  try {
    try {
      await fetchLog(rawPath);
    } catch (error) {
      await writeRedactedJSON(diagnosticPath, {
        status: "LogCommandFailed",
        message: error instanceof Error ? error.message : String(error),
        exitCode: typeof error?.code === "number" ? error.code : null,
        signal: typeof error?.signal === "string" ? error.signal : null,
        stdout: error?.stdout,
        stderr: error?.stderr,
      }, credentials);
      throw new Error(`notarytool log failed；脱敏诊断已写入 ${diagnosticPath}`);
    }

    let rawContents;
    try {
      rawContents = await readFile(rawPath, "utf8");
      const result = JSON.parse(rawContents);
      await writeRedactedJSON(diagnosticPath, result, credentials);
      return result;
    } catch (error) {
      await writeRedactedJSON(diagnosticPath, {
        status: "UnparseableLog",
        message: error instanceof Error ? error.message : String(error),
        raw: rawContents,
      }, credentials);
      throw new Error(
        `无法解析 Apple 公证日志：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    await rm(rawDirectory, { recursive: true, force: true });
  }
}

async function notarizePackage(packagePath, credentials, diagnosticPackagePath, workDirectory) {
  const authentication = credentials.type === "profile"
    ? ["--keychain-profile", credentials.profile]
    : [
        "--key",
        credentials.keyPath,
        "--key-id",
        credentials.keyID,
        ...(credentials.issuerID ? ["--issuer", credentials.issuerID] : []),
      ];
  const { resultPath, logPath } = diagnosticPaths(diagnosticPackagePath);
  await rm(resultPath, { force: true });
  await rm(logPath, { force: true });

  let submission;
  try {
    submission = await run("xcrun", [
      "notarytool",
      "submit",
      packagePath,
      ...authentication,
      "--no-s3-acceleration",
      "--wait",
      "--timeout",
      "45m",
      "--output-format",
      "json",
    ]);
  } catch (error) {
    const submissionFailure = {
      status: "CommandFailed",
      message: redactNotarizationDiagnostic(
        error instanceof Error ? error.message : String(error),
        credentials,
      ),
      exitCode: typeof error?.code === "number" ? error.code : null,
      signal: typeof error?.signal === "string" ? error.signal : null,
      stdout: redactNotarizationDiagnostic(error?.stdout, credentials),
      stderr: redactNotarizationDiagnostic(error?.stderr, credentials),
    };
    await writeRedactedJSON(resultPath, submissionFailure, credentials);
    throw new Error(`notarytool submit failed；脱敏诊断已写入 ${resultPath}`);
  }

  let result;
  try {
    result = JSON.parse(submission.stdout);
  } catch (error) {
    await writeRedactedJSON(resultPath, {
      status: "UnparseableOutput",
      message: error instanceof Error ? error.message : String(error),
      stdout: submission.stdout,
      stderr: submission.stderr,
    }, credentials);
    throw new Error(
      `无法解析 notarytool 结果：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await writeRedactedJSON(resultPath, result, credentials);
  if (!result.id) throw new Error("notarytool 没有返回 submission ID。");
  const notaryLog = await collectPrivateNotarizationLog({
    workDirectory,
    diagnosticPath: logPath,
    credentials,
    fetchLog: async (rawPath) => {
      await run("xcrun", [
        "notarytool",
        "log",
        result.id,
        rawPath,
        ...authentication,
      ]);
    },
  });
  const issues = Array.isArray(notaryLog.issues) ? notaryLog.issues : [];
  const errorIssues = issues.filter((issue) => String(issue?.severity).toLowerCase() === "error");
  if (result.status !== "Accepted" || errorIssues.length > 0) {
    throw new Error(`Apple 公证未通过：${result.status ?? "未知状态"}（${result.id}）`);
  }
  await run("xcrun", ["stapler", "staple", packagePath]);
  await run("xcrun", ["stapler", "validate", packagePath]);
  return {
    id: result.id,
    resultPath,
    logPath,
    issueCount: issues.length,
  };
}

async function runStructuralVerifier({
  packagePath,
  chromeExtensionID,
  developmentTeam,
  manualChromeInstall,
}) {
  const verifierArguments = [
    join(root, "scripts", "verify-macos-package.mjs"),
    packagePath,
    "--allow-unnotarized",
    "--defer-runtime-smoke",
  ];
  if (manualChromeInstall) verifierArguments.push("--manual-chrome-install");
  await run(process.execPath, verifierArguments, {
    env: {
      ...toolEnvironment(),
      ...(chromeExtensionID ? { OUR_CHOICE_CHROME_EXTENSION_ID: chromeExtensionID } : {}),
      OUR_CHOICE_DEVELOPMENT_TEAM: developmentTeam,
    },
  });
}

export async function promotePackage(stagingPackage, outputPackage) {
  await rename(stagingPackage, outputPackage);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(`用法：node scripts/package-macos.mjs [选项]

  --app <路径>                冻结的 Universal App，默认 build/macos/Our Choice-release-prepared.app
  --manifest <路径>           候选件完整性摘要
  --out <PKG>                 正式默认 build/macos/Our-Choice.pkg
  --app-identity <名称>       Developer ID Application
  --installer-identity <名称> Developer ID Installer
  --team-id <ID>              Apple Developer Team ID
  --notary-profile <名称>     notarytool keychain profile
  --notary-key <路径>         App Store Connect API .p8
  --notary-key-id <ID>        App Store Connect API key ID
  --notary-issuer <ID>        Team API Key 的 issuer ID；Individual key 不传
  --manual-chrome-install     不写入 Chrome External Extensions，携带手动安装副本
  --skip-notarization         生成 Our-Choice-signed-unnotarized.pkg；不得发布`);
    return;
  }

  const skipNotarization = Boolean(options["skip-notarization"]);
  const configuredChromeExtensionID = process.env.OUR_CHOICE_CHROME_EXTENSION_ID;
  const manualChromeInstall = Boolean(options["manual-chrome-install"])
    || !configuredChromeExtensionID;
  const chromeExtensionID = resolvePackagingChromeExtensionID(
    configuredChromeExtensionID,
    { manualChromeInstall },
  );
  if (process.platform !== "darwin") throw new Error("PKG 只能在 macOS 主机上构建。");

  const preparedApp = absolutePath(options.app, "build/macos/Our Choice-release-prepared.app");
  const manifestPath = absolutePath(
    options.manifest,
    "build/macos/Our-Choice-release-prepared.integrity.json",
  );
  const outputPackage = validateOutputPackagePath(
    absolutePath(
      options.out,
      defaultOutputPackage({ skipNotarization }),
    ),
    { skipNotarization },
  );

  await requirePath(join(preparedApp, "Contents", "Info.plist"), "找不到冻结发行候选 App。");
  await requirePath(manifestPath, "找不到发行候选件完整性摘要；请先运行 mac:prepare-release。");

  const applicationIdentity = options["app-identity"]
    ?? process.env.OUR_CHOICE_APP_SIGN_IDENTITY;
  const installerIdentity = options["installer-identity"]
    ?? process.env.OUR_CHOICE_INSTALLER_SIGN_IDENTITY;
  const developmentTeam = options["team-id"] ?? process.env.OUR_CHOICE_DEVELOPMENT_TEAM;
  if (!applicationIdentity || !installerIdentity || !developmentTeam) {
    throw new Error(
      "正式打包需要 OUR_CHOICE_APP_SIGN_IDENTITY、OUR_CHOICE_INSTALLER_SIGN_IDENTITY 与 OUR_CHOICE_DEVELOPMENT_TEAM。",
    );
  }

  const notarizationCredentials = resolveNotarizationCredentials(options);
  if (notarizationCredentials?.type === "api-key") {
    await requirePath(
      notarizationCredentials.keyPath,
      `找不到 App Store Connect API key：${notarizationCredentials.keyPath}`,
    );
  }

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-package-"));
  await chmod(workDirectory, 0o700);
  await mkdir(dirname(outputPackage), { recursive: true });
  const stagingPackage = stagingPackagePath(outputPackage);
  try {
    const signingApp = join(workDirectory, "Our Choice.app");
    await copyVerifiedReleaseCandidate(preparedApp, signingApp, manifestPath);
    const appInfoPlist = join(signingApp, "Contents", "Info.plist");
    const bundleIdentifier = await plistValue(appInfoPlist, "CFBundleIdentifier");
    const buildVersion = await plistValue(appInfoPlist, "CFBundleVersion");
    const nodePath = join(
      signingApp,
      "Contents",
      "Resources",
      "runtime",
      "node",
      "bin",
      "node",
    );
    const appexPath = join(
      signingApp,
      "Contents",
      "PlugIns",
      "Our Choice Safari Extension.appex",
    );
    await requirePath(nodePath, "冻结发行候选 App 缺少内置 Node。");
    await requirePath(appexPath, "冻结发行候选 App 缺少 Safari .appex。");
    await signApplication({ appPath: signingApp, nodePath, appexPath, applicationIdentity });
    await buildInstallerPayload({
      appPath: signingApp,
      destinationPackage: stagingPackage,
      bundleIdentifier,
      version: buildVersion,
      installerIdentity,
      chromeExtensionID,
      workDirectory,
    });
    await runStructuralVerifier({
      packagePath: stagingPackage,
      chromeExtensionID,
      developmentTeam,
      manualChromeInstall,
    });

    let notarization = null;
    if (!skipNotarization) {
      notarization = await notarizePackage(
        stagingPackage,
        notarizationCredentials,
        outputPackage,
        workDirectory,
      );
    } else {
      console.warn("已显式跳过公证；此 PKG 仅供本地签名预检，不应作为正式发行产物。");
    }

    await promotePackage(stagingPackage, outputPackage);
    const packageStat = await stat(outputPackage);
    console.log(JSON.stringify({
      sourceApp: preparedApp,
      candidateManifest: manifestPath,
      pkg: outputPackage,
      bytes: packageStat.size,
      notarized: !skipNotarization,
      chromeInstallMode: manualChromeInstall ? "manual" : "store",
      runtimeVerified: false,
      finalRuntimeVerificationRequiredAfterCredentialCleanup: true,
      notarySubmission: notarization,
    }, null, 2));
  } finally {
    await rm(stagingPackage, { force: true });
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mac:package] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
