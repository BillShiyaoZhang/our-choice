#!/usr/bin/env node

import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  collectRegularFiles,
  compareFileMaps,
  extractZipFiles,
  sha256,
  validateChromeExtensionFiles,
  validateExtensionVersion,
} from "./chrome-extension-package-validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function parseArguments(argv) {
  const options = {
    expectedVersion: undefined,
    help: false,
    packagePath: undefined,
    source: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      if (options.packagePath) throw new Error("只能验证一个 Chrome Web Store ZIP。");
      options.packagePath = argument;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!["--source", "--expected-version"].includes(name)) {
      throw new Error(`未知参数：${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`参数 ${name} 缺少值。`);
    if (name === "--source") options.source = value;
    if (name === "--expected-version") options.expectedVersion = value;
  }
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeExtractedFiles(directory, files) {
  for (const [name, data] of files) {
    const path = join(directory, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o644 });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("用法：node scripts/verify-chrome-extension-package.mjs [ZIP] [--source <Chrome 目录>] [--expected-version <版本>]");
    return;
  }
  if (options.expectedVersion !== undefined) {
    validateExtensionVersion(options.expectedVersion, "要求的扩展版本");
  }
  const sourceRoot = absolutePath(
    options.source ?? join("build", "browser-extensions", "chrome"),
  );
  const sourceFiles = await collectRegularFiles(sourceRoot, "Chrome 构建目录");
  const source = validateChromeExtensionFiles(sourceFiles, {
    expectedVersion: options.expectedVersion,
  });
  const packagePath = absolutePath(
    options.packagePath
      ?? join("build", "browser-extensions", `Our-Choice-Chrome-${source.version}.zip`),
  );
  const expectedName = `Our-Choice-Chrome-${source.version}.zip`;
  if (basename(packagePath) !== expectedName) {
    throw new Error(`Chrome Web Store ZIP 文件名必须为 ${expectedName}。`);
  }
  const packageMetadata = await lstat(packagePath);
  if (!packageMetadata.isFile() || packageMetadata.isSymbolicLink()) {
    throw new Error(`Chrome Web Store 产物必须是普通 ZIP 文件：${packagePath}`);
  }
  const archive = await readFile(packagePath);
  const archiveFiles = extractZipFiles(archive);
  const packaged = validateChromeExtensionFiles(archiveFiles, {
    expectedVersion: options.expectedVersion ?? source.version,
  });
  compareFileMaps(archiveFiles, sourceFiles);

  const workDirectory = await mkdtemp(join(tmpdir(), "our-choice-verify-chrome-extension-"));
  try {
    await writeExtractedFiles(workDirectory, archiveFiles);
    const extractedFiles = await collectRegularFiles(workDirectory, "最终 ZIP 解压目录");
    compareFileMaps(extractedFiles, sourceFiles, "最终解压目录与构建目录");
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }

  const digest = sha256(archive);
  const checksumPath = `${packagePath}.sha256`;
  let checksumVerified = false;
  if (await exists(checksumPath)) {
    const checksum = await readFile(checksumPath, "utf8");
    const expectedChecksum = `${digest}  ${basename(packagePath)}\n`;
    if (checksum !== expectedChecksum) throw new Error("Chrome Web Store ZIP 的 SHA-256 文件不匹配。");
    checksumVerified = true;
  }
  console.log(JSON.stringify({
    package: packagePath,
    version: packaged.version,
    manifestAtZipRoot: archiveFiles.has("manifest.json"),
    files: archiveFiles.size,
    bytes: archive.byteLength,
    sha256: digest,
    checksumVerified,
    verifiedFromFinalZip: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[extensions:verify-package:chrome] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
