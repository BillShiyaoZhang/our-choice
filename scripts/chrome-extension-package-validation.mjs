import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { validateChromeStoreIcon } from "./png-validation.mjs";

export const EXPECTED_CHROME_FILES = Object.freeze([
  "app-bridge.js",
  "background.js",
  "content-script.js",
  "extension-api.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "shared.js",
].sort(compareASCII));

const expectedPermissions = ["activeTab", "scripting", "storage"];
const expectedHosts = ["http://127.0.0.1/*", "http://localhost/*"];
const expectedContentMatches = [
  "http://127.0.0.1/*",
  "http://localhost/*",
];
const deterministicTimestamp = new Date("1980-01-01T00:00:00.000Z");
const maximumArchiveBytes = 32 * 1024 * 1024;
const maximumFileBytes = 4 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function compareASCII(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sorted(values) {
  return [...values].sort(compareASCII);
}

function sameStrings(actual, expected) {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function requireExactStrings(actual, expected, label) {
  const normalizedActual = sorted(actual);
  const normalizedExpected = sorted(expected);
  if (!sameStrings(normalizedActual, normalizedExpected)) {
    fail(`${label} 不一致。期望 ${normalizedExpected.join(", ")}；实际 ${normalizedActual.join(", ")}。`);
  }
}

export function validateExtensionVersion(version, label = "扩展版本") {
  if (typeof version !== "string") fail(`${label} 必须是字符串。`);
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) {
    fail(`${label} 必须由一至四段整数组成：${version}`);
  }
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d*)$/.test(part) || Number(part) > 65_535) {
      fail(`${label} 含非法整数段：${version}`);
    }
  }
  return version;
}

export function validateArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\0")) {
    fail("ZIP 含空路径或 NUL。 ");
  }
  if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    fail(`ZIP 含不安全绝对路径或反斜杠：${name}`);
  }
  const segments = name.split("/");
  if (name.endsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`ZIP 含不安全路径片段：${name}`);
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    fail(`ZIP 不得包含隐藏路径：${name}`);
  }
  return name;
}

async function collectDirectory(directory, prefix, files, label) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    validateArchivePath(relativePath);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      fail(`${label} 不得包含符号链接：${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await collectDirectory(path, relativePath, files, label);
      continue;
    }
    if (!metadata.isFile()) {
      fail(`${label} 只能包含普通文件：${relativePath}`);
    }
    if (metadata.size > maximumFileBytes) {
      fail(`${label} 文件过大：${relativePath}`);
    }
    files.set(relativePath, new Uint8Array(await readFile(path)));
  }
}

export async function collectRegularFiles(root, label = "扩展目录") {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} 必须是非符号链接目录：${root}`);
  }
  const files = new Map();
  await collectDirectory(root, "", files, label);
  const totalBytes = [...files.values()].reduce((sum, value) => sum + value.byteLength, 0);
  if (totalBytes > maximumTotalBytes) fail(`${label} 解压后总大小超过限制。`);
  return new Map(
    [...files.entries()].sort(([left], [right]) => compareASCII(left, right)),
  );
}

export function requireExpectedFileTree(files, label = "扩展文件树") {
  requireExactStrings([...files.keys()], EXPECTED_CHROME_FILES, `${label}文件列表`);
}

function requireReference(files, reference, label) {
  validateArchivePath(reference);
  if (!files.has(reference)) fail(`${label} 引用不存在或大小写不匹配：${reference}`);
}

function requireLocalCodeReference(files, reference, label) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
    fail(`${label} 不得引用远程代码：${reference}`);
  }
  requireReference(files, reference, label);
}

function validatePNG(data, size, path) {
  const bytes = Buffer.from(data);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    fail(`扩展图标不是有效 PNG：${path}`);
  }
  if (bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
    fail(`扩展图标尺寸必须为 ${size}x${size}：${path}`);
  }
}

function validateJavaScript(files) {
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue;
    const source = strFromU8(bytes);
    if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) {
      fail(`Manifest V3 扩展不得执行字符串代码：${path}`);
    }
    for (const match of source.matchAll(/\b(?:importScripts|import)\s*\(([^)]*)\)/g)) {
      const references = match[1].split(",").map((value) => value.trim()).filter(Boolean);
      if (references.length === 0) fail(`动态代码引用不能为空：${path}`);
      for (const value of references) {
        const literal = value.match(/^(?:"([^"]+)"|'([^']+)')$/)?.slice(1).find(Boolean);
        if (!literal) fail(`代码引用必须是可审计的本地字符串：${path}`);
        requireLocalCodeReference(files, literal, `${path} 代码`);
      }
    }
  }
}

