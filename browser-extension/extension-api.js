(function attachOurChoiceBrowserApi(root) {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi) throw new Error("This browser does not expose the WebExtensions API.");
  root.OurChoiceBrowser = extensionApi;
})(typeof globalThis !== "undefined" ? globalThis : this);
