import assert from "node:assert/strict";

export const MINIMUM_MACOS_VERSION = "13.0";

function parseXMLDocument(xml, label) {
  assert.equal(typeof xml, "string", `${label} 必须是 XML 文本。`);
  let index = xml.charCodeAt(0) === 0xfeff ? 1 : 0;

  const fail = (message) => {
    throw new Error(`${label} XML 无效：${message}`);
  };
  const isWhitespace = (character) => /[\t\n\r ]/.test(character ?? "");
  const skipWhitespace = () => {
    const start = index;
    while (isWhitespace(xml[index])) index += 1;
    return index > start;
  };
  const parseName = (context) => {
    const name = xml.slice(index).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) fail(`${context} 缺少有效名称（偏移 ${index}）。`);
    index += name.length;
    return name;
  };
  const consumeComment = () => {
    const end = xml.indexOf("-->", index + 4);
    if (end < 0) fail("注释缺少结束标记。 ");
    if (xml.slice(index + 4, end).includes("--")) fail("注释正文包含非法的 --。 ");
    index = end + 3;
  };
  const consumeCDATA = () => {
    const end = xml.indexOf("]]>", index + 9);
    if (end < 0) fail("CDATA 缺少结束标记。 ");
    index = end + 3;
  };
  const consumeProcessingInstruction = () => {
    const end = xml.indexOf("?>", index + 2);
    if (end < 0) fail("处理指令缺少结束标记。 ");
    index = end + 2;
  };
  const rejectDoctypeOrDeclaration = () => {
    if (/^<!DOCTYPE\b/i.test(xml.slice(index))) {
      fail("DOCTYPE 被禁止。 ");
    }
    fail("包含不支持的标记声明。 ");
  };
  const decodeReferences = (source, context) => {
    const reference = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g;
    let cursor = 0;
    let decoded = "";
    for (const match of source.matchAll(reference)) {
      const plainText = source.slice(cursor, match.index);
      if (plainText.includes("&")) fail(`${context} 包含无效实体引用。`);
      decoded += plainText;
      const token = match[0];
      if (token === "&amp;") decoded += "&";
      else if (token === "&lt;") decoded += "<";
      else if (token === "&gt;") decoded += ">";
      else if (token === "&quot;") decoded += '"';
      else if (token === "&apos;") decoded += "'";
      else {
        const hexadecimal = token.startsWith("&#x");
        const codePoint = Number.parseInt(token.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
        if (
          !Number.isInteger(codePoint)
          || codePoint <= 0
          || codePoint > 0x10ffff
          || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          fail(`${context} 包含无效字符引用。`);
        }
        decoded += String.fromCodePoint(codePoint);
      }
      cursor = match.index + token.length;
    }
    const remainder = source.slice(cursor);
    if (remainder.includes("&")) fail(`${context} 包含无效实体引用。`);
    return decoded + remainder;
  };

  const parseElement = () => {
    if (xml[index] !== "<" || /[!/?]/.test(xml[index + 1] ?? "")) {
      fail(`偏移 ${index} 处应为元素起始标签。`);
    }
    index += 1;
    const name = parseName("元素");
    const attributes = new Map();

    while (index < xml.length) {
      const hadWhitespace = skipWhitespace();
      if (xml.startsWith("/>", index)) {
        index += 2;
        return { name, attributes, children: [] };
      }
      if (xml[index] === ">") {
        index += 1;
        break;
      }
      if (!hadWhitespace) fail(`元素 ${name} 的属性前缺少空白。`);
      const attributeName = parseName(`元素 ${name} 的属性`);
      if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) {
        fail(`元素 ${name} 不得声明 XML 命名空间。`);
      }
      if (attributes.has(attributeName)) fail(`元素 ${name} 的属性 ${attributeName} 不得重复。`);
      skipWhitespace();
      if (xml[index] !== "=") fail(`元素 ${name} 的属性 ${attributeName} 缺少等号。`);
      index += 1;
      skipWhitespace();
      const quote = xml[index];
      if (quote !== '"' && quote !== "'") {
        fail(`元素 ${name} 的属性 ${attributeName} 必须使用引号。`);
      }
      index += 1;
      const end = xml.indexOf(quote, index);
      if (end < 0) fail(`元素 ${name} 的属性 ${attributeName} 缺少结束引号。`);
      const sourceValue = xml.slice(index, end);
      if (sourceValue.includes("<")) fail(`元素 ${name} 的属性 ${attributeName} 包含非法的 <。`);
      attributes.set(
        attributeName,
        decodeReferences(sourceValue, `元素 ${name} 的属性 ${attributeName}`),
      );
      index = end + 1;
    }

    const children = [];
    while (index < xml.length) {
      if (xml.startsWith(`</`, index)) {
        index += 2;
        const closingName = parseName(`元素 ${name} 的结束标签`);
        skipWhitespace();
        if (xml[index] !== ">") fail(`元素 ${name} 的结束标签缺少 >。`);
        index += 1;
        if (closingName !== name) {
          fail(`元素 ${name} 由不匹配的 ${closingName} 结束。`);
        }
        return { name, attributes, children };
      }
      if (xml.startsWith("<!--", index)) {
        consumeComment();
      } else if (xml.startsWith("<![CDATA[", index)) {
        consumeCDATA();
      } else if (xml.startsWith("<?", index)) {
        consumeProcessingInstruction();
      } else if (xml.startsWith("<!", index)) {
        rejectDoctypeOrDeclaration();
      } else if (xml[index] === "<") {
        children.push(parseElement());
      } else {
        const end = xml.indexOf("<", index);
        if (end < 0) fail(`元素 ${name} 缺少结束标签。`);
        const text = xml.slice(index, end);
        if (text.includes("]]>") ) fail(`元素 ${name} 的文本包含非法的 ]]>。`);
        decodeReferences(text, `元素 ${name} 的文本`);
        index = end;
      }
    }
    fail(`元素 ${name} 缺少结束标签。`);
  };

  const skipDocumentMisc = () => {
    let consumed = true;
    while (consumed) {
      consumed = skipWhitespace();
      if (xml.startsWith("<!--", index)) {
        consumeComment();
        consumed = true;
      } else if (xml.startsWith("<?", index)) {
        consumeProcessingInstruction();
        consumed = true;
      } else if (xml.startsWith("<!", index)) {
        rejectDoctypeOrDeclaration();
      }
    }
  };

  skipDocumentMisc();
  if (index >= xml.length) fail("缺少根元素。 ");
  const root = parseElement();
  skipDocumentMisc();
  if (index !== xml.length) fail("根元素之外存在额外内容。 ");
  return root;
}

