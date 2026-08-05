#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { validateExtensionVersion } from "./chrome-extension-package-validation.mjs";

const officialAPIOrigin = "https://chromewebstore.googleapis.com";
const officialTokenEndpoint = "https://oauth2.googleapis.com/token";
const defaultManifestPath = new URL("../browser-extension/manifest.json", import.meta.url);
const extensionIdPattern = /^[a-p]{32}$/;
const maximumResponseBytes = 1024 * 1024;
const defaultTimeoutMilliseconds = 15_000;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalEnvironmentText(environment, name) {
  const value = environment[name];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") fail(`${name} 必须是字符串。`);
  if (value.length > 65_536 || /[\0\r\n]/.test(value)) {
    fail(`${name} 格式非法。`);
  }
  return value;
}

function requiredEnvironmentText(environment, name) {
  const value = optionalEnvironmentText(environment, name);
  if (!value) fail(`缺少 ${name}。`);
  return value;
}

function validateExtensionId(value) {
  if (!extensionIdPattern.test(value)) {
    fail("OUR_CHOICE_CHROME_EXTENSION_ID 必须是 32 位 [a-p] Chrome 扩展 ID。");
  }
  return value;
}

function validatePublisherId(value) {
  if (
    value.length > 256
    || value.trim() !== value
    || /[/\\\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("OUR_CHOICE_CHROME_WEB_STORE_PUBLISHER_ID 必须是安全的非空路径段。");
  }
  return value;
}

function validateAccessToken(value, label) {
  if (value.length > 16_384 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} 格式非法。`);
  }
  return value;
}

export function resolveChromeWebStoreCredentials(environment = process.env) {
  const accessToken = optionalEnvironmentText(
    environment,
    "OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN",
  );
  const refreshValues = {
    clientId: optionalEnvironmentText(
      environment,
      "OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID",
    ),
    clientSecret: optionalEnvironmentText(
      environment,
      "OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET",
    ),
    refreshToken: optionalEnvironmentText(
      environment,
      "OUR_CHOICE_CHROME_WEB_STORE_REFRESH_TOKEN",
    ),
  };
  const configuredRefreshFields = Object.values(refreshValues).filter(Boolean).length;

  if (accessToken && configuredRefreshFields > 0) {
    fail("Chrome Web Store 短期 access token 与 OAuth 刷新凭据必须二选一，不得同时配置。");
  }
  if (accessToken) {
    return {
      mode: "access-token",
      accessToken: validateAccessToken(
        accessToken,
        "OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN",
      ),
    };
  }
  if (configuredRefreshFields === 0) {
    fail(
      "缺少 OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN，或完整的 CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN 刷新凭据。",
    );
  }
  const missing = [];
  if (!refreshValues.clientId) missing.push("OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID");
  if (!refreshValues.clientSecret) missing.push("OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET");
  if (!refreshValues.refreshToken) missing.push("OUR_CHOICE_CHROME_WEB_STORE_REFRESH_TOKEN");
  if (missing.length > 0) fail(`Chrome Web Store OAuth 刷新凭据不完整，缺少 ${missing.join(", ")}。`);
  return { mode: "refresh-token", ...refreshValues };
}

function validateEndpoint(value, label, { requireOriginOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} 不是有效 URL。`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    fail(`${label} 必须是无凭据的 HTTP(S) URL。`);
  }
  if (
    requireOriginOnly
    && (url.pathname !== "/" || url.search || url.hash)
  ) {
    fail(`${label} 必须只包含 origin。`);
  }
  return url;
}

