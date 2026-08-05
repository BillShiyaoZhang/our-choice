import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const requiredSafariExtensionResources = [
  "manifest.json",
  "background.js",
  "content-script.js",
  "extension-api.js",
  "app-bridge.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "shared.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

async function collectRelativeFiles(rootDirectory, directory = rootDirectory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFiles(rootDirectory, path));
    } else if (entry.isFile()) {
      files.push(relative(rootDirectory, path));
    } else {
      throw new Error(`Safari 扩展资源不得包含符号链接或特殊文件：${path}`);
    }
  }
  return files.sort();
}

async function requireRegularFile(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} 必须是普通文件：${path}`);
  }
}

async function requireRealDirectory(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label}资源根路径必须是非符号链接目录：${path}`);
  }
}

export async function verifySafariAppexResources({ sourceRoot, appexPath }) {
  const embeddedRoot = join(appexPath, "Contents", "Resources");
  await Promise.all([
    requireRealDirectory(sourceRoot, "Safari 共源"),
    requireRealDirectory(embeddedRoot, "Safari .appex "),
  ]);
  for (const resource of requiredSafariExtensionResources) {
    await requireRegularFile(join(sourceRoot, resource), "Safari 共源资源");
    await requireRegularFile(join(embeddedRoot, resource), "Safari .appex 资源");
  }

  const [sourceFiles, embeddedFiles] = await Promise.all([
    collectRelativeFiles(sourceRoot),
    collectRelativeFiles(embeddedRoot),
  ]);
  assert.deepEqual(
    embeddedFiles,
    sourceFiles,
    "Safari .appex 资源文件列表与共源产物不一致。",
  );

  for (const file of sourceFiles) {
    const [source, embedded] = await Promise.all([
      readFile(join(sourceRoot, file)),
      readFile(join(embeddedRoot, file)),
    ]);
    assert.ok(
      embedded.equals(source),
      `Safari .appex 资源内容与共源产物不一致：${file}`,
    );
  }

  const [sourceManifest, embeddedManifest] = await Promise.all([
    readFile(join(sourceRoot, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(embeddedRoot, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(embeddedManifest, sourceManifest, "Safari .appex Manifest 与共源产物不一致。");
  return { files: sourceFiles, manifest: embeddedManifest };
}
