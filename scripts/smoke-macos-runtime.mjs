#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createRuntimeEnvironment(sourceEnvironment, {
  dataDirectory,
  webRoot,
  vinextRoot,
}) {
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    OUR_CHOICE_DATA_DIR: dataDirectory,
    OUR_CHOICE_PORT: "0",
    OUR_CHOICE_APP_VERSION: "smoke-test",
    OUR_CHOICE_WEB_ROOT: webRoot,
    OUR_CHOICE_VINEXT_ROOT: vinextRoot,
  };
  for (const name of ["HOME", "TMPDIR", "LANG"]) {
    const value = sourceEnvironment[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
}

function absolutePath(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function requirePath(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`找不到 ${label}：${path}`);
  }
}

function waitForReady(child, timeoutMilliseconds = 15_000) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      finish(rejectReady, new Error(`桌面运行时启动超时。\n${stderr}`));
    }, timeoutMilliseconds);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("OUR_CHOICE_READY ")) continue;
        try {
          finish(resolveReady, JSON.parse(line.slice("OUR_CHOICE_READY ".length)));
        } catch (error) {
          finish(rejectReady, error);
        }
      }
    });
    child.once("error", (error) => finish(rejectReady, error));
    child.once("exit", (code, signal) => {
      finish(
        rejectReady,
        new Error(`桌面运行时提前退出：code=${code} signal=${signal}\n${stderr}`),
      );
    });
  });
}

function exitedChild(child) {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

function waitForExit(child, timeoutMilliseconds) {
  const existing = exitedChild(child);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveExit) => {
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(null);
    }, timeoutMilliseconds);
    timeout.unref?.();
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  const existing = exitedChild(child);
  if (existing) return { ...existing, forced: false };
  child.kill("SIGTERM");
  const graceful = await waitForExit(child, 3_000);
  if (graceful) return { ...graceful, forced: false };
  child.kill("SIGKILL");
  const forced = await waitForExit(child, 3_000);
  if (!forced) throw new Error("发送 SIGKILL 后桌面运行时仍未退出。");
  return { ...forced, forced: true };
}

export function validateReadyPayload(ready) {
  assert.equal(ready?.host, "127.0.0.1", "desktop runtime host must be IPv4 loopback");
  assert.ok(
    Number.isInteger(ready?.port) && ready.port > 0 && ready.port <= 65_535,
    "desktop runtime port must be a valid TCP port",
  );
  const expectedURL = `http://127.0.0.1:${ready.port}`;
  assert.equal(
    ready?.url,
    expectedURL,
    "desktop runtime URL must be the exact canonical loopback origin",
  );
  return { host: ready.host, port: ready.port, url: ready.url };
}

export async function main() {
  const argument = process.argv[2];
  if (argument === "--help") {
    console.log("用法：node scripts/smoke-macos-runtime.mjs [Our Choice.app]");
    return;
  }
  if (process.argv.length > 3) throw new Error("只能指定一个 App 路径。");
  if (process.platform !== "darwin") throw new Error("macOS App 烟测只能在 macOS 主机运行。");

  const appPath = absolutePath(argument ?? "build/macos/Our Choice.app");
  const runtime = join(appPath, "Contents", "Resources", "runtime");
  const node = join(runtime, "node", "bin", "node");
  const server = join(runtime, "server.mjs");
  const webRoot = join(runtime, "web");
  const vinextRoot = join(runtime, "vinext", "dist");
  await requirePath(node, "App 内置 Node");
  await requirePath(server, "App 桌面服务器");
  await requirePath(join(webRoot, "dist"), "App 网站产物");
  await requirePath(join(vinextRoot, "server", "prod-server.js"), "App Vinext 运行时");

  const dataDirectory = await mkdtemp(join(tmpdir(), "our-choice-app-smoke-"));
  const child = spawn(node, [server], {
    cwd: webRoot,
    env: createRuntimeEnvironment(process.env, {
      dataDirectory,
      webRoot,
      vinextRoot,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let result;
  let shutdown;
  try {
    const ready = validateReadyPayload(await waitForReady(child));

    const healthResponse = await fetch(`${ready.url}/__our_choice/desktop/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.product, "our-choice-desktop");
    assert.equal(health.version, "smoke-test");

    const pageResponse = await fetch(ready.url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /<title>自选｜只看你主动选择的内容<\/title>/);

    const apiResponse = await fetch(`${ready.url}/api/source-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(apiResponse.status, 400);
    const apiError = await apiResponse.json();
    assert.equal(apiError?.error?.code, "INVALID_URL");

    result = {
      app: appPath,
      health,
      titleVerified: true,
      apiErrorCode: apiError.error.code,
    };
  } finally {
    shutdown = await stopChild(child);
    await rm(dataDirectory, { recursive: true, force: true });
  }
  assert.deepEqual(shutdown, { code: 0, signal: null, forced: false });
  console.log(JSON.stringify({ ...result, shutdown }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mac:smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
