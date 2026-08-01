(function installOurChoiceAppBridge() {
  "use strict";
  if (globalThis.__ourChoiceAppBridgeInstalled) return;
  globalThis.__ourChoiceAppBridgeInstalled = true;

  const allowedTypes = new Map([
    ["OUR_CHOICE_PULL_QUEUE", "OUR_CHOICE_QUEUE_RESPONSE"],
    ["OUR_CHOICE_ACK_QUEUE", "OUR_CHOICE_ACK_RESPONSE"],
  ]);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== "our-choice-app") return;
    const responseType = allowedTypes.get(event.data.type);
    if (!responseType) return;

    chrome.runtime.sendMessage(
      {
        type: event.data.type,
        pairingCode: event.data.pairingCode,
        ids: event.data.ids,
      },
      (response) => {
        const error = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: "our-choice-extension",
            type: responseType,
            requestId: event.data.requestId,
            response: error ? { ok: false, error } : response,
          },
          window.location.origin,
        );
      },
    );
  });

  window.postMessage(
    { source: "our-choice-extension", type: "OUR_CHOICE_EXTENSION_READY" },
    window.location.origin,
  );
})();
