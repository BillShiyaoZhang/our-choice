import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  verifyChromeWebStorePublication,
} from "../scripts/verify-chrome-web-store-publication.mjs";

const manifestPath = new URL("../browser-extension/manifest.json", import.meta.url);
const extensionId = "a".repeat(32);
const publisherId = "publisher-123";
const publishedName = `publishers/${publisherId}/items/${extensionId}`;

function baseEnvironment(overrides = {}) {
  return {
    OUR_CHOICE_CHROME_EXTENSION_ID: extensionId,
    OUR_CHOICE_CHROME_WEB_STORE_PUBLISHER_ID: publisherId,
    OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: "access-token-do-not-log",
    ...overrides,
  };
}

function publishedResponse(overrides = {}) {
  return {
    name: publishedName,
    itemId: extensionId,
    takenDown: false,
    warned: false,
    publishedItemRevisionStatus: {
      state: "PUBLISHED",
      distributionChannels: [
        { crxVersion: "0.2.0", deployPercentage: 100 },
      ],
    },
    ...overrides,
  };
}

async function startMockServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function verifyAgainst(origin, environment = baseEnvironment()) {
  return verifyChromeWebStorePublication({
    environment,
    manifestPath,
    apiOrigin: origin,
    tokenEndpoint: `${origin}/token`,
    timeoutMilliseconds: 2_000,
  });
}

test("fetchStatus proves the public store revision matches the source manifest", async (t) => {
  let requestCount = 0;
  const mock = await startMockServer((request, response) => {
    requestCount += 1;
    assert.equal(request.method, "GET");
    assert.equal(
      request.url,
      `/v2/publishers/${publisherId}/items/${extensionId}:fetchStatus`,
    );
    assert.equal(request.headers.authorization, "Bearer access-token-do-not-log");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(publishedResponse({
      publishedItemRevisionStatus: {
        state: "PUBLISHED",
        distributionChannels: [
          { crxVersion: "0.2.0", deployPercentage: 25 },
          { crxVersion: "0.2.0", deployPercentage: 75 },
        ],
      },
    })));
  });
  t.after(mock.close);

  const result = await verifyAgainst(mock.origin);

  assert.deepEqual(result, {
    extensionId,
    manifestVersion: "0.2.0",
    publishedVersion: "0.2.0",
    state: "PUBLISHED",
    deployPercentages: [25, 75],
  });
  assert.equal(requestCount, 1);
});

