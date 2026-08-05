import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FORMAT = 1;

function portableRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateSymlinkTarget(root, path, target) {
  if (isAbsolute(target)) {
    throw new Error(`发行候选件符号链接不得使用绝对目标：${portableRelativePath(root, path)}`);
  }
  const resolvedTarget = resolve(dirname(path), target);
  const relativeTarget = relative(root, resolvedTarget);
  if (
    relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    throw new Error(`发行候选件符号链接不得逃逸 App：${portableRelativePath(root, path)}`);
  }
}

async function collectEntries(root, directory = root) {
  const entries = [];
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const path = join(directory, child.name);
    const metadata = await lstat(path);
    const relativePath = portableRelativePath(root, path);
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      validateSymlinkTarget(root, path, target);
      entries.push({
        path: relativePath,
        type: "symlink",
        mode,
        target,
      });
    } else if (metadata.isDirectory()) {
      entries.push({ path: relativePath, type: "directory", mode });
      entries.push(...await collectEntries(root, path));
    } else if (metadata.isFile()) {
      const contents = await readFile(path);
      entries.push({
        path: relativePath,
        type: "file",
        mode,
        bytes: metadata.size,
        sha256: sha256(contents),
      });
    } else {
      throw new Error(`发行候选件包含不支持的文件类型：${relativePath}`);
    }
  }
  return entries;
}

function manifestDigest(entries) {
  return sha256(`${JSON.stringify(entries)}\n`);
}

async function snapshotReleaseCandidate(appPath) {
  const metadata = await lstat(appPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`发行候选件必须是非符号链接 App 目录：${appPath}`);
  }
  const entries = await collectEntries(appPath);
  return {
    format: MANIFEST_FORMAT,
    algorithm: "sha256",
    appName: basename(appPath),
    entries,
    treeSha256: manifestDigest(entries),
  };
}

export async function writeReleaseCandidateManifest(appPath, manifestPath) {
  const manifest = await snapshotReleaseCandidate(appPath);
  await mkdir(dirname(manifestPath), { recursive: true });
  const stagingPath = `${manifestPath}.staging-${process.pid}-${Date.now()}`;
  await writeFile(stagingPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(stagingPath, manifestPath);
  return manifest;
}

export async function verifyReleaseCandidateManifest(appPath, manifestPath) {
  let expected;
  try {
    expected = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取发行候选件摘要：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    expected?.format !== MANIFEST_FORMAT
    || expected?.algorithm !== "sha256"
    || !Array.isArray(expected?.entries)
    || expected?.treeSha256 !== manifestDigest(expected.entries)
  ) {
    throw new Error("发行候选件摘要文件无效或已被篡改。");
  }
  const actual = await snapshotReleaseCandidate(appPath);
  const expectedTree = expected.entries.map(({ path, type }) => ({ path, type }));
  const actualTree = actual.entries.map(({ path, type }) => ({ path, type }));
  try {
    assert.deepEqual(actualTree, expectedTree);
  } catch {
    throw new Error("发行候选件文件树不一致；拒绝在签名凭据可用时继续。");
  }
  if (actual.treeSha256 !== expected.treeSha256) {
    throw new Error("发行候选件完整性不匹配；拒绝在签名凭据可用时继续。");
  }
  return actual;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [appPath, manifestPath, ...unexpected] = process.argv.slice(2);
  if (!appPath || !manifestPath || unexpected.length > 0) {
    console.error(
      "用法：node scripts/macos-release-candidate.mjs <冻结 App> <完整性摘要>",
    );
    process.exitCode = 1;
  } else {
    verifyReleaseCandidateManifest(resolve(appPath), resolve(manifestPath))
      .then((candidate) => {
        console.log(JSON.stringify({
          app: resolve(appPath),
          manifest: resolve(manifestPath),
          entries: candidate.entries.length,
          treeSha256: candidate.treeSha256,
        }, null, 2));
      })
      .catch((error) => {
        console.error(
          `[mac:verify-release-candidate] ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
  }
}
