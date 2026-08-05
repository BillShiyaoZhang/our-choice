import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, request as requestHttp } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { createAssistantBridge, isExtensionOrigin } from "./assistant-bridge.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const AUTOMATIC_PORT_COUNT = 32;
const HEALTH_PATH = "/__our_choice/desktop/health";
const ASSISTANT_PREFIX = "/__our_choice/assistant/";
const EXTENSION_SESSION_REQUEST_HEADER = "x-our-choice-extension-session";
const MAX_PARENT_PID = 2_147_483_647;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function validParentPID(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_PARENT_PID ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parentPID = Number(value);
  return Number.isSafeInteger(parentPID) && parentPID > 0 && parentPID <= MAX_PARENT_PID
    ? parentPID
    : null;
}

export function startParentProcessMonitor({
  expectedParentPID = process.env.OUR_CHOICE_PARENT_PID,
  currentParentPID = () => process.ppid,
  onParentExit,
  schedule = setInterval,
  cancelSchedule = clearInterval,
  intervalMilliseconds = 500,
} = {}) {
  const expected = validParentPID(expectedParentPID);
  if (expected === null || typeof onParentExit !== "function") {
    return { stop() {} };
  }

  let active = true;
  let timer;
  const check = () => {
    if (!active) return;
    let observed;
    try {
      observed = currentParentPID();
    } catch {
      observed = null;
    }
    if (observed === expected) return;
    active = false;
    if (timer !== undefined) cancelSchedule(timer);
    onParentExit({ expectedParentPID: expected, observedParentPID: observed });
  };
  timer = schedule(check, intervalMilliseconds);
  timer?.unref?.();
  check();

  return {
    stop() {
      if (!active) return;
      active = false;
      if (timer !== undefined) cancelSchedule(timer);
    },
  };
}

function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function desktopPortCandidates(port, automatic = false) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!automatic) return [port];
  if (port !== DEFAULT_PORT || port + AUTOMATIC_PORT_COUNT - 1 > 65_535) {
    throw new Error(`自动端口范围必须从 ${DEFAULT_PORT} 开始。`);
  }
  return Array.from({ length: AUTOMATIC_PORT_COUNT }, (_, index) => port + index);
}

async function applicationVersion(webRoot) {
  const configuredVersion = process.env.OUR_CHOICE_APP_VERSION ?? process.env.OUR_CHOICE_VERSION;
  if (configuredVersion) return configuredVersion;
  try {
    const packageJson = JSON.parse(await readFile(join(webRoot, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

async function listenOnFirstAvailablePort(candidates) {
  let lastError;
  for (const candidate of candidates) {
    const server = createServer();
    try {
      await listen(server, candidate);
      return server;
    } catch (error) {
      lastError = error;
      await closeServer(server);
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  if (lastError) {
    lastError.message = `Desktop ports ${candidates[0]}...${candidates.at(-1)} are already in use.`;
    throw lastError;
  }
  throw new Error("No desktop port candidates were provided.");
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
    server.closeIdleConnections?.();
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 2_000);
    timer.unref?.();
  });
}

function requestUrl(incoming, publicOrigin) {
  const parsed = new URL(incoming.url ?? "/", "http://localhost");
  return new URL(`${parsed.pathname}${parsed.search}`, publicOrigin);
}

function webRequest(incoming, publicOrigin) {
  const method = incoming.method ?? "GET";
  const init = {
    method,
    headers: incoming.headers,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(incoming);
    init.duplex = "half";
  }
  return new Request(requestUrl(incoming, publicOrigin), init);
}

function sendWebResponse(response, outgoing) {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (!response.body) {
    outgoing.end();
    return;
  }
  Readable.fromWeb(response.body).on("error", (error) => {
    outgoing.destroy(error);
  }).pipe(outgoing);
}

function proxyRequest(incoming, outgoing, internalPort) {
  const headers = { ...incoming.headers };
  const originalHost = incoming.headers.host ?? "localhost:3000";
  headers.host = originalHost;
  headers["x-forwarded-host"] = originalHost;
  headers["x-forwarded-proto"] = "http";

  const upstream = requestHttp({
    host: LOOPBACK_HOST,
    port: internalPort,
    method: incoming.method,
    path: incoming.url,
    headers,
  }, (upstreamResponse) => {
    outgoing.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(outgoing);
  });

  upstream.on("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    if (!outgoing.writableEnded) {
      outgoing.end(JSON.stringify({
        ok: false,
        error: { code: "UPSTREAM_UNAVAILABLE", message: "本地网站服务暂时不可用。" },
      }));
    }
    incoming.destroy();
  });
  incoming.pipe(upstream);
}

export function desktopHealthResponse(
  version,
  extensionSession,
  origin = "",
  extensionSessionRequested = false,
) {
  const extensionOrigin = isExtensionOrigin(origin);
  const extensionRequest = extensionSessionRequested && (!origin || extensionOrigin);
  const payload = {
    ok: true,
    product: "our-choice-desktop",
    version,
    ...(extensionRequest ? { extensionSession } : {}),
  };
  const headers = new Headers({ "cache-control": "no-store" });
  if (extensionOrigin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return Response.json(payload, {
    headers,
  });
}

export function desktopHealthPreflightResponse(origin, requestedHeaders = "") {
  const requested = requestedHeaders
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!isExtensionOrigin(origin) || !requested.includes(EXTENSION_SESSION_REQUEST_HEADER)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": EXTENSION_SESSION_REQUEST_HEADER,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    },
  });
}

async function waitForHealth(url, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload.product === "our-choice-desktop") return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw lastError ?? new Error("Desktop health check did not become ready.");
}

