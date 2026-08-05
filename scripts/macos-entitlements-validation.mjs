function entitlementKeys(details) {
  const keys = [];
  const pattern = /<key>\s*([^<]+?)\s*<\/key>|\[Key\][\t ]+([^\r\n]+?)[\t ]*(?:\r?\n|$)/g;
  for (const match of String(details ?? "").matchAll(pattern)) {
    keys.push((match[1] ?? match[2]).trim());
  }
  return keys.sort();
}

export function hasEnabledEntitlement(details, entitlement) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const xml = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`);
  const display = new RegExp(
    `\\[Key\\][\\t ]+${escaped}[\\t ]*\\r?\\n`
      + `(?:[\\t ]*\\[Value\\][\\t ]*\\r?\\n)?`
      + `[\\t ]*\\[Bool\\][\\t ]+true[\\t ]*(?:\\r?\\n|$)`,
  );
  return xml.test(details) || display.test(details);
}

export function validateExactEntitlements(details, expectedNames, label) {
  const expected = [...expectedNames].sort();
  const actual = entitlementKeys(details);
  const duplicateKeys = actual.filter((key, index) => key === actual[index - 1]);
  const sameSet = duplicateKeys.length === 0
    && actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
  if (!sameSet) {
    const actualLabel = actual.length > 0 ? actual.join(", ") : "（空）";
    const expectedLabel = expected.length > 0 ? expected.join(", ") : "（空）";
    throw new Error(
      `${label} entitlement 白名单不匹配：期望 ${expectedLabel}；实际 ${actualLabel}。`,
    );
  }
  for (const entitlement of expected) {
    if (!hasEnabledEntitlement(details, entitlement)) {
      throw new Error(`${label} 必须显式启用 entitlement：${entitlement}`);
    }
  }
  return actual;
}
