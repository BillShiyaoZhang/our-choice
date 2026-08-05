export const SAFARI_GENERATED_APP_NAME = "Our Choice Safari";
export const SAFARI_EXTENSION_BUNDLE_NAME = `${SAFARI_GENERATED_APP_NAME} Extension`;
export const SAFARI_EXTENSION_DISPLAY_NAME = "自选助手";

export const SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS = Object.freeze([
  `INFOPLIST_KEY_CFBundleDisplayName=${SAFARI_EXTENSION_DISPLAY_NAME}`,
]);

export function validateSafariExtensionDisplayMetadata(displayName, bundleName) {
  if (displayName !== SAFARI_EXTENSION_DISPLAY_NAME) {
    throw new Error(
      `Safari 扩展 CFBundleDisplayName 必须精确等于“${SAFARI_EXTENSION_DISPLAY_NAME}”，实际为“${displayName}”。`,
    );
  }
  if (bundleName !== SAFARI_EXTENSION_BUNDLE_NAME) {
    throw new Error(
      `Safari 扩展 CFBundleName 必须精确等于“${SAFARI_EXTENSION_BUNDLE_NAME}”，实际为“${bundleName}”。`,
    );
  }
  return SAFARI_EXTENSION_DISPLAY_NAME;
}