export async function startDesktopServer({
  dataDir = process.env.OUR_CHOICE_DATA_DIR ?? join(
    homedir(),
    "Library",
    "Application Support",
    "Our Choice",
  ),
  port = parsePort(process.env.OUR_CHOICE_PORT, DEFAULT_PORT),
  automaticPort = !process.env.OUR_CHOICE_PORT && port === DEFAULT_PORT,
  webRoot = resolve(process.env.OUR_CHOICE_WEB_ROOT ?? join(moduleDirectory, "../web")),
  vinextRoot = resolve(
    process.env.OUR_CHOICE_VINEXT_ROOT ?? join(moduleDirectory, "vinext/dist"),
  ),
  bootstrapSecret = process.env.OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET ??
    randomBytes(32).toString("base64url"),
  extensionSession = randomBytes(32).toString("base64url"),
} = {}) {
  const requestedPort = typeof port === "number" ? port : parsePort(String(port), DEFAULT_PORT);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
  const version = await applicationVersion(webRoot);
  const productionServerModule = await import(
    pathToFileURL(join(vinextRoot, "server/prod-server.js")).href
  );
  if (typeof productionServerModule.startProdServer !== "function") {
    throw new Error("The packaged Vinext runtime does not export startProdServer.");
  }

  let vinext;
  let proxy;
  try {
    vinext = await productionServerModule.startProdServer({
      port: 0,
      host: LOOPBACK_HOST,
      outDir: join(webRoot, "dist"),
      purpose: "Our Choice desktop internal server",
    });

    proxy = await listenOnFirstAvailablePort(
      desktopPortCandidates(requestedPort, automaticPort),
    );
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Desktop proxy did not expose a TCP address.");
    }
    const publicPort = address.port;
    const publicUrl = `http://${LOOPBACK_HOST}:${publicPort}`;
    const assistantBridge = await createAssistantBridge({
      dataDir,
      bootstrapSecret,
      extensionSession,
      productOrigins: [
        `http://localhost:${publicPort}`,
        `http://127.0.0.1:${publicPort}`,
      ],
    });

    proxy.on("request", (incoming, outgoing) => {
      void (async () => {
        const pathname = new URL(incoming.url ?? "/", "http://localhost").pathname;
        if (pathname === HEALTH_PATH) {
          if (incoming.method === "OPTIONS") {
            sendWebResponse(desktopHealthPreflightResponse(
              incoming.headers.origin ?? "",
              incoming.headers["access-control-request-headers"] ?? "",
            ), outgoing);
            return;
          }
          if (incoming.method !== "GET" && incoming.method !== "HEAD") {
            sendWebResponse(new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }), outgoing);
            return;
          }
          const response = desktopHealthResponse(
            version,
            extensionSession,
            incoming.headers.origin ?? "",
            incoming.headers[EXTENSION_SESSION_REQUEST_HEADER] === "request",
          );
          sendWebResponse(incoming.method === "HEAD"
            ? new Response(null, { status: response.status, headers: response.headers })
            : response, outgoing);
          return;
        }
        if (pathname.startsWith(ASSISTANT_PREFIX)) {
          sendWebResponse(await assistantBridge.handle(webRequest(incoming, publicUrl)), outgoing);
          return;
        }
        proxyRequest(incoming, outgoing, vinext.port);
      })().catch((error) => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        if (!outgoing.writableEnded) {
          outgoing.end(JSON.stringify({
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "桌面运行时发生错误。" },
          }));
        }
        console.error("[our-choice-desktop] request failed:", error);
      });
    });

    await waitForHealth(`${publicUrl}${HEALTH_PATH}`);
    return {
      host: LOOPBACK_HOST,
      port: publicPort,
      url: publicUrl,
      internalPort: vinext.port,
      version,
      async close() {
        await closeServer(proxy);
        await closeServer(vinext.server);
      },
    };
  } catch (error) {
    await closeServer(proxy);
    await closeServer(vinext?.server);
    throw error;
  }
}

