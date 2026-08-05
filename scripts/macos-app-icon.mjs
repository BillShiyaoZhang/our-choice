import assert from "node:assert/strict";

export const MACOS_APP_ICON_FILENAME = "OurChoice.icns";

const requiredIconChunks = ["icp4", "icp5", "ic07", "ic08", "ic09", "ic10"];

export function validateMacOSAppIcon(icon, label = "macOS App 图标") {
  assert.ok(Buffer.isBuffer(icon), `${label} 必须以 Buffer 验证。`);
  assert.ok(icon.length >= 8, `${label} 不是完整 ICNS 容器。`);
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns", `${label} 缺少 ICNS 标头。`);
  assert.equal(icon.readUInt32BE(4), icon.length, `${label} 声明长度与文件长度不一致。`);

  const chunks = new Set();
  let offset = 8;
  while (offset < icon.length) {
    assert.ok(offset + 8 <= icon.length, `${label} 包含截断的 chunk 标头。`);
    const type = icon.subarray(offset, offset + 4).toString("ascii");
    const length = icon.readUInt32BE(offset + 4);
    assert.ok(length >= 8, `${label} 的 ${type} chunk 长度无效。`);
    assert.ok(offset + length <= icon.length, `${label} 的 ${type} chunk 已截断。`);
    assert.ok(!chunks.has(type), `${label} 不允许重复的 ${type} chunk。`);
    chunks.add(type);
    offset += length;
  }
  assert.equal(offset, icon.length, `${label} 包含无法解析的尾随数据。`);

  for (const type of requiredIconChunks) {
    assert.ok(chunks.has(type), `${label} 缺少 ${type} 尺寸表示。`);
  }
  return [...chunks];
}