function childElements(element, name) {
  return element.children.filter((child) => child.name === name);
}

function descendantElements(element, name, matches = []) {
  for (const child of element.children) {
    if (child.name === name) matches.push(child);
    descendantElements(child, name, matches);
  }
  return matches;
}

export function validatePackageInfoRootAttributes(
  packageInfo,
  expectedAttributes,
  label = "PKG PackageInfo",
) {
  const root = parseXMLDocument(packageInfo, label);
  assert.equal(root.name, "pkg-info", `${label} 根元素必须是 pkg-info。`);
  for (const [name, expectedValue] of Object.entries(expectedAttributes)) {
    assert.equal(
      root.attributes.get(name),
      expectedValue,
      `${label} 根元素的 ${name} 属性必须精确等于 ${expectedValue}。`,
    );
  }
  return root.attributes;
}

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function validateMacOSDistributionRequirements(
  distribution,
  {
    expectedArchitectures,
    expectedMinimumSystemVersion = MINIMUM_MACOS_VERSION,
    label = "PKG Distribution",
  } = {},
) {
  const root = parseXMLDocument(distribution, label);
  assert.equal(root.name, "installer-gui-script", `${label} 根元素必须是 installer-gui-script。`);

  const optionElements = descendantElements(root, "options");
  const rootOptions = childElements(root, "options");
  assert.equal(optionElements.length, 1, `${label} 必须恰好包含一个 options 元素。`);
  assert.equal(rootOptions.length, 1, `${label} 的 options 必须是根元素直属子元素。`);
  assert.equal(optionElements[0], rootOptions[0], `${label} 的 options 位置无效。`);
  const optionAttributes = rootOptions[0].attributes;
  assert.equal(
    optionAttributes.has("hostArchitectures"),
    true,
    `${label} options 必须包含真实的 hostArchitectures 属性。`,
  );
  const hostArchitectures = optionAttributes.get("hostArchitectures")
    .split(",")
    .map((value) => value.trim());
  assert.ok(
    hostArchitectures.length > 0 && hostArchitectures.every(Boolean),
    `${label} 的 hostArchitectures 不得包含空架构。`,
  );
  assert.equal(
    new Set(hostArchitectures).size,
    hostArchitectures.length,
    `${label} 的 hostArchitectures 不得重复。`,
  );
  if (expectedArchitectures) {
    assert.deepEqual(
      sorted(hostArchitectures),
      sorted(expectedArchitectures),
      `${label} 的 hostArchitectures 必须精确等于 ${expectedArchitectures.join(",")}。`,
    );
  }

  const volumeCheckElements = descendantElements(root, "volume-check");
  const rootVolumeChecks = childElements(root, "volume-check");
  assert.equal(
    volumeCheckElements.length,
    1,
    `${label} 必须恰好包含一个 volume-check 元素。`,
  );
  assert.equal(
    rootVolumeChecks.length,
    1,
    `${label} 的 volume-check 必须是根元素直属子元素。`,
  );
  assert.equal(volumeCheckElements[0], rootVolumeChecks[0], `${label} 的 volume-check 位置无效。`);

  const allowedOSVersionElements = descendantElements(root, "allowed-os-versions");
  const volumeAllowedOSVersions = childElements(rootVolumeChecks[0], "allowed-os-versions");
  assert.equal(
    allowedOSVersionElements.length,
    1,
    `${label} 必须恰好包含一个 allowed-os-versions 元素。`,
  );
  assert.equal(
    volumeAllowedOSVersions.length,
    1,
    `${label} 的 allowed-os-versions 必须直属 volume-check。`,
  );
  assert.equal(
    allowedOSVersionElements[0],
    volumeAllowedOSVersions[0],
    `${label} 的 allowed-os-versions 位置无效。`,
  );

  const osVersionElements = descendantElements(root, "os-version");
  const allowedOSVersionEntries = childElements(volumeAllowedOSVersions[0], "os-version");
  assert.equal(osVersionElements.length, 1, `${label} 必须恰好包含一个 os-version 元素。`);
  assert.equal(
    allowedOSVersionEntries.length,
    1,
    `${label} 的 os-version 必须直属 allowed-os-versions。`,
  );
  assert.equal(osVersionElements[0], allowedOSVersionEntries[0], `${label} 的 os-version 位置无效。`);
  const osVersionAttributes = allowedOSVersionEntries[0].attributes;
  assert.equal(
    osVersionAttributes.has("min"),
    true,
    `${label} 的 os-version 必须恰好包含一个真实的 min 属性。`,
  );
  const minimumSystemVersion = osVersionAttributes.get("min");
  assert.equal(
    minimumSystemVersion,
    expectedMinimumSystemVersion,
    `${label} 的最低系统版本必须精确等于 ${expectedMinimumSystemVersion}。`,
  );

  return { hostArchitectures, minimumSystemVersion };
}

export function validatePayloadMinimumSystemVersions({
  appMinimumSystemVersion,
  appexMinimumSystemVersion,
  distributionMinimumSystemVersion,
  expectedMinimumSystemVersion = MINIMUM_MACOS_VERSION,
  label = "最终 Payload",
}) {
  assert.equal(
    distributionMinimumSystemVersion,
    expectedMinimumSystemVersion,
    `Distribution 的最低系统版本必须精确等于 ${expectedMinimumSystemVersion}。`,
  );
  assert.equal(
    appMinimumSystemVersion,
    distributionMinimumSystemVersion,
    `${label} 主 App 的 LSMinimumSystemVersion 必须与 Distribution 的最低系统版本精确一致。`,
  );
  assert.equal(
    appexMinimumSystemVersion,
    distributionMinimumSystemVersion,
    `${label} Safari .appex 的 LSMinimumSystemVersion 必须与 Distribution 的最低系统版本精确一致。`,
  );
  return distributionMinimumSystemVersion;
}