export function createShutdownCoordinator({
  closeRuntime,
  stopParentMonitor = () => {},
  scheduleForceExit = setTimeout,
  cancelForceExit = clearTimeout,
  exit = (code) => process.exit(code),
  setExitCode = (code) => { process.exitCode = code; },
  reportError = (...args) => console.error(...args),
} = {}) {
  if (typeof closeRuntime !== "function") {
    throw new TypeError("createShutdownCoordinator requires closeRuntime.");
  }

  let shutdownPromise;
  let forceExitTimer;
  let forceExitArmed = false;

  function armForceExit(signal) {
    if (forceExitArmed) return;
    forceExitArmed = true;
    forceExitTimer = scheduleForceExit(() => {
      reportError(`[our-choice-desktop] forced exit after ${signal}`);
      exit(1);
    }, 3_000);
  }

  function shutdown(signal, { forceExit = false } = {}) {
    if (forceExit) armForceExit(signal);
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      try {
        await closeRuntime();
        setExitCode(0);
      } catch (error) {
        reportError(`[our-choice-desktop] failed to stop after ${signal}:`, error);
        setExitCode(1);
      } finally {
        stopParentMonitor();
        if (forceExitTimer !== undefined) {
          cancelForceExit(forceExitTimer);
        }
      }
    })();
    return shutdownPromise;
  }

  return {
    shutdown,
    get isShuttingDown() { return shutdownPromise !== undefined; },
  };
}

async function main() {
  let runtime;
  let parentMonitor;
  let settleRuntimeStartup;
  const runtimeStartupSettled = new Promise((resolveStartup) => {
    settleRuntimeStartup = resolveStartup;
  });
  const shutdownCoordinator = createShutdownCoordinator({
    closeRuntime: async () => {
      await runtimeStartupSettled;
      await runtime?.close();
    },
    stopParentMonitor: () => parentMonitor?.stop(),
  });

  process.once("SIGINT", () => { void shutdownCoordinator.shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdownCoordinator.shutdown("SIGTERM"); });

  parentMonitor = startParentProcessMonitor({
    onParentExit: ({ expectedParentPID, observedParentPID }) => {
      console.error(
        `[our-choice-desktop] parent ${expectedParentPID} exited; current parent is ${observedParentPID ?? "unknown"}`,
      );
      void shutdownCoordinator.shutdown("parent exit", { forceExit: true });
    },
  });

  try {
    runtime = await startDesktopServer();
  } catch (error) {
    settleRuntimeStartup();
    parentMonitor.stop();
    throw error;
  }
  settleRuntimeStartup();
  if (shutdownCoordinator.isShuttingDown) {
    await shutdownCoordinator.shutdown("startup completed during shutdown");
    return;
  }
  process.stdout.write(`OUR_CHOICE_READY ${JSON.stringify({
    host: runtime.host,
    port: runtime.port,
    url: runtime.url,
    version: runtime.version,
  })}\n`);
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const isMain = process.argv[1]
  && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    const message = error?.code === "EADDRINUSE"
      ? `Port ${process.env.OUR_CHOICE_PORT ?? DEFAULT_PORT} is already in use; the desktop app did not stop the owning process.`
      : error?.stack ?? String(error);
    console.error(`[our-choice-desktop] ${message}`);
    process.exitCode = 1;
  });
}
