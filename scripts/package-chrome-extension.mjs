#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectRegularFiles,
  createDeterministicZip,
  sha256,
  validateChromeExtensionFiles,
  validateExtensionVersion,
} from "./chrome-extension-package-validation.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function parseArguments(argv) {
  const options = {
    expectedVersion: undefined,
    help: false,
    output: undefined,
    source: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!["--source", "--out", "--expected-version"].includes(name)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`参数 ${name} 缺少值。`);
    if (name === "--source") options.source = value;
    if (name === "--out") options.output = value;
    if (name === "--expected-version") options.expectedVersion = value;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/package-chrome-extension.mjs [--source <Chrome 目录>] [--out <ZIP>] [--expected-version <版本>]");
    return;
  }
  if (options.expectedVersion !== undefined) {
    validateExtensionVersion(options.expectedVersion, "要求的扩展版本");
  }
  const sourceRoot = absolutePath(
    options.source ?? join("build", "browser-extensions", "chrome"),
  );
  const files = await collectRegularFiles(sourceRoot, "Chrome 构建目录");
  const { version } = validateChromeExtensionFiles(files, {
    expectedVersion: options.expectedVersion,
  });
  const outputPath = absolutePath(
    options.output
      ?? join("build", "browser-extensions", `Our-Choice-Chrome-${version}.zip`),
  );
  if (!outputPath.endsWith(".zip")) throw new Error("Chrome Web Store 产物必须使用 .zip 后缀。");
  const expectedName = `Our-Choice-Chrome-${version}.zip`;
  if (basename(outputPath) !== expectedName) {
    throw new Error(`Chrome Web Store ZIP 文件名必须为 ${expectedName}。`);
  }
  const outputRelativeToSource = relative(sourceRoot, outputPath);
  if (!outputRelativeToSource.startsWith("..") && !isAbsolute(outputRelativeToSource)) {
    throw new Error("Chrome Web Store ZIP 必须写在扩展资源目录之外。");
  }
  const checksumPath = `${outputPath}.sha256`;
  const archive = createDeterministicZip(files);
  const digest = sha256(archive);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await rm(checksumPath, { force: true });
  try {
    await writeFile(outputPath, archive, { mode: 0o644 });
    await writeFile(checksumPath, `${digest}  ${basename(outputPath)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await run(process.execPath, [
      join(root, "scripts", "verify-chrome-extension-package.mjs"),
      outputPath,
      "--source",
      sourceRoot,
      "--expected-version",
      version,
    ], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    await Promise.all([
      rm(outputPath, { force: true }),
      rm(checksumPath, { force: true }),
    ]);
    throw error;
  }

  console.log(JSON.stringify({
    package: outputPath,
    checksum: checksumPath,
    version,
    files: files.size,
    bytes: archive.byteLength,
    sha256: digest,
    manifestAtZipRoot: true,
    distribution: "chrome-web-store-upload",
  }, null, 2));
}

main().catch((error) => {
  console.error(`[extensions:package:chrome] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