function validateHTML(files) {
  for (const [path, bytes] of files) {
    if (!path.endsWith(".html")) continue;
    const source = strFromU8(bytes);
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const reference = match[1].match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i)
        ?.slice(1).find(Boolean);
      if (!reference || match[2].trim()) {
        fail(`扩展 HTML 只允许引用包内脚本且禁止内联代码：${path}`);
      }
      requireLocalCodeReference(files, reference, `${path} script`);
    }
    for (const match of source.matchAll(/<link\b([^>]*)>/gi)) {
      const relation = match[1].match(/\brel\s*=\s*(?:"([^"]+)"|'([^']+)')/i)
        ?.slice(1).find(Boolean);
      if (relation?.toLowerCase() !== "stylesheet") continue;
      const reference = match[1].match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i)
        ?.slice(1).find(Boolean);
      if (!reference) fail(`${path} stylesheet 缺少 href。`);
      requireLocalCodeReference(files, reference, `${path} stylesheet`);
    }
  }
}

export function validateChromeExtensionFiles(files, { expectedVersion } = {}) {
  requireExpectedFileTree(files);
  const manifestText = strFromU8(files.get("manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    fail(`manifest.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.manifest_version !== 3) fail("Chrome Web Store 包必须使用 Manifest V3。");
  const version = validateExtensionVersion(manifest.version);
  if (expectedVersion !== undefined && version !== expectedVersion) {
    fail(`扩展版本 ${version} 与要求的版本 ${expectedVersion} 不一致。`);
  }
  if (typeof manifest.name !== "string" || [...manifest.name].length < 1 || [...manifest.name].length > 75) {
    fail("扩展名称长度必须为 1..75 个字符。 ");
  }
  if (
    typeof manifest.description !== "string"
    || [...manifest.description].length < 1
    || [...manifest.description].length > 132
  ) {
    fail("扩展描述长度必须为 1..132 个字符。 ");
  }
  if (Object.hasOwn(manifest, "key") || Object.hasOwn(manifest, "update_url")) {
    fail("商店 ZIP 的 Manifest 不得内嵌 key 或 update_url。");
  }
  requireExactStrings(manifest.permissions ?? [], expectedPermissions, "扩展权限");
  requireExactStrings(manifest.host_permissions ?? [], expectedHosts, "扩展 host_permissions");
  if (manifest.background?.service_worker !== "background.js") {
    fail("扩展 service worker 必须为 background.js。");
  }
  requireReference(files, manifest.background.service_worker, "service worker");
  if (manifest.action?.default_popup !== "popup.html") {
    fail("扩展 popup 必须为 popup.html。");
  }
  requireReference(files, manifest.action.default_popup, "popup");
  const expectedIcons = {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  };
  if (JSON.stringify(manifest.icons) !== JSON.stringify(expectedIcons)) {
    fail("扩展图标声明必须精确包含 16/32/48/128 像素资源。 ");
  }
  for (const [rawSize, path] of Object.entries(expectedIcons)) {
    requireReference(files, path, "扩展图标");
    validatePNG(files.get(path), Number(rawSize), path);
  }
  validateChromeStoreIcon(files.get(expectedIcons[128]));
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) {
    fail("扩展必须恰好声明一个本地应用 content script。 ");
  }
  const [contentScript] = manifest.content_scripts;
  requireExactStrings(contentScript.matches ?? [], expectedContentMatches, "content script matches");
  requireExactStrings(
    contentScript.js ?? [],
    ["app-bridge.js", "extension-api.js"],
    "content script JavaScript",
  );
  if (contentScript.run_at !== "document_start") {
    fail("content script 必须在 document_start 运行。 ");
  }
  for (const path of contentScript.js) requireReference(files, path, "content script");
  validateJavaScript(files);
  validateHTML(files);
  return { manifest, version };
}

export function createDeterministicZip(files) {
  const input = Object.fromEntries(
    [...files.entries()]
      .sort(([left], [right]) => compareASCII(left, right))
      .map(([name, data]) => [
        name,
        [data, {
          attrs: (0o100644 << 16) >>> 0,
          mtime: deterministicTimestamp,
          os: 3,
        }],
      ]),
  );
  return Buffer.from(zipSync(input, { level: 9 }));
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  fail("ZIP 缺少有效的中央目录结束记录。 ");
}

function decodeEntryName(bytes) {
  let name;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("ZIP entry 名称不是有效 UTF-8。 ");
  }
  if (!/^[\x20-\x7E]+$/.test(name)) fail(`ZIP entry 名称必须使用可打印 ASCII：${name}`);
  return validateArchivePath(name);
}

