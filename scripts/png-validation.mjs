import { unzlibSync } from "fflate";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
  throw new Error(message);
}

function parsePNG(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)) {
    fail("文件不是有效 PNG。");
  }

  let offset = 8;
  let header;
  let sawEnd = false;
  const imageData = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("PNG chunk 头部被截断。");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      fail(`PNG ${type} chunk 被截断。`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (!header) {
      if (type !== "IHDR" || length !== 13) fail("PNG 必须以 13-byte IHDR 开始。");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      if (header.width < 1 || header.height < 1) fail("PNG 尺寸必须为正整数。");
    } else if (type === "IHDR") {
      fail("PNG 不得包含重复 IHDR。");
    }

    if (type === "IDAT") imageData.push(data);
    if (type === "IEND") {
      if (length !== 0) fail("PNG IEND 必须为空。");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawEnd || offset !== bytes.length) fail("PNG 缺少最终 IEND 或含尾随数据。");
  if (imageData.length === 0) fail("PNG 缺少 IDAT 图像数据。");
  return { ...header, imageData };
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodeRGBA(parsed) {
  if (
    parsed.bitDepth !== 8
    || parsed.colorType !== 6
    || parsed.compression !== 0
    || parsed.filter !== 0
    || parsed.interlace !== 0
  ) {
    fail("Chrome 商店图标必须是非交错 8-bit RGBA PNG。");
  }
  const bytesPerPixel = 4;
  const stride = parsed.width * bytesPerPixel;
  const expectedBytes = (stride + 1) * parsed.height;
  const compressed = Buffer.concat(parsed.imageData);
  const filtered = Buffer.from(unzlibSync(new Uint8Array(compressed)));
  if (filtered.length !== expectedBytes) fail("PNG 解压后的扫描线长度不正确。");

  const pixels = Buffer.alloc(stride * parsed.height);
  let sourceOffset = 0;
  for (let row = 0; row < parsed.height; row += 1) {
    const filterType = filtered[sourceOffset];
    sourceOffset += 1;
    if (filterType > 4) fail(`PNG 使用不支持的 filter type：${filterType}。`);
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset + column];
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[rowOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? pixels[rowOffset + column - stride - bytesPerPixel]
        : 0;
      let value = raw;
      if (filterType === 1) value += left;
      if (filterType === 2) value += up;
      if (filterType === 3) value += Math.floor((left + up) / 2);
      if (filterType === 4) value += paeth(left, up, upperLeft);
      pixels[rowOffset + column] = value & 0xff;
    }
    sourceOffset += stride;
  }
  return pixels;
}

export function readPNGMetadata(input) {
  const { width, height } = parsePNG(input);
  return { width, height };
}

export function validateChromeStoreIcon(input) {
  const parsed = parsePNG(input);
  if (parsed.width !== 128 || parsed.height !== 128) {
    fail("Chrome 商店图标必须精确为 128x128 PNG。");
  }
  const pixels = decodeRGBA(parsed);
  let visiblePixels = 0;
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const alpha = pixels[(y * 128 + x) * 4 + 3];
      const isBorder = x < 16 || x >= 112 || y < 16 || y >= 112;
      if (isBorder && alpha !== 0) {
        fail("Chrome 商店图标四周 16 像素必须完全透明。");
      }
      if (!isBorder && alpha !== 0) visiblePixels += 1;
    }
  }
  if (visiblePixels === 0) fail("Chrome 商店图标中央 96x96 不得为空。");
  return true;
}
