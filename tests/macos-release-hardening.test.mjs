import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectPrivateNotarizationLog,
  copyVerifiedReleaseCandidate,
  parseArguments as parsePackageArguments,
  validateOutputPackagePath,
} from "../scripts/package-macos.mjs";
import {
  parseArguments as parsePrepareArguments,
} from "../scripts/prepare-macos-release.mjs";
import {
  validateExactEntitlements,
} from "../scripts/macos-entitlements-validation.mjs";
import {
  validateReadyPayload,
} from "../scripts/smoke-macos-runtime.mjs";
import {
  verifyReleaseCandidateManifest,
  writeReleaseCandidateManifest,
} from "../scripts/macos-release-candidate.mjs";

test("formal packager copies the frozen candidate before verifying the signing copy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-copy-verify-"));
  const source = join(directory, "Prepared.app");
  const destination = join(directory, "private", "Our Choice.app");
  const manifest = join(directory, "Prepared.integrity.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(join(source, "Contents"), { recursive: true });
  await writeFile(join(source, "Contents", "Info.plist"), "trusted\n");
  await writeReleaseCandidateManifest(source, manifest);

  await copyVerifiedReleaseCandidate(source, destination, manifest);
  await writeFile(join(source, "Contents", "Info.plist"), "mutated after copy\n");

  assert.equal(await readFile(join(destination, "Contents", "Info.plist"), "utf8"), "trusted\n");
});

test("release candidate manifests reject symlinks that escape the App bundle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-candidate-link-"));
  const app = join(directory, "Prepared.app");
  const manifest = join(directory, "Prepared.integrity.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await mkdir(join(app, "Contents"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), "trusted\n");
  await symlink("Info.plist", join(app, "Contents", "safe-link"));
  await writeReleaseCandidateManifest(app, manifest);
  await verifyReleaseCandidateManifest(app, manifest);

  await symlink("../../../outside", join(app, "Contents", "escape-link"));
  await assert.rejects(
    writeReleaseCandidateManifest(app, manifest),
    /符号链接不得逃逸 App/,
  );
});

test("unnotarized output always uses the unmistakable fixed basename", () => {
  assert.doesNotThrow(() => validateOutputPackagePath(
    "/tmp/review/Our-Choice-signed-unnotarized.pkg",
    { skipNotarization: true },
  ));
  for (const disguised of [
    "/tmp/review/Our-Choice.pkg",
    "/tmp/review/our-choice.pkg",
    "/tmp/review/OUR-CHOICE.PKG",
    "/tmp/review/Our-Choice-signed-unnotarized.PKG",
    "/tmp/review/custom.pkg",
  ]) {
    assert.throws(
      () => validateOutputPackagePath(disguised, { skipNotarization: true }),
      /Our-Choice-signed-unnotarized\.pkg/,
    );
  }
});

test("formal and preparation argument parsers reject unknown, malformed, and ambiguous options", () => {
  for (const parse of [parsePackageArguments, parsePrepareArguments]) {
    assert.throws(() => parse(["--unknown", "value"]), /未知参数：--unknown/);
    assert.throws(() => parse(["--skip-notarization=false"]), /不接受值/);
    assert.throws(() => parse(["--out", "--help"]), /参数 --out 缺少值/);
    assert.throws(() => parse(["--out", "one.pkg", "--out", "two.pkg"]), /重复参数：--out/);
  }
});

test("exact entitlement allowlists reject extra keys and non-boolean expected values", () => {
  const safari = `[Dict]
\t[Key] com.apple.security.app-sandbox
\t[Value]
\t\t[Bool] true
`;
  assert.doesNotThrow(() => validateExactEntitlements(
    safari,
    ["com.apple.security.app-sandbox"],
    "Safari 扩展（arm64）",
  ));
  assert.throws(
    () => validateExactEntitlements(
      `${safari}\t[Key] com.apple.security.get-task-allow\n\t[Value]\n\t\t[Bool] false\n`,
      ["com.apple.security.app-sandbox"],
      "Safari 扩展（arm64）",
    ),
    /entitlement 白名单不匹配.*get-task-allow/,
  );
  assert.throws(
    () => validateExactEntitlements(
      "<plist><dict><key>com.apple.security.app-sandbox</key><false/></dict></plist>",
      ["com.apple.security.app-sandbox"],
      "Safari 扩展（x86_64）",
    ),
    /必须显式启用 entitlement/,
  );
  assert.doesNotThrow(() => validateExactEntitlements(
    "Executable=/Applications/Our Choice.app/Contents/MacOS/Our Choice\n",
    [],
    "主应用（arm64）",
  ));
});

test("notary raw log stays in a 0700 directory, stable diagnostics are 0600, and raw data is removed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-notary-log-test-"));
  const diagnostic = join(directory, "Our-Choice.notary-log.json");
  let rawDirectory;
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await collectPrivateNotarizationLog({
    workDirectory: directory,
    diagnosticPath: diagnostic,
    credentials: { keyID: "SECRET_KEY_ID" },
    fetchLog: async (rawPath) => {
      rawDirectory = join(rawPath, "..");
      assert.equal((await stat(rawDirectory)).mode & 0o777, 0o700);
      await writeFile(rawPath, JSON.stringify({ status: "Accepted", secret: "SECRET_KEY_ID" }));
    },
  });

  assert.equal(result.status, "Accepted");
  assert.equal((await stat(diagnostic)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(diagnostic, "utf8"), /SECRET_KEY_ID/);
  await assert.rejects(stat(rawDirectory), { code: "ENOENT" });
});

test("notary raw log directory is removed when retrieval fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-notary-log-fail-"));
  const diagnostic = join(directory, "Our-Choice.notary-log.json");
  let rawDirectory;
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    collectPrivateNotarizationLog({
      workDirectory: directory,
      diagnosticPath: diagnostic,
      credentials: { profile: "SECRET_PROFILE" },
      fetchLog: async (rawPath) => {
        rawDirectory = join(rawPath, "..");
        await writeFile(rawPath, "SECRET_PROFILE");
        throw new Error("download exposed SECRET_PROFILE");
      },
    }),
    /notarytool log failed/,
  );

  assert.equal((await stat(diagnostic)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(diagnostic, "utf8"), /SECRET_PROFILE/);
  await assert.rejects(stat(rawDirectory), { code: "ENOENT" });
});

test("runtime smoke accepts only the exact canonical loopback ready URL", () => {
  assert.deepEqual(
    validateReadyPayload({ host: "127.0.0.1", port: 49152, url: "http://127.0.0.1:49152" }),
    { host: "127.0.0.1", port: 49152, url: "http://127.0.0.1:49152" },
  );
  for (const url of [
    "http://localhost:49152",
    "http://127.0.0.1:49152/",
    "http://127.0.0.1:49152/path",
    "http://127.0.0.1:49152?query=1",
    "http://user@127.0.0.1:49152",
  ]) {
    assert.throws(
      () => validateReadyPayload({ host: "127.0.0.1", port: 49152, url }),
      /canonical loopback origin/,
    );
  }
});
