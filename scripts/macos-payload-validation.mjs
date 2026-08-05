import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

export async function requireExactDirectoryEntries(directory, expectedEntries, label) {
  const actualEntries = (await readdir(directory)).sort();
  assert.deepEqual(
    actualEntries,
    [...expectedEntries].sort(),
    `${label} 不允许额外安装内容。`,
  );
}

function correspondingAppleDoublePath(path) {
  const parts = path.split("/");
  const basename = parts.at(-1);
  if (!basename?.startsWith("._")) return null;
  parts[parts.length - 1] = basename.slice(2);
  return parts.join("/");
}

export function verifyBomAllowlist(entries, chromeExtensionID) {
  const chromePreferencePath = chromeExtensionID
    ? `Library/Application Support/Google/Chrome/External Extensions/${chromeExtensionID}.json`
    : null;
  const chromeDirectories = new Set(chromeExtensionID ? [
    "Library",
    "Library/Application Support",
    "Library/Application Support/Google",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome/External Extensions",
  ] : []);
  const isAllowed = (path) => (
    path === "."
    || path === "Applications"
    || path === "Applications/Our Choice.app"
    || path.startsWith("Applications/Our Choice.app/")
    || chromeDirectories.has(path)
    || path === chromePreferencePath
  );

  for (const path of entries.keys()) {
    const correspondingPath = correspondingAppleDoublePath(path);
    if (correspondingPath) {
      assert.ok(
        entries.has(correspondingPath),
        `PKG BOM 的 AppleDouble 条目没有同级真实对象：/${path}`,
      );
      assert.ok(isAllowed(correspondingPath), `PKG BOM 包含未允许的 AppleDouble 条目：/${path}`);
    } else {
      assert.ok(isAllowed(path), `PKG BOM 包含未允许的安装内容：/${path}`);
    }
  }
}