async function readBoundedJSON(response, label) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumResponseBytes)
  ) {
    fail(`${label} 响应过大或 Content-Length 非法。`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(contentType)) {
    fail(`${label} 未返回 JSON Content-Type。`);
  }

  if (!response.body) fail(`${label} 响应体为空。`);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumResponseBytes) {
      await reader.cancel();
      fail(`${label} 响应超过 ${maximumResponseBytes} 字节。`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} 响应不是有效 UTF-8。`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`${label} 返回的不是有效 JSON。`);
  }
  if (!isObject(value)) fail(`${label} JSON 根值必须是对象。`);
  return value;
}

async function requestJSON(
  fetchImpl,
  url,
  options,
  { label, timeoutMilliseconds },
) {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) {
    fail("请求超时必须是 1..120000 毫秒的整数。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      fail(`${label} 请求失败或超时；不允许重定向。`);
    }
    if (!response.ok) fail(`${label} 返回 HTTP ${response.status}。`);
    return await readBoundedJSON(response, label);
  } catch (error) {
    if (error instanceof Error) throw error;
    fail(`${label} 请求失败。`);
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeRefreshToken(
  credentials,
  { fetchImpl, tokenEndpoint, timeoutMilliseconds },
) {
  const endpoint = validateEndpoint(tokenEndpoint, "OAuth token endpoint");
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });
  const response = await requestJSON(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
    { label: "Chrome Web Store OAuth token endpoint", timeoutMilliseconds },
  );
  if (response.token_type !== undefined && response.token_type !== "Bearer") {
    fail("Chrome Web Store OAuth token endpoint 返回了非 Bearer token。");
  }
  if (typeof response.access_token !== "string" || !response.access_token) {
    fail("Chrome Web Store OAuth token endpoint 响应缺少 access_token。");
  }
  return validateAccessToken(response.access_token, "OAuth access_token");
}

async function readManifestVersion(manifestPath) {
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch {
    fail("无法读取 browser-extension/manifest.json。");
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail("browser-extension/manifest.json 不是有效 JSON。");
  }
  if (!isObject(manifest) || manifest.manifest_version !== 3) {
    fail("browser-extension/manifest.json 必须是 Manifest V3。");
  }
  return validateExtensionVersion(manifest.version, "源 Manifest 版本");
}

function validatePublicationStatus(response, { extensionId, publisherId, manifestVersion }) {
  const expectedName = `publishers/${publisherId}/items/${extensionId}`;
  if (response.name !== expectedName) {
    fail("Chrome Web Store fetchStatus 返回的 name 与请求身份不一致。");
  }
  if (response.itemId !== extensionId) {
    fail("Chrome Web Store fetchStatus 返回的 itemId 与请求身份不一致。");
  }
  for (const field of ["takenDown", "warned"]) {
    if (response[field] !== undefined && typeof response[field] !== "boolean") {
      fail(`Chrome Web Store fetchStatus 的 ${field} 必须是布尔值。`);
    }
  }
  if (response.takenDown === true) {
    fail("Chrome Web Store item 已下架（takenDown），不得发布 PKG。");
  }
  if (response.warned === true) {
    fail("Chrome Web Store item 存在政策警告（warned），不得发布 PKG。");
  }

  const published = response.publishedItemRevisionStatus;
  if (!isObject(published)) {
    fail("Chrome Web Store item 没有 publishedItemRevisionStatus，尚未公开发布。");
  }
  if (published.state !== "PUBLISHED") {
    fail("Chrome Web Store 已发布修订状态必须为 PUBLISHED。");
  }
  const channels = published.distributionChannels;
  if (!Array.isArray(channels) || channels.length === 0) {
    fail("Chrome Web Store 已发布修订必须包含非空 distributionChannels。");
  }

  const deployPercentages = [];
  const publishedVersions = new Set();
  for (const [index, channel] of channels.entries()) {
    if (!isObject(channel)) {
      fail(`Chrome Web Store distributionChannels[${index}] 必须是对象。`);
    }
    let version;
    try {
      version = validateExtensionVersion(
        channel.crxVersion,
        `Chrome Web Store distributionChannels[${index}].crxVersion`,
      );
    } catch {
      fail(`Chrome Web Store distributionChannels[${index}].crxVersion 格式非法。`);
    }
    publishedVersions.add(version);
    if (
      !Number.isInteger(channel.deployPercentage)
      || channel.deployPercentage < 0
      || channel.deployPercentage > 100
    ) {
      fail(`Chrome Web Store distributionChannels[${index}].deployPercentage 必须是 0..100 的整数。`);
    }
    deployPercentages.push(channel.deployPercentage);
  }
  if (publishedVersions.size !== 1 || !publishedVersions.has(manifestVersion)) {
    fail(`Chrome Web Store 已发布版本与源 Manifest ${manifestVersion} 不一致。`);
  }
  if (!deployPercentages.some((percentage) => percentage > 0)) {
    fail("Chrome Web Store 已发布修订的部署比例全为 0。");
  }

  return {
    extensionId,
    manifestVersion,
    publishedVersion: manifestVersion,
    state: "PUBLISHED",
    deployPercentages,
  };
}

export async function verifyChromeWebStorePublication({
  environment = process.env,
  manifestPath = defaultManifestPath,
  fetchImpl = globalThis.fetch,
  apiOrigin = officialAPIOrigin,
  tokenEndpoint = officialTokenEndpoint,
  timeoutMilliseconds = defaultTimeoutMilliseconds,
} = {}) {
  if (typeof fetchImpl !== "function") fail("Chrome Web Store 门禁需要 fetch 实现。");
  const extensionId = validateExtensionId(
    requiredEnvironmentText(environment, "OUR_CHOICE_CHROME_EXTENSION_ID"),
  );
  const publisherId = validatePublisherId(
    requiredEnvironmentText(environment, "OUR_CHOICE_CHROME_WEB_STORE_PUBLISHER_ID"),
  );
  const credentials = resolveChromeWebStoreCredentials(environment);
  const manifestVersion = await readManifestVersion(manifestPath);
  const accessToken = credentials.mode === "access-token"
    ? credentials.accessToken
    : await exchangeRefreshToken(credentials, {
      fetchImpl,
      tokenEndpoint,
      timeoutMilliseconds,
    });
  const api = validateEndpoint(apiOrigin, "Chrome Web Store API origin", {
    requireOriginOnly: true,
  });
  const endpoint = new URL(
    `/v2/publishers/${encodeURIComponent(publisherId)}/items/${extensionId}:fetchStatus`,
    api,
  );
  const response = await requestJSON(
    fetchImpl,
    endpoint,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    },
    { label: "Chrome Web Store fetchStatus", timeoutMilliseconds },
  );
  return validatePublicationStatus(response, {
    extensionId,
    publisherId,
    manifestVersion,
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

async function main() {
  if (process.argv.length !== 2) {
    fail("用法：node scripts/verify-chrome-web-store-publication.mjs（所有 ID 与凭据均通过环境变量提供）");
  }
  const result = await verifyChromeWebStorePublication();
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "未知错误。";
    console.error(`[chrome-web-store-publication] ${message}`);
    process.exitCode = 1;
  });
}