export function inspectZipCentralDirectory(archive) {
  const bytes = Buffer.from(archive);
  if (bytes.length > maximumArchiveBytes) fail("Chrome Web Store ZIP 超过本项目大小限制。 ");
  const endOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    fail("ZIP 不得使用多磁盘格式。 ");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("ZIP64 不适用于此小型扩展包。 ");
  }
  if (totalEntries > 64) fail(`ZIP entry 数量异常：${totalEntries}。`);
  if (centralOffset + centralSize !== endOffset) fail("ZIP 中央目录边界不正确。 ");

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("ZIP 中央目录 entry 损坏。 ");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > endOffset) fail("ZIP 中央目录 entry 越界。 ");
    const name = decodeEntryName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (names.has(name)) fail(`ZIP 含重复 entry：${name}`);
    names.add(name);
    if (flags & 0x1) fail(`ZIP entry 不得加密：${name}`);
    if (flags & 0x8) fail(`ZIP entry 不得使用不确定的数据描述符：${name}`);
    if (![0, 8].includes(compression)) fail(`ZIP entry 压缩算法不受支持：${name}`);
    if (extraLength !== 0 || commentLength !== 0 || startDisk !== 0) {
      fail(`ZIP entry 不得携带额外元数据：${name}`);
    }
    const creatorOS = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (creatorOS !== 3 || (unixMode & 0o170000) !== 0o100000 || (unixMode & 0o777) !== 0o644) {
      fail(`ZIP entry 必须是 0644 Unix 普通文件，不能是符号链接：${name}`);
    }
    if (uncompressedSize > maximumFileBytes) fail(`ZIP entry 解压后过大：${name}`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maximumTotalBytes) fail("ZIP 解压后总大小超过限制。 ");

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail(`ZIP local header 损坏：${name}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompression = bytes.readUInt16LE(localOffset + 8);
    const localCRC = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localName = decodeEntryName(
      bytes.subarray(localNameStart, localNameStart + localNameLength),
    );
    const dataStart = localNameStart + localNameLength + localExtraLength;
    if (
      localName !== name
      || localFlags !== flags
      || localCompression !== compression
      || localCRC !== crc32
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
      || localExtraLength !== 0
      || dataStart + compressedSize > centralOffset
    ) {
      fail(`ZIP local/central entry 不一致：${name}`);
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      crc32,
    });
    cursor = entryEnd;
  }
  if (cursor !== endOffset) fail("ZIP 中央目录含未解析数据。 ");
  requireExactStrings(entries.map((entry) => entry.name), EXPECTED_CHROME_FILES, "ZIP 文件列表");
  if (!sameStrings(entries.map((entry) => entry.name), EXPECTED_CHROME_FILES)) {
    fail("ZIP entry 必须按稳定顺序排列。 ");
  }
  return entries;
}

export function extractZipFiles(archive) {
  inspectZipCentralDirectory(archive);
  let extracted;
  try {
    extracted = unzipSync(new Uint8Array(archive));
  } catch (error) {
    fail(`ZIP 完整性或 CRC 校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Map(
    Object.entries(extracted)
      .map(([name, data]) => [validateArchivePath(name), data])
      .sort(([left], [right]) => compareASCII(left, right)),
  );
  requireExpectedFileTree(files, "ZIP ");
  return files;
}

export function compareFileMaps(actual, expected, label = "ZIP 与构建目录") {
  requireExactStrings([...actual.keys()], [...expected.keys()], `${label}文件列表`);
  for (const [name, expectedData] of expected) {
    const actualData = actual.get(name);
    if (!actualData || !Buffer.from(actualData).equals(Buffer.from(expectedData))) {
      fail(`${label}内容不一致：${name}`);
    }
  }
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
