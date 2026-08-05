(function installOurChoiceAppBridge() {
  "use strict";
  if (globalThis.__ourChoiceAppBridgeInstalled) return;
  globalThis.__ourChoiceAppBridgeInstalled = true;

  const extensionApi = globalThis.OurChoiceBrowser;
  const allowedTypes = new Map([
    ["OUR_CHOICE_PULL_QUEUE", "OUR_CHOICE_QUEUE_RESPONSE"],
    ["OUR_CHOICE_ACK_QUEUE", "OUR_CHOICE_ACK_RESPONSE"],
  ]);

  function postResponse(request, responseType, response) {
    window.postMessage(
      {
        source: "our-choice-extension",
        type: responseType,
        requestId: request.requestId,
        response,
      },
      window.location.origin,
    );
  }

  function errorMessage(error) {
    return error && typeof error === "object" && typeof error.message === "string" && error.message
      ? error.message
      : "浏览器扩展请求失败。";
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== "our-choice-app") return;
    const responseType = allowedTypes.get(event.data.type);
    if (!responseType) return;

    let runtimeResponse;
    try {
      runtimeResponse = extensionApi.runtime.sendMessage({
        type: event.data.type,
        pairingCode: event.data.pairingCode,
        ids: event.data.ids,
      });
    } catch (error) {
      postResponse(event.data, responseType, {
        ok: false,
        error: errorMessage(error),
      });
      return;
    }
    Promise.resolve(runtimeResponse).then((response) => {
      if (!response || typeof response.ok !== "boolean") {
        postResponse(event.data, responseType, {
          ok: false,
          error: "浏览器扩展没有返回有效结果。",
        });
        return;
      }
      postResponse(event.data, responseType, response);
    }).catch((error) => {
      postResponse(event.data, responseType, {
        ok: false,
        error: errorMessage(error),
      });
    });
  });

  window.postMessage(
    { source: "our-choice-extension", type: "OUR_CHOICE_EXTENSION_READY" },
    window.location.origin,
  );
})();
