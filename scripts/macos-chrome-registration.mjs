const chromeExtensionIDPattern = /^[a-p]{32}$/;

function validateOptionalChromeExtensionID(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !chromeExtensionIDPattern.test(value)) {
    throw new Error("OUR_CHOICE_CHROME_EXTENSION_ID 必须是 32 位 Chrome 扩展 ID。");
  }
  return value;
}

export function resolvePackagingChromeExtensionID(
  value,
  { manualChromeInstall = false } = {},
) {
  const chromeExtensionID = validateOptionalChromeExtensionID(value);
  return manualChromeInstall ? null : chromeExtensionID;
}

export function resolveVerifierChromeExtensionID(
  value,
  {
    manualChromeInstall = false,
  } = {},
) {
  const chromeExtensionID = validateOptionalChromeExtensionID(value);
  if (manualChromeInstall) {
    if (chromeExtensionID) {
      throw new Error(
        "manual Chrome 安装模式不得同时设置 OUR_CHOICE_CHROME_EXTENSION_ID。",
      );
    }
    return null;
  }
  if (!chromeExtensionID) {
    throw new Error(
      "store Chrome 安装模式需要 OUR_CHOICE_CHROME_EXTENSION_ID；手动交付请显式使用 --manual-chrome-install。",
    );
  }
  return chromeExtensionID;
}
