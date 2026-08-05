#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPackage = join(root, "build", "macos", "Our-Choice-local-unsigned.pkg");
const minimumMacOSVersion = "13.0";

function parseArguments(argv) {
  const options = { app: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--app") {
      options.app = argv[++index];
      if (!options.app) throw new Error("参数 --app 缺少路径。");
    } else if (argument.startsWith("--app=")) {
      options.app = argument.slice("--app=".length);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function currentProductArchitecture() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  throw new Error(`不支持为 ${process.arch} 架构生成本机测试 PKG。`);
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

async function plistValue(plist, key) {
  const { stdout } = await execute("plutil", ["-extract", key, "raw", "-o", "-", plist]);
  return stdout.trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/package-macos-local.mjs [--app <开发 App>]\n\n固定输出 build/macos/Our-Choice-local-unsigned.pkg；仅供当前 Mac 测试。");
    return;
  }
  if (process.platform !== "darwin") throw new Error("本机测试 PKG 只能在 macOS 上构建。");

  const appPath = absolutePath(options.app ?? "build/macos/Our Choice.app");
  await requirePath(join(appPath, "Contents", "Info.plist"), "找不到开发 App；请先运行 npm run mac:safari:build-local。");
  const appMetadata = await lstat(appPath);
  if (!appMetadata.isDirectory() || appMetadata.isSymbolicLink()) {
    throw new Error(`开发 App 必须是非符号链接目录：${appPath}`);
  }
  await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  const appPlist = join(appPath, "Contents", "Info.plist");
  const bundleIdentifier = await plistValue(appPlist, "CFBundleIdentifier");
  const buildVersion = await plistValue(appPlist, "CFBundleVersion");
  const appMinimumSystemVersion = await plistValue(appPlist, "LSMinimumSystemVersion");
  if (appMinimumSystemVersion !== minimumMacOSVersion) {
    throw new Error(
      `开发 App 的最低系统版本应为 ${minimumMacOSVersion}，实际为 ${appMinimumSystemVersion}。`,
    );
  }
  const productArchitecture = currentProductArchitecture();
  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-local-package-"));
  try {
    const payloadRoot = join(workDirectory, "payload");
    const applicationsDirectory = join(payloadRoot, "Applications");
    await mkdir(applicationsDirectory, { recursive: true });
    await chmod(applicationsDirectory, 0o755);
    const payloadApp = join(applicationsDirectory, "Our Choice.app");
    await cp(appPath, payloadApp, { recursive: true, verbatimSymlinks: true });
    await execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", payloadApp]);

    const componentPlist = join(workDirectory, "OurChoice-local-components.plist");
    const componentPackage = join(workDirectory, "OurChoice-local-component.pkg");
    await execute("pkgbuild", ["--analyze", "--root", payloadRoot, componentPlist]);
    await execute("plutil", [
      "-replace",
      "0.BundleIsRelocatable",
      "-bool",
      "NO",
      componentPlist,
    ]);
    await execute("pkgbuild", [
      "--root",
      payloadRoot,
      "--identifier",
      `${bundleIdentifier}.installer.local.component`,
      "--version",
      buildVersion,
      "--install-location",
      "/",
      "--ownership",
      "recommended",
      "--component-plist",
      componentPlist,
      componentPackage,
    ]);

    await mkdir(dirname(outputPackage), { recursive: true });
    await rm(outputPackage, { force: true });
    const productRequirements = join(workDirectory, "OurChoice-local-product-requirements.plist");
    await writeFile(productRequirements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>arch</key>
  <array><string>${productArchitecture}</string></array>
  <key>os</key>
  <array><string>${minimumMacOSVersion}</string></array>
</dict>
</plist>
`, "utf8");
    await execute("productbuild", [
      "--product",
      productRequirements,
      "--package",
      componentPackage,
      outputPackage,
    ]);
    await execute(process.execPath, [
      join(root, "scripts", "verify-macos-local-package.mjs"),
      outputPackage,
    ]);

    const packageMetadata = await stat(outputPackage);
    console.log(JSON.stringify({
      pkg: outputPackage,
      bytes: packageMetadata.size,
      packageSigning: "none",
      appSigning: "ad-hoc",
      notarized: false,
      distribution: "local-test",
      hostArchitecture: productArchitecture,
      warning: "仅供当前 Mac 测试；安装会覆盖 /Applications/Our Choice.app。",
    }, null, 2));
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[mac:package-local] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
