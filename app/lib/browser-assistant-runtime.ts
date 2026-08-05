export interface AssistantExtensionResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface AssistantMessageWindow {
  location: { origin: string };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

interface AssistantExtensionRequest {
  source: "our-choice-app";
  type: string;
  requestId: string;
  [key: string]: unknown;
}

const EXTENSION_RESPONSE_TIMEOUT_MS = 1_800;
const EXTENSION_TIMEOUT_ERROR = "浏览器扩展没有确认队列删除，请稍后重试。";
const NATIVE_BOOTSTRAP_HEADER = "x-our-choice-native-bootstrap";
const NATIVE_BOOTSTRAP_PROPERTY = "__OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__";

export function requestExtensionAssistantResponse({
  targetWindow,
  request,
  responseType,
  timeoutMilliseconds = EXTENSION_RESPONSE_TIMEOUT_MS,
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  cancelTimeout = (handle) => clearTimeout(handle),
}: {
  targetWindow: AssistantMessageWindow;
  request: AssistantExtensionRequest;
  responseType: string;
  timeoutMilliseconds?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number;
  cancelTimeout?: (handle: ReturnType<typeof setTimeout> | number) => void;
}): Promise<AssistantExtensionResponse> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (response: AssistantExtensionResponse) => {
      if (settled) return;
      settled = true;
      targetWindow.removeEventListener("message", handleMessage);
      cancelTimeout(timeoutHandle);
      resolve(response);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow || event.origin !== targetWindow.location.origin) return;
      const data = event.data as Record<string, unknown> | null;
      if (
        data?.source !== "our-choice-extension" ||
        data.type !== responseType ||
        data.requestId !== request.requestId
      ) return;
      const response = data.response;
      if (!response || typeof response !== "object" || typeof (response as { ok?: unknown }).ok !== "boolean") {
        finish({ ok: false, error: "浏览器扩展返回了无效的确认结果。" });
        return;
      }
      finish(response as AssistantExtensionResponse);
    };

    targetWindow.addEventListener("message", handleMessage);
    const timeoutHandle = scheduleTimeout(
      () => finish({ ok: false, error: EXTENSION_TIMEOUT_ERROR }),
      timeoutMilliseconds,
    );
    try {
      targetWindow.postMessage(request, targetWindow.location.origin);
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : "无法向浏览器扩展发送确认请求。",
      });
    }
  });
}

export function fullyProcessedAssistantQueueIds(
  groups: Array<{ id: string; requiredKeys: string[] }>,
  completedKeys: ReadonlySet<string>,
) {
  return groups
    .filter((group) => group.requiredKeys.length > 0)
    .filter((group) => group.requiredKeys.every((key) => completedKeys.has(key)))
    .map((group) => group.id);
}

export async function persistAppDataThenAcknowledge<TData, TResult>({
  storage,
  storageKey,
  nextData,
  onPersisted,
  acknowledge,
}: {
  storage: Pick<Storage, "setItem">;
  storageKey: string;
  nextData: TData;
  onPersisted: (nextData: TData) => void;
  acknowledge: () => Promise<TResult> | TResult;
}) {
  storage.setItem(storageKey, JSON.stringify(nextData));
  onPersisted(nextData);
  return acknowledge();
}

interface NativeBootstrapWindow {
  __OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__?: unknown;
}

function nativeBootstrapSecret(targetWindow: object) {
  const value = (targetWindow as NativeBootstrapWindow)[NATIVE_BOOTSTRAP_PROPERTY];
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || /\s/.test(value)) {
    return null;
  }
  return value;
}

export function isNativeDesktopHost(targetWindow: object) {
  return nativeBootstrapSecret(targetWindow) !== null;
}

export function nativeDesktopAuthorizationHeaders(
  targetWindow: object,
  pairingCode: string,
): Record<string, string> {
  const bootstrapSecret = nativeBootstrapSecret(targetWindow);
  if (bootstrapSecret) return { [NATIVE_BOOTSTRAP_HEADER]: bootstrapSecret };
  return pairingCode ? { authorization: `Bearer ${pairingCode}` } : {};
}

export async function registerNativeDesktopPairing({
  targetWindow,
  pairingCode,
  fetchImpl = fetch,
  pairPath = "/__our_choice/assistant/pair",
  signal,
}: {
  targetWindow: object;
  pairingCode: string;
  fetchImpl?: typeof fetch;
  pairPath?: string;
  signal?: AbortSignal;
}) {
  const bootstrapSecret = nativeBootstrapSecret(targetWindow);
  if (!bootstrapSecret) return false;
  try {
    const response = await fetchImpl(pairPath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [NATIVE_BOOTSTRAP_HEADER]: bootstrapSecret,
      },
      body: JSON.stringify({ pairingCode }),
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}
