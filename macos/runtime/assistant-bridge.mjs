import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const STATE_VERSION = 1;
const STATE_FILE = "assistant-state.json";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUEUE_ITEMS = 500;
const MAX_PAIRING_CODE_LENGTH = 1024;
const MAX_BOOTSTRAP_SECRET_LENGTH = 1024;
const MIN_BOOTSTRAP_SECRET_LENGTH = 32;
const NATIVE_BOOTSTRAP_HEADER = "x-our-choice-native-bootstrap";
const MAX_ITEM_ID_LENGTH = 160;
const MAX_URL_LENGTH = 4096;
const MAX_PREVIOUS_COUNT = 1_000_000;
const MAX_TITLE_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 800;
const MAX_SELECTION_LENGTH = 2_000;
const MAX_SITE_NAME_LENGTH = 120;
const MAX_CANDIDATE_NAME_LENGTH = 120;
const MAX_EXTERNAL_ID_LENGTH = 80;
const EXTENSION_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
]);
const DEFAULT_PRODUCT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(status, code, message) {
  return json({ ok: false, error: { code, message } }, status);
}

function normalizeProductOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isExtensionOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      EXTENSION_PROTOCOLS.has(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["", "/"].includes(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function productOriginFromReferer(request, allowedOrigins) {
  if (request.method !== "GET" || request.headers.has("origin")) return "";
  try {
    const origin = new URL(request.headers.get("referer") ?? "").origin;
    return allowedOrigins.has(origin) ? origin : "";
  } catch {
    return "";
  }
}

function responseWithCors(response, origin, allowedOrigins) {
  if (!origin || (!allowedOrigins.has(origin) && !isExtensionOrigin(origin))) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  const vary = headers.get("vary")?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  if (!vary.includes("origin") && !vary.includes("*")) headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function deniedOrigin() {
  return errorResponse(403, "ORIGIN_FORBIDDEN", "不允许从这个来源访问桌面助手。");
}

async function readBodyWithLimit(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "请求体不能超过 1 MiB。");
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "REQUEST_TOO_LARGE", "请求体不能超过 1 MiB。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function readJson(request) {
  const body = await readBodyWithLimit(request);
  if (!body.length) {
    throw new HttpError(400, "INVALID_JSON", "请求体必须是 JSON。");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体不是有效的 JSON。");
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyState() {
  return { version: STATE_VERSION, pairing: null, queue: [] };
}

function validatePersistedState(value) {
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    throw new Error("Unsupported or invalid assistant state file.");
  }
  if (!Array.isArray(value.queue) || value.queue.length > MAX_QUEUE_ITEMS) {
    throw new Error("Invalid assistant queue in persisted state.");
  }

  const seenIds = new Set();
  const queue = [];
  for (const rawItem of value.queue) {
    let item;
    try {
      item = normalizeItem(rawItem);
    } catch {
      throw new Error("Invalid assistant item in persisted state.");
    }
    if (seenIds.has(item.id)) throw new Error("Invalid assistant item in persisted state.");
    seenIds.add(item.id);
    queue.push(item);
  }

  if (value.pairing !== null) {
    if (
      !isRecord(value.pairing) ||
      value.pairing.algorithm !== "scrypt" ||
      typeof value.pairing.salt !== "string" ||
      typeof value.pairing.digest !== "string"
    ) {
      throw new Error("Invalid assistant pairing data in persisted state.");
    }
  }

  return {
    version: STATE_VERSION,
    pairing: value.pairing === null
      ? null
      : {
          algorithm: "scrypt",
          salt: value.pairing.salt,
          digest: value.pairing.digest,
        },
    queue,
  };
}

async function loadState(dataDir, statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return validatePersistedState(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    const corruptPath = join(
      dataDir,
      `${STATE_FILE}.corrupt-${Date.now()}-${randomUUID()}`,
    );
    try {
      await rename(statePath, corruptPath);
    } catch (renameError) {
      if (renameError?.code === "ENOENT") return emptyState();
      throw error;
    }
    console.warn(`[our-choice-desktop] isolated corrupt assistant state at ${corruptPath}`);
    return emptyState();
  }
}

async function persistAtomically(dataDir, statePath, state) {
  const temporaryPath = join(
    dataDir,
    `.${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, statePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function pairingRecord(pairingCode) {
  const salt = randomBytes(32);
  const digest = await scrypt(pairingCode, salt, 32);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    digest: Buffer.from(digest).toString("base64"),
  };
}

async function pairingMatches(pairing, pairingCode) {
  if (
    !pairing ||
    typeof pairingCode !== "string" ||
    !pairingCode ||
    pairingCode.length > MAX_PAIRING_CODE_LENGTH
  ) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(pairing.salt, "base64");
    expected = Buffer.from(pairing.digest, "base64");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = Buffer.from(await scrypt(pairingCode, salt, expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bootstrapSecretMatches(expected, provided) {
  if (
    typeof expected !== "string" ||
    typeof provided !== "string" ||
    provided.length < MIN_BOOTSTRAP_SECRET_LENGTH ||
    provided.length > MAX_BOOTSTRAP_SECRET_LENGTH
  ) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
}

function bearerToken(request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeWebUrl(value) {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_ITEM", "队列项包含无效的 URL。");
  }
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_URL_LENGTH) {
    throw new HttpError(400, "INVALID_ITEM", "队列项包含无效的 URL。");
  }
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error("Unsafe URL");
    }
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    const normalized = url.href;
    if (normalized.length > MAX_URL_LENGTH) throw new Error("URL too long");
    return normalized;
  } catch {
    throw new HttpError(400, "INVALID_ITEM", "队列项包含无效的 URL。");
  }
}

function optionalWebUrl(value, key) {
  if (!Object.hasOwn(value, key)) return undefined;
  return normalizeWebUrl(value[key]);
}

function normalizeCandidate(value) {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_ITEM", "订阅来源队列项无效。");
  }
  const url = normalizeWebUrl(value.url);
  const normalized = {
    url,
    name: cleanText(value.name, MAX_CANDIDATE_NAME_LENGTH) || new URL(url).hostname,
  };
  const externalId = cleanText(value.externalId, MAX_EXTERNAL_ID_LENGTH);
  const imageUrl = optionalWebUrl(value, "imageUrl");
  if (externalId) normalized.externalId = externalId;
  if (imageUrl) normalized.imageUrl = imageUrl;
  return normalized;
}

function normalizeCandidateList(value, allowEmpty = true) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_QUEUE_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new HttpError(400, "INVALID_ITEM", "关注批量队列项无效。");
  }
  return value.map(normalizeCandidate);
}

function normalizeItem(value) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.trim().length > MAX_ITEM_ID_LENGTH ||
    typeof value.capturedAt !== "string" ||
    !value.capturedAt.trim() ||
    value.capturedAt.length > 64
  ) {
    throw new HttpError(400, "INVALID_ITEM", "队列项必须包含有效的 ID。");
  }
  const id = value.id.trim();
  const capturedTime = Date.parse(value.capturedAt.trim());
  if (!Number.isFinite(capturedTime)) {
    throw new HttpError(400, "INVALID_ITEM", "队列项必须包含有效的捕获时间。");
  }
  const capturedAt = new Date(capturedTime).toISOString();

  if (value.kind === "clip") {
    if (
      !["later", "collection"].includes(value.destination) ||
      !isRecord(value.page)
    ) {
      throw new HttpError(400, "INVALID_ITEM", "网页收藏队列项无效。");
    }
    const url = normalizeWebUrl(value.page.url);
    const contentType = value.page.contentType === undefined
      ? "article"
      : value.page.contentType;
    if (!["article", "video", "podcast"].includes(contentType)) {
      throw new HttpError(400, "INVALID_ITEM", "网页收藏队列项无效。");
    }
    const page = {
      url,
      title: cleanText(value.page.title, MAX_TITLE_LENGTH) || new URL(url).hostname,
      contentType,
    };
    for (const [key, limit] of [
      ["description", MAX_DESCRIPTION_LENGTH],
      ["selection", MAX_SELECTION_LENGTH],
      ["siteName", MAX_SITE_NAME_LENGTH],
    ]) {
      const normalized = cleanText(value.page[key], limit);
      if (normalized) page[key] = normalized;
    }
    const imageUrl = optionalWebUrl(value.page, "imageUrl");
    if (imageUrl) page.imageUrl = imageUrl;
    return {
      id,
      kind: "clip",
      capturedAt,
      destination: value.destination,
      page,
    };
  }
  if (value.kind === "source") {
    return {
      id,
      kind: "source",
      capturedAt,
      candidate: normalizeCandidate(value.candidate),
    };
  }
  if (value.kind === "follow-batch") {
    if (
      value.platform !== "bilibili" ||
      !Number.isSafeInteger(value.previousCount) ||
      value.previousCount < 0 ||
      value.previousCount > MAX_PREVIOUS_COUNT
    ) {
      throw new HttpError(400, "INVALID_ITEM", "关注批量队列项无效。");
    }
    return {
      id,
      kind: "follow-batch",
      capturedAt,
      platform: "bilibili",
      candidates: normalizeCandidateList(value.candidates, false),
      added: normalizeCandidateList(value.added),
      removed: normalizeCandidateList(value.removed),
      previousCount: value.previousCount,
    };
  }
  throw new HttpError(400, "INVALID_ITEM", "不支持这种队列项。");
}

function validateAckIds(value) {
  if (!Array.isArray(value) || value.length > MAX_QUEUE_ITEMS) {
    throw new HttpError(400, "INVALID_IDS", "确认列表无效。");
  }
  const ids = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || id.length > MAX_ITEM_ID_LENGTH) {
      throw new HttpError(400, "INVALID_IDS", "确认列表无效。");
    }
    ids.add(id);
  }
  return ids;
}

export async function createAssistantBridge({
  dataDir,
  productOrigins = DEFAULT_PRODUCT_ORIGINS,
  bootstrapSecret,
  extensionSession = null,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir) {
    throw new TypeError("createAssistantBridge requires a dataDir.");
  }
  if (
    typeof bootstrapSecret !== "string" ||
    bootstrapSecret.length < MIN_BOOTSTRAP_SECRET_LENGTH ||
    bootstrapSecret.length > MAX_BOOTSTRAP_SECRET_LENGTH
  ) {
    throw new TypeError("createAssistantBridge requires a valid bootstrapSecret.");
  }
  if (
    extensionSession !== null &&
    (
      typeof extensionSession !== "string" ||
      extensionSession.length < MIN_BOOTSTRAP_SECRET_LENGTH ||
      extensionSession.length > MAX_BOOTSTRAP_SECRET_LENGTH
    )
  ) {
    throw new TypeError("createAssistantBridge requires a valid extensionSession.");
  }

  const allowedOrigins = new Set(
    productOrigins.map(normalizeProductOrigin).filter(Boolean),
  );
  if (!allowedOrigins.size) {
    throw new TypeError("At least one valid loopback product origin is required.");
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = join(dataDir, STATE_FILE);
  let state = await loadState(dataDir, statePath);
  let mutationTail = Promise.resolve();

  function mutate(operation) {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function requireAuthentication(request, { allowNativeBootstrap = false } = {}) {
    const token = bearerToken(request);
    if (extensionSession !== null && bootstrapSecretMatches(extensionSession, token)) return;
    if (allowNativeBootstrap && bootstrapSecretMatches(
      bootstrapSecret,
      request.headers.get(NATIVE_BOOTSTRAP_HEADER),
    )) return;
    if (!(await pairingMatches(state.pairing, token))) {
      throw new HttpError(401, "UNAUTHORIZED", "本地连接会话无效或已过期。");
    }
  }

  function requireNativeBootstrap(request) {
    if (!bootstrapSecretMatches(
      bootstrapSecret,
      request.headers.get(NATIVE_BOOTSTRAP_HEADER),
    )) {
      throw new HttpError(
        403,
        "NATIVE_BOOTSTRAP_FORBIDDEN",
        "只有 Mac 原生应用可以修改桌面配对。",
      );
    }
  }

  async function handlePair(request) {
    requireNativeBootstrap(request);
    const payload = await readJson(request);
    if (!isRecord(payload)) {
      throw new HttpError(400, "INVALID_PAIRING", "配对请求无效。");
    }
    const shouldRevoke = payload.revoke === true || payload.pairingCode === null || payload.pairingCode === "";
    if (!shouldRevoke && (
      typeof payload.pairingCode !== "string" ||
      !payload.pairingCode.trim() ||
      payload.pairingCode.length > MAX_PAIRING_CODE_LENGTH
    )) {
      throw new HttpError(400, "INVALID_PAIRING", "配对码无效。");
    }

    return mutate(async () => {
      const nextState = {
        ...state,
        pairing: shouldRevoke ? null : await pairingRecord(payload.pairingCode),
      };
      await persistAtomically(dataDir, statePath, nextState);
      state = nextState;
      return json({ ok: true, paired: !shouldRevoke });
    });
  }

  async function handleEnqueue(request) {
    const payload = await readJson(request);
    return mutate(async () => {
      await requireAuthentication(request);
      const item = normalizeItem(payload?.item);
      const existing = state.queue.find((candidate) => candidate.id === item.id);
      if (existing) {
        return json({ ok: true, enqueued: false, duplicate: true, item: existing });
      }
      if (state.queue.length >= MAX_QUEUE_ITEMS) {
        throw new HttpError(409, "QUEUE_FULL", "桌面助手队列已达到 500 项上限。");
      }
      const nextState = { ...state, queue: [...state.queue, item] };
      await persistAtomically(dataDir, statePath, nextState);
      state = nextState;
      return json({ ok: true, enqueued: true, duplicate: false, item });
    });
  }

  async function handleQueue(request) {
    await mutationTail;
    await requireAuthentication(request, { allowNativeBootstrap: true });
    return json({ ok: true, items: state.queue });
  }

  async function handleAck(request) {
    const payload = await readJson(request);
    const ids = validateAckIds(payload?.ids);
    return mutate(async () => {
      await requireAuthentication(request, { allowNativeBootstrap: true });
      const nextQueue = state.queue.filter((item) => !ids.has(item.id));
      const acknowledged = state.queue.length - nextQueue.length;
      if (acknowledged > 0) {
        const nextState = { ...state, queue: nextQueue };
        await persistAtomically(dataDir, statePath, nextState);
        state = nextState;
      }
      return json({ ok: true, acknowledged });
    });
  }

  async function route(request, origin, isProductOrigin) {
    const pathname = new URL(request.url).pathname;
    const knownPath = [
      "/__our_choice/assistant/pair",
      "/__our_choice/assistant/enqueue",
      "/__our_choice/assistant/queue",
      "/__our_choice/assistant/ack",
    ].includes(pathname);
    if (!knownPath) return errorResponse(404, "NOT_FOUND", "未找到桌面助手端点。");

    if (request.method === "OPTIONS") {
      const headers = new Headers({
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `authorization, content-type, ${NATIVE_BOOTSTRAP_HEADER}`,
        "access-control-max-age": "600",
        "cache-control": "no-store",
        vary: "Origin",
      });
      headers.set("access-control-allow-origin", origin);
      return new Response(null, { status: 204, headers });
    }

    if (pathname === "/__our_choice/assistant/pair") {
      if (!isProductOrigin) return deniedOrigin();
      if (request.method !== "POST") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "配对端点只接受 POST。");
      }
      return handlePair(request);
    }
    if (pathname === "/__our_choice/assistant/enqueue") {
      if (request.method !== "POST") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "入队端点只接受 POST。");
      }
      return handleEnqueue(request);
    }
    if (pathname === "/__our_choice/assistant/queue") {
      if (!isProductOrigin) return deniedOrigin();
      if (request.method !== "GET") {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "队列端点只接受 GET。");
      }
      return handleQueue(request);
    }
    if (!isProductOrigin) return deniedOrigin();
    if (request.method !== "POST") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", "确认端点只接受 POST。");
    }
    return handleAck(request);
  }

  return {
    statePath,
    async handle(request) {
      const declaredOrigin = request.headers.get("origin") ?? "";
      const inferredProductOrigin = productOriginFromReferer(request, allowedOrigins);
      const origin = declaredOrigin || inferredProductOrigin;
      const isProductOrigin = allowedOrigins.has(origin);
      const isAllowedOrigin = isProductOrigin || isExtensionOrigin(origin);
      if (!isAllowedOrigin) return deniedOrigin();

      try {
        const response = await route(request, origin, isProductOrigin);
        return responseWithCors(response, origin, allowedOrigins);
      } catch (error) {
        const response = error instanceof HttpError
          ? errorResponse(error.status, error.code, error.message)
          : errorResponse(500, "INTERNAL_ERROR", "桌面助手暂时无法处理请求。");
        return responseWithCors(response, origin, allowedOrigins);
      }
    },
  };
}