test("refresh credentials are exchanged without putting secrets in the URL", async (t) => {
  const seenURLs = [];
  const mock = await startMockServer(async (request, response) => {
    seenURLs.push(request.url);
    if (request.url === "/token") {
      assert.equal(request.method, "POST");
      assert.match(request.headers["content-type"], /^application\/x-www-form-urlencoded/);
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(
        Object.fromEntries(new URLSearchParams(body)),
        {
          client_id: "oauth-client-id",
          client_secret: "oauth-client-secret",
          grant_type: "refresh_token",
          refresh_token: "oauth-refresh-token",
        },
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        access_token: "refreshed-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      }));
      return;
    }
    assert.equal(request.headers.authorization, "Bearer refreshed-access-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(publishedResponse()));
  });
  t.after(mock.close);
  const environment = baseEnvironment({
    OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: undefined,
    OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID: "oauth-client-id",
    OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET: "oauth-client-secret",
    OUR_CHOICE_CHROME_WEB_STORE_REFRESH_TOKEN: "oauth-refresh-token",
  });

  await verifyAgainst(mock.origin, environment);

  assert.equal(seenURLs.length, 2);
  for (const url of seenURLs) {
    assert.doesNotMatch(url, /oauth|token-do-not-log|refresh-token|client-secret/);
  }
});

test("credential configuration is complete, unambiguous, and checked before network access", async () => {
  const unusedOrigin = "http://127.0.0.1:1";
  await assert.rejects(
    verifyAgainst(unusedOrigin, baseEnvironment({
      OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: undefined,
    })),
    /ACCESS_TOKEN|CLIENT_ID/,
  );
  await assert.rejects(
    verifyAgainst(unusedOrigin, baseEnvironment({
      OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID: "client",
      OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET: "secret",
      OUR_CHOICE_CHROME_WEB_STORE_REFRESH_TOKEN: "refresh",
    })),
    /同时|二选一|两种/,
  );
  await assert.rejects(
    verifyAgainst(unusedOrigin, baseEnvironment({
      OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: undefined,
      OUR_CHOICE_CHROME_WEB_STORE_CLIENT_ID: "client",
      OUR_CHOICE_CHROME_WEB_STORE_CLIENT_SECRET: "secret",
    })),
    /REFRESH_TOKEN/,
  );
  await assert.rejects(
    verifyAgainst(unusedOrigin, baseEnvironment({
      OUR_CHOICE_CHROME_EXTENSION_ID: "not-an-extension-id",
    })),
    /32/,
  );
});

test("non-public, unsafe, malformed, and version-skewed store states fail closed", async (t) => {
  const cases = [
    ["missing published revision", { publishedItemRevisionStatus: undefined }, /publishedItemRevisionStatus|公开发布/],
    ["trusted testers only", { publishedItemRevisionStatus: { state: "PUBLISHED_TO_TESTERS", distributionChannels: [{ crxVersion: "0.2.0", deployPercentage: 100 }] } }, /PUBLISHED/],
    ["taken down", { takenDown: true }, /下架|takenDown/],
    ["warned", { warned: true }, /警告|warned/],
    ["wrong item id", { itemId: "b".repeat(32) }, /itemId|身份/],
    ["wrong resource name", { name: `publishers/other/items/${extensionId}` }, /name|身份/],
    ["no channels", { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [] } }, /distributionChannels|通道/],
    ["version mismatch", { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.2.1", deployPercentage: 100 }] } }, /0\.2\.1|版本/],
    ["zero rollout", { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.2.0", deployPercentage: 0 }] } }, /部署|deployPercentage|0/],
    ["invalid rollout", { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.2.0", deployPercentage: 100.5 }] } }, /deployPercentage|整数/],
  ];

  for (const [label, overrides, expectedError] of cases) {
    await t.test(label, async (inner) => {
      const mock = await startMockServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(publishedResponse(overrides)));
      });
      inner.after(mock.close);
      await assert.rejects(verifyAgainst(mock.origin), expectedError);
    });
  }
});

test("HTTP and JSON diagnostics never echo access or refresh credentials", async (t) => {
  const accessSecret = "access-secret-never-print";
  const mock = await startMockServer((_request, response) => {
    response.statusCode = 401;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      error: `rejected ${accessSecret} oauth-refresh-token`,
    }));
  });
  t.after(mock.close);
  const environment = baseEnvironment({
    OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: accessSecret,
  });

  await assert.rejects(
    verifyAgainst(mock.origin, environment),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /access-secret-never-print|oauth-refresh-token/);
      return true;
    },
  );
});

test("untrusted fetchStatus fields are not copied into failure diagnostics", async (t) => {
  const accessSecret = "access-secret-never-print";
  const mock = await startMockServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(publishedResponse({
      publishedItemRevisionStatus: {
        state: accessSecret,
        distributionChannels: [
          { crxVersion: "0.2.0", deployPercentage: 100 },
        ],
      },
    })));
  });
  t.after(mock.close);
  const environment = baseEnvironment({
    OUR_CHOICE_CHROME_WEB_STORE_ACCESS_TOKEN: accessSecret,
  });

  await assert.rejects(
    verifyAgainst(mock.origin, environment),
    (error) => {
      assert.match(error.message, /PUBLISHED/);
      assert.doesNotMatch(error.message, /access-secret-never-print/);
      return true;
    },
  );
});

test("fetchStatus redirects are rejected without forwarding bearer credentials", async (t) => {
  let redirected = false;
  const mock = await startMockServer((request, response) => {
    if (request.url === "/redirect-target") {
      redirected = true;
      response.end("unexpected");
      return;
    }
    response.statusCode = 302;
    response.setHeader("location", "/redirect-target");
    response.end();
  });
  t.after(mock.close);

  await assert.rejects(verifyAgainst(mock.origin), /请求失败|重定向/);
  assert.equal(redirected, false);
});
