import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Script } from "node:vm";
import { verifySafariAppexResources } from "../scripts/safari-extension-resources.mjs";
import {
  requireExactDirectoryEntries,
  verifyBomAllowlist,
} from "../scripts/macos-payload-validation.mjs";
import {
  SAFARI_EXTENSION_BUNDLE_NAME,
  SAFARI_EXTENSION_DISPLAY_NAME,
  validateSafariExtensionDisplayMetadata,
} from "../scripts/safari-extension-metadata.mjs";
import {
  validatePackageInfoRootAttributes,
} from "../scripts/macos-distribution-validation.mjs";
import {
  validateLocalAppMinimumSystemVersion,
  validateLocalDistributionRequirements,
} from "../scripts/verify-macos-local-package.mjs";
import { hasEnabledEntitlement } from "../scripts/verify-macos-package.mjs";
import { validateMacOSAppIcon } from "../scripts/macos-app-icon.mjs";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("formal macOS Chrome delivery supports explicit manual or store modes", async () => {
  const {
    resolvePackagingChromeExtensionID,
    resolveVerifierChromeExtensionID,
  } = await import("../scripts/macos-chrome-registration.mjs");
  const extensionID = "a".repeat(32);

  assert.equal(
    resolvePackagingChromeExtensionID(extensionID, { skipNotarization: false }),
    extensionID,
  );
  assert.equal(
    resolvePackagingChromeExtensionID(undefined, { skipNotarization: false }),
    null,
  );
  assert.throws(
    () => resolvePackagingChromeExtensionID("a".repeat(31), { skipNotarization: true }),
    /32 位 Chrome 扩展 ID/,
    "even the development path must reject a supplied malformed ID",
  );

  assert.equal(
    resolveVerifierChromeExtensionID(extensionID, {
      allowUnnotarized: false,
      manualChromeInstall: false,
    }),
    extensionID,
  );
  assert.throws(
    () => resolveVerifierChromeExtensionID(undefined, {
      allowUnnotarized: false,
      manualChromeInstall: false,
    }),
    /需要 OUR_CHOICE_CHROME_EXTENSION_ID.*--manual-chrome-install/,
  );
  assert.equal(
    resolveVerifierChromeExtensionID(undefined, {
      allowUnnotarized: false,
      manualChromeInstall: true,
    }),
    null,
  );
  assert.throws(
    () => resolveVerifierChromeExtensionID(extensionID, {
      allowUnnotarized: false,
      manualChromeInstall: true,
    }),
    /manual.*OUR_CHOICE_CHROME_EXTENSION_ID/,
  );
});

test("formal macOS npm entrypoint rejects malformed Chrome IDs but permits manual delivery", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "our-choice-release-entry-"));
  const marker = join(temporaryDirectory, "npm-was-called");
  const fakeNpm = join(temporaryDirectory, "npm");
  const entrypoint = fileURLToPath(
    new URL("../scripts/package-macos-release.mjs", import.meta.url),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  await writeFile(
    fakeNpm,
    `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 99\n`,
    { mode: 0o755 },
  );

  const environment = {
    ...process.env,
    PATH: temporaryDirectory,
    OUR_CHOICE_CHROME_EXTENSION_ID: "a".repeat(31),
  };
  await assert.rejects(
    run(process.execPath, [entrypoint], {
      cwd: new URL("..", import.meta.url),
      env: environment,
    }),
    /32 位 Chrome 扩展 ID/,
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  environment.OUR_CHOICE_CHROME_EXTENSION_ID = "";
  await assert.rejects(
    run(process.execPath, [entrypoint], {
      cwd: new URL("..", import.meta.url),
      env: environment,
    }),
    /mac:build.*99/,
  );
  assert.equal((await readFile(marker)).length, 0);
});

test("release candidate integrity manifest rejects mutation and extra files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-release-candidate-"));
  const app = join(directory, "Prepared.app");
  const manifest = join(directory, "Prepared.integrity.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), "plist-v1\n");
  await writeFile(join(app, "Contents", "MacOS", "Our Choice"), "binary-v1\n", {
    mode: 0o755,
  });

  const candidate = await import("../scripts/macos-release-candidate.mjs");
  const frozen = await candidate.writeReleaseCandidateManifest(app, manifest);
  assert.equal(frozen.entries.length, 4);
  await candidate.verifyReleaseCandidateManifest(app, manifest);

  await writeFile(join(app, "Contents", "Info.plist"), "plist-mutated\n");
  await assert.rejects(
    candidate.verifyReleaseCandidateManifest(app, manifest),
    /发行候选件完整性不匹配/,
  );
  await writeFile(join(app, "Contents", "Info.plist"), "plist-v1\n");
  await writeFile(join(app, "Contents", "unexpected"), "extra\n");
  await assert.rejects(
    candidate.verifyReleaseCandidateManifest(app, manifest),
    /发行候选件文件树不一致/,
  );
});

test("formal verifier defers runtime only for internal unnotarized structural checks", async () => {
  const { parseArguments } = await import("../scripts/verify-macos-package.mjs");
  assert.throws(
    () => parseArguments(["candidate.pkg", "--defer-runtime-smoke"]),
    /必须与 --allow-unnotarized 同时使用/,
  );
  assert.deepEqual(
    parseArguments([
      "candidate.pkg",
      "--allow-unnotarized",
      "--defer-runtime-smoke",
    ]),
    {
      packagePath: "candidate.pkg",
      allowUnnotarized: true,
      manualChromeInstall: false,
      deferRuntimeSmoke: true,
      help: false,
    },
  );
});

test("desktop runtime smoke child receives a credential-free minimum environment", async () => {
  const { createRuntimeEnvironment } = await import("../scripts/smoke-macos-runtime.mjs");
  const environment = createRuntimeEnvironment({
    PATH: "/attacker/bin",
    HOME: "/Users/tester",
    TMPDIR: "/private/tmp/test/",
    LANG: "zh_CN.UTF-8",
    NODE_OPTIONS: "--require=/tmp/steal-secrets.js",
    OUR_CHOICE_NOTARY_KEY_PATH: "/tmp/AuthKey.p8",
    MACOS_KEYCHAIN_PASSWORD: "secret",
    GITHUB_TOKEN: "secret",
  }, {
    dataDirectory: "/private/tmp/data",
    webRoot: "/Applications/Our Choice.app/web",
    vinextRoot: "/Applications/Our Choice.app/vinext",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/Users/tester",
    TMPDIR: "/private/tmp/test/",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C",
    OUR_CHOICE_DATA_DIR: "/private/tmp/data",
    OUR_CHOICE_PORT: "0",
    OUR_CHOICE_APP_VERSION: "smoke-test",
    OUR_CHOICE_WEB_ROOT: "/Applications/Our Choice.app/web",
    OUR_CHOICE_VINEXT_ROOT: "/Applications/Our Choice.app/vinext",
  });
  for (const forbidden of [
    "NODE_OPTIONS",
    "OUR_CHOICE_NOTARY_KEY_PATH",
    "MACOS_KEYCHAIN_PASSWORD",
    "GITHUB_TOKEN",
  ]) {
    assert.equal(environment[forbidden], undefined);
  }
});

test("release wrapper strips Apple signing credentials from build and final verification", async () => {
  const { withoutSigningCredentials } = await import(
    "../scripts/package-macos-release.mjs"
  );
  const environment = withoutSigningCredentials({
    PATH: "/usr/bin:/bin",
    DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
    OUR_CHOICE_CHROME_EXTENSION_ID: "a".repeat(32),
    OUR_CHOICE_NODE_ARM64: "/tmp/node-arm64",
    OUR_CHOICE_DEVELOPMENT_TEAM: "ABCDEFGHIJ",
    OUR_CHOICE_NOTARY_KEY_PATH: "/tmp/AuthKey.p8",
    OUR_CHOICE_NOTARY_KEY_ID: "key-id",
    MACOS_APPLICATION_CERTIFICATE_PASSWORD: "p12-password",
    MACOS_KEYCHAIN_PASSWORD: "keychain-password",
    NODE_OPTIONS: "--require=/tmp/inject.js",
    DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    GITHUB_TOKEN: "secret",
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
    OUR_CHOICE_CHROME_EXTENSION_ID: "a".repeat(32),
    OUR_CHOICE_NODE_ARM64: "/tmp/node-arm64",
    OUR_CHOICE_DEVELOPMENT_TEAM: "ABCDEFGHIJ",
  });
});

test("formal package output naming, diagnostics, and promotion fail closed", async (t) => {
  const packageModule = await import("../scripts/package-macos.mjs");
  assert.match(
    packageModule.defaultOutputPackage({ skipNotarization: false }),
    /Our-Choice\.pkg$/,
  );
  assert.match(
    packageModule.defaultOutputPackage({ skipNotarization: true }),
    /Our-Choice-signed-unnotarized\.pkg$/,
  );
  assert.equal(
    packageModule.stagingPackagePath("/tmp/Our-Choice.pkg", {
      processID: 123,
      timestamp: 456,
    }),
    "/tmp/.Our-Choice.staging-123-456.pkg",
    "the atomic staging package must retain a final .pkg suffix for Apple stapler",
  );
  const diagnostic = packageModule.redactNotarizationDiagnostic(
    "failed /tmp/AuthKey_TEST.p8 key=ABC123 issuer=issuer-secret profile=release-profile",
    {
      type: "api-key",
      keyPath: "/tmp/AuthKey_TEST.p8",
      keyID: "ABC123",
      issuerID: "issuer-secret",
      profile: "release-profile",
    },
  );
  assert.equal(diagnostic.includes("AuthKey_TEST"), false);
  assert.equal(diagnostic.includes("ABC123"), false);
  assert.equal(diagnostic.includes("issuer-secret"), false);
  assert.equal(diagnostic.includes("release-profile"), false);

  const directory = await mkdtemp(join(tmpdir(), "our-choice-pkg-promotion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staging = join(directory, ".candidate.pkg.staging");
  const output = join(directory, "Our-Choice.pkg");
  await writeFile(output, "previous-verified-package");
  await writeFile(staging, "new-verified-package");
  await packageModule.promotePackage(staging, output);
  assert.equal(await readFile(output, "utf8"), "new-verified-package");
  await assert.rejects(readFile(staging), { code: "ENOENT" });
});

test("browser extension build emits one cross-browser MV3 source set", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "our-choice-extensions-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await run(process.execPath, ["scripts/build-browser-extensions.mjs", "--out", outDir], {
    cwd: new URL("..", import.meta.url),
  });

  const [chromeManifestText, safariManifestText, adapter, chromePopup] = await Promise.all([
    readFile(join(outDir, "chrome", "manifest.json"), "utf8"),
    readFile(join(outDir, "safari", "manifest.json"), "utf8"),
    readFile(join(outDir, "safari", "extension-api.js"), "utf8"),
    readFile(join(outDir, "chrome", "popup.html"), "utf8"),
  ]);
  const chromeManifest = JSON.parse(chromeManifestText);
  const safariManifest = JSON.parse(safariManifestText);

  assert.deepEqual(safariManifest, chromeManifest);
  assert.equal(chromeManifest.manifest_version, 3);
  assert.deepEqual(chromeManifest.host_permissions, [
    "http://localhost/*",
    "http://127.0.0.1/*",
  ]);
  assert.deepEqual(chromeManifest.content_scripts[0].js, ["extension-api.js", "app-bridge.js"]);
  assert.deepEqual(chromeManifest.icons, {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  });
  assert.match(adapter, /globalThis\.browser\s*\?\?/);
  assert.match(adapter, /globalThis\.chrome/);
  assert.match(chromePopup, /extension-api\.js[\s\S]+popup\.js/);

  for (const file of [
    "extension-api.js",
    "shared.js",
    "background.js",
    "content-script.js",
    "app-bridge.js",
    "popup.js",
  ]) {
    const source = await readFile(join(outDir, "safari", file), "utf8");
    assert.doesNotThrow(() => new Script(source), `${file} should parse for Safari`);
  }

  for (const size of [16, 32, 48, 128]) {
    const [chromeIcon, safariIcon] = await Promise.all([
      readFile(join(outDir, "chrome", "icons", `icon-${size}.png`)),
      readFile(join(outDir, "safari", "icons", `icon-${size}.png`)),
    ]);
    assert.deepEqual(safariIcon, chromeIcon);
  }
});

test("Safari appex resource verification detects injected and modified web assets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-appex-resources-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extensionOutput = join(directory, "extensions");
  await run(process.execPath, ["scripts/build-browser-extensions.mjs", "--out", extensionOutput], {
    cwd: new URL("..", import.meta.url),
  });
  const sourceRoot = join(extensionOutput, "safari");
  const appexPath = join(directory, "Test.appex");
  const resources = join(appexPath, "Contents", "Resources");
  await mkdir(join(appexPath, "Contents"), { recursive: true });
  await cp(sourceRoot, resources, { recursive: true });

  await verifySafariAppexResources({ sourceRoot, appexPath });
  const injected = join(resources, "injected.js");
  await writeFile(injected, "console.log('unexpected');\n");
  await assert.rejects(
    verifySafariAppexResources({ sourceRoot, appexPath }),
    /文件列表与共源产物不一致/,
  );
  await rm(injected);
  await writeFile(join(resources, "background.js"), "// modified\n");
  await assert.rejects(
    verifySafariAppexResources({ sourceRoot, appexPath }),
    /资源内容与共源产物不一致：background\.js/,
  );

  const linkedAppex = join(directory, "Linked.appex");
  await mkdir(join(linkedAppex, "Contents"), { recursive: true });
  await symlink(sourceRoot, join(linkedAppex, "Contents", "Resources"), "dir");
  await assert.rejects(
    verifySafariAppexResources({ sourceRoot, appexPath: linkedAppex }),
    /资源根路径必须是非符号链接目录/,
  );
});

test("macOS payload allowlists reject extra files while accepting paired AppleDouble metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "our-choice-payload-allowlist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "Our Choice.app"));
  await requireExactDirectoryEntries(directory, ["Our Choice.app"], "测试目录");
  await mkdir(join(directory, "Unexpected"));
  await assert.rejects(
    requireExactDirectoryEntries(directory, ["Our Choice.app"], "测试目录"),
    /不允许额外安装内容/,
  );

  const entries = new Map([
    [".", {}],
    ["Applications", {}],
    ["Applications/Our Choice.app", {}],
    ["Applications/._Our Choice.app", {}],
  ]);
  assert.doesNotThrow(() => verifyBomAllowlist(entries));
  entries.set("Library/LaunchAgents/com.example.evil.plist", {});
  assert.throws(() => verifyBomAllowlist(entries), /未允许的安装内容/);

  const chromeID = "a".repeat(32);
  const chromeRoot = "Library/Application Support/Google/Chrome/External Extensions";
  const chromeEntries = new Map([
    [".", {}],
    ["Applications", {}],
    ["Applications/Our Choice.app", {}],
    ["Library", {}],
    ["Library/Application Support", {}],
    ["Library/Application Support/Google", {}],
    ["Library/Application Support/Google/Chrome", {}],
    [chromeRoot, {}],
    [`${chromeRoot}/${chromeID}.json`, {}],
    [`${chromeRoot}/${"b".repeat(32)}.json`, {}],
  ]);
  assert.throws(() => verifyBomAllowlist(chromeEntries, chromeID), /未允许的安装内容/);
});

test("local macOS package requirements keep Distribution and App minimum versions at 13.0", () => {
  const distribution = `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <options customize="never" hostArchitectures="arm64"/>
  <volume-check>
    <allowed-os-versions>
      <os-version min="13.0"/>
    </allowed-os-versions>
  </volume-check>
</installer-gui-script>`;

  assert.deepEqual(validateLocalDistributionRequirements(distribution, "arm64"), {
    hostArchitectures: ["arm64"],
    minimumSystemVersion: "13.0",
  });
  assert.equal(validateLocalAppMinimumSystemVersion("13.0", "13.0"), "13.0");

  assert.throws(
    () => validateLocalDistributionRequirements(distribution.replace("13.0", "13.1"), "arm64"),
    /最低系统版本必须精确等于 13\.0/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      distribution.replace("</allowed-os-versions>", '<os-version min="13.0"/></allowed-os-versions>'),
      "arm64",
    ),
    /必须恰好包含一个 os-version/,
  );
  assert.throws(
    () => validateLocalAppMinimumSystemVersion("13.1", "13.0"),
    /LSMinimumSystemVersion 必须与 Distribution/,
  );
  assert.throws(
    () => validateLocalAppMinimumSystemVersion("13.0", "13.0", "13.1"),
    /Safari.*LSMinimumSystemVersion 必须与 Distribution/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      distribution.replace("hostArchitectures", "data-hostArchitectures"),
      "arm64",
    ),
    /hostArchitectures/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      distribution.replace('min="13.0"', 'data-min="13.0"'),
      "arm64",
    ),
    /min 属性/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      distribution.replace("<os-version ", "<os-version-fake "),
      "arm64",
    ),
    /必须恰好包含一个 os-version/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      distribution
        .replace("<volume-check>", "<ignored>")
        .replace("</volume-check>", "</ignored>"),
      "arm64",
    ),
    /volume-check/,
  );
});

test("Distribution validation follows XML structure instead of comment or CDATA text", () => {
  const fakeRequirements = [
    '<options hostArchitectures="arm64"/>',
    "<volume-check><allowed-os-versions>",
    '<os-version min="13.0"/>',
    "</allowed-os-versions></volume-check>",
  ].join("");

  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script><!-- ${fakeRequirements} --></installer-gui-script>`,
      "arm64",
    ),
    "commented-out requirements must not count as installer constraints",
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script><![CDATA[${fakeRequirements}]]></installer-gui-script>`,
      "arm64",
    ),
    "CDATA text must not count as installer constraints",
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script><choice>${fakeRequirements}</choice></installer-gui-script>`,
      "arm64",
    ),
    "requirements nested below an unrelated element must not count",
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script><options hostArchitectures="arm64"/>
        <volume-check><choice><allowed-os-versions><os-version min="13.0"/>
        </allowed-os-versions></choice></volume-check></installer-gui-script>`,
      "arm64",
    ),
    "allowed-os-versions must be a direct child of volume-check",
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script><options hostArchitectures="arm64"/>
        <volume-check><allowed-os-versions><choice><os-version min="13.0"/></choice>
        </allowed-os-versions></volume-check></installer-gui-script>`,
      "arm64",
    ),
    "os-version must be a direct child of allowed-os-versions",
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<!DOCTYPE installer-gui-script><installer-gui-script>${fakeRequirements}</installer-gui-script>`,
      "arm64",
    ),
    /DOCTYPE/,
  );
  assert.throws(
    () => validateLocalDistributionRequirements(
      `<installer-gui-script xmlns="urn:fake">${fakeRequirements}</installer-gui-script>`,
      "arm64",
    ),
    /命名空间/,
  );

  const validWithIgnoredText = `<installer-gui-script>
    <!-- ${fakeRequirements} -->
    <![CDATA[${fakeRequirements}]]>
    ${fakeRequirements}
  </installer-gui-script>`;
  assert.deepEqual(validateLocalDistributionRequirements(validWithIgnoredText, "arm64"), {
    hostArchitectures: ["arm64"],
    minimumSystemVersion: "13.0",
  });
});

test("PackageInfo validation reads exact attributes from the pkg-info root", () => {
  const expected = {
    "install-location": "/",
    relocatable: "false",
    identifier: "com.ourchoice.app.installer.local.component",
  };
  const attributes = validatePackageInfoRootAttributes(
    `<?xml version="1.0"?>
    <pkg-info install-location="/" relocatable="false"
      identifier="com.ourchoice.app.installer.local.component">
      <payload installKBytes="1"/>
    </pkg-info>`,
    expected,
  );
  assert.equal(attributes.get("install-location"), "/");
  assert.equal(attributes.get("relocatable"), "false");
  assert.equal(attributes.get("identifier"), expected.identifier);

  assert.throws(
    () => validatePackageInfoRootAttributes(
      `<pkg-info data-install-location="/" install-location="/tmp/evil"
        data-relocatable="false" relocatable="true"
        data-identifier="${expected.identifier}" identifier="com.example.evil"/>`,
      expected,
    ),
    /install-location/,
  );
  assert.throws(
    () => validatePackageInfoRootAttributes(
      `<pkg-info><!-- <pkg-info install-location="/" relocatable="false"
        identifier="${expected.identifier}"/> --></pkg-info>`,
      expected,
    ),
    /install-location/,
  );
  assert.throws(
    () => validatePackageInfoRootAttributes(
      `<!DOCTYPE pkg-info><pkg-info install-location="/" relocatable="false"
        identifier="${expected.identifier}"/>`,
      expected,
    ),
    /DOCTYPE/,
  );
  assert.throws(
    () => validatePackageInfoRootAttributes(
      `<pkg-info xmlns="urn:fake" install-location="/" relocatable="false"
        identifier="${expected.identifier}"/>`,
      expected,
    ),
    /命名空间/,
  );
  assert.throws(
    () => validatePackageInfoRootAttributes(
      `<wrapper install-location="/" relocatable="false" identifier="${expected.identifier}"/>`,
      expected,
    ),
    /根元素必须是 pkg-info/,
  );
});

test("Safari extension display metadata stays user-facing and stable", () => {
  assert.equal(SAFARI_EXTENSION_DISPLAY_NAME, "自选助手");
  assert.equal(SAFARI_EXTENSION_BUNDLE_NAME, "Our Choice Safari Extension");
  assert.equal(
    validateSafariExtensionDisplayMetadata(
      "自选助手",
      "Our Choice Safari Extension",
    ),
    "自选助手",
  );
  assert.throws(
    () => validateSafariExtensionDisplayMetadata(
      "Our Choice Safari Extension Extension",
      "Our Choice Safari Extension",
    ),
    /CFBundleDisplayName 必须精确等于“自选助手”/,
  );
  assert.throws(
    () => validateSafariExtensionDisplayMetadata("自选助手", "Wrong Name"),
    /CFBundleName 必须精确等于“Our Choice Safari Extension”/,
  );
});

test("formal entitlement validation detects get-task-allow only when enabled", () => {
  const entitlement = "com.apple.security.get-task-allow";
  assert.equal(
    hasEnabledEntitlement(
      `<dict><key>${entitlement}</key><true/></dict>`,
      entitlement,
    ),
    true,
  );
  assert.equal(
    hasEnabledEntitlement(
      `[Key] ${entitlement}\n[Value]\n  [Bool] true`,
      entitlement,
    ),
    true,
  );
  assert.equal(
    hasEnabledEntitlement(
      `<dict><key>${entitlement}</key><false/></dict>`,
      entitlement,
    ),
    false,
  );
  assert.equal(
    hasEnabledEntitlement(
      `[Key] ${entitlement}\n[Value]\n  [Bool] false\n`
        + "[Key] com.apple.security.app-sandbox\n[Value]\n  [Bool] true",
      entitlement,
    ),
    false,
    "a later enabled entitlement must not make get-task-allow look enabled",
  );
});

test("macOS app icon ships a complete native ICNS container", async () => {
  const [source, icon] = await Promise.all([
    text("macos/App/AppIcon.svg"),
    readFile(new URL("macos/App/OurChoice.icns", root)),
  ]);
  assert.match(source, /#163f2f/i);
  assert.match(source, /#f3ead7/i);
  assert.match(source, /#c96b45/i);
  assert.deepEqual(validateMacOSAppIcon(icon), [
    "icp4",
    "icp5",
    "icp6",
    "ic07",
    "ic08",
    "ic09",
    "ic10",
  ]);
  assert.throws(
    () => validateMacOSAppIcon(icon.subarray(0, icon.length - 1)),
    /声明长度与文件长度不一致/,
  );
});

test("macOS source and packaging scripts define an embedded, signed Safari distribution", async () => {
  const [
    packageJsonText,
    appSource,
    infoPlist,
    buildScript,
    releasePrepareScript,
    safariReleaseEntitlements,
    releaseCandidateScript,
    releaseEntrypointScript,
    packageScript,
    localPackageScript,
    safariCheckScript,
    verifyScript,
    localVerifyScript,
    payloadValidationScript,
    spec,
    compose,
    dockerIgnore,
  ] =
    await Promise.all([
      text("package.json"),
      text("macos/App/OurChoiceApp.swift"),
      text("macos/App/Info.plist"),
      text("scripts/build-macos-app.mjs"),
      text("scripts/prepare-macos-release.mjs"),
      text("macos/App/SafariExtension.entitlements"),
      text("scripts/macos-release-candidate.mjs"),
      text("scripts/package-macos-release.mjs"),
      text("scripts/package-macos.mjs"),
      text("scripts/package-macos-local.mjs"),
      text("scripts/check-safari-extension.mjs"),
      text("scripts/verify-macos-package.mjs"),
      text("scripts/verify-macos-local-package.mjs"),
      text("scripts/macos-payload-validation.mjs"),
      text("docs/spec/macos-local-app.md"),
      text("compose.yaml"),
      text(".dockerignore"),
    ]);
  const scripts = JSON.parse(packageJsonText).scripts;

  assert.equal(scripts["extensions:build"], "node scripts/build-browser-extensions.mjs");
  assert.match(scripts["mac:check"], /swiftc -parse-as-library -typecheck/);
  assert.match(scripts["mac:check"], /safari-extension-resources\.mjs/);
  assert.match(scripts["mac:check"], /safari-extension-metadata\.mjs/);
  assert.match(scripts["mac:check"], /macos-payload-validation\.mjs/);
  assert.match(scripts["mac:check"], /macos-distribution-validation\.mjs/);
  assert.match(scripts["mac:build"], /build-macos-app\.mjs/);
  assert.match(scripts["mac:smoke"], /smoke-macos-runtime\.mjs/);
  assert.match(scripts["mac:safari:check"], /check-safari-extension\.mjs/);
  assert.match(scripts["mac:safari:build-local"], /--embed-app/);
  assert.equal(scripts["mac:package"], "node scripts/package-macos-release.mjs");
  assert.match(scripts["mac:verify-package"], /verify-macos-package\.mjs/);
  assert.match(
    scripts["mac:package-local"],
    /^npm run mac:safari:build-local && node scripts\/package-macos-local\.mjs$/,
  );
  assert.equal(
    scripts["mac:verify-package-local"],
    "node scripts/verify-macos-local-package.mjs",
  );
  assert.match(appSource, /import WebKit/);
  assert.match(appSource, /@main\s+private enum OurChoiceApplicationMain/);
  assert.match(appSource, /NSApplication\.shared/);
  assert.match(appSource, /application\.delegate\s*=\s*delegate/);
  assert.match(appSource, /withExtendedLifetime\(delegate\)/);
  assert.match(appSource, /application\.run\(\)/);
  assert.doesNotMatch(appSource, /@main\s+final class OurChoiceApplicationDelegate/);
  assert.match(appSource, /Process\(\)/);
  assert.match(appSource, /var environment: \[String: String\] = \[/);
  assert.doesNotMatch(
    appSource,
    /var environment\s*=\s*ProcessInfo\.processInfo\.environment/,
  );
  for (const forbiddenEnvironmentName of [
    "NODE_OPTIONS",
    "OUR_CHOICE_NOTARY_KEY_PATH",
    "MACOS_KEYCHAIN_PASSWORD",
  ]) {
    assert.doesNotMatch(
      appSource,
      new RegExp(`environment\\["${forbiddenEnvironmentName}"\\]`),
    );
  }
  assert.match(appSource, /SFSafariApplication\.showPreferencesForExtension/);
  assert.match(appSource, /applicationSupportDirectory/);
  assert.match(appSource, /applicationShouldHandleReopen/);
  assert.match(appSource, /browserExtensionGuideVersion/);
  assert.match(appSource, /UserDefaults\.standard/);
  assert.match(appSource, /浏览器扩展安装说明…/);
  assert.match(appSource, /允许未签名扩展/);
  assert.match(appSource, /每次退出 Safari 后/);
  assert.match(appSource, /打开 Chrome 扩展目录/);
  assert.match(appSource, /browser-extension\/chrome/);
  assert.match(appSource, /presentInitialBrowserExtensionGuideIfNeeded/);
  assert.match(
    appSource,
    /alert\.window\.preventsApplicationTerminationWhenModal\s*=\s*false/,
  );
  assert.match(
    appSource,
    /presentInitialBrowserExtensionGuideIfNeeded\(\) \{[\s\S]{0,180}guard !applicationIsTerminating/,
  );
  assert.match(
    appSource,
    /didFinish[\s\S]+presentInitialBrowserExtensionGuideIfNeeded/,
  );
  assert.match(appSource, /NSMenu\(title: "编辑"\)/);
  for (const selector of ["undo:", "redo:"]) {
    assert.match(appSource, new RegExp(`Selector\\(\\(\\"${selector}\\"\\)\\)`));
  }
  for (const selector of ["cut", "copy", "paste", "selectAll"]) {
    assert.match(appSource, new RegExp(`#selector\\(NSText\\.${selector}\\(_:\\)\\)`));
  }
  assert.doesNotMatch(appSource, /try!/);
  assert.match(appSource, /applicationShouldTerminate\([\s\S]+TerminateReply/);
  assert.match(appSource, /return \.terminateLater/);
  assert.match(appSource, /reply\(toApplicationShouldTerminate: true\)/);
  assert.match(appSource, /stoppingProcess/);
  assert.match(appSource, /stopCompletions/);
  assert.match(appSource, /stopEmbeddedServer\(completion:/);
  assert.match(appSource, /ProcessInfo\.processInfo\.environment\["OUR_CHOICE_PORT"\]/);
  assert.doesNotMatch(appSource, /private var requestedDesktopPort/);
  assert.match(appSource, /requestedPort == 0/);
  assert.match(appSource, /ready\.port == requestedPort/);
  assert.match(appSource, /url\.port == ready\.port/);
  assert.match(appSource, /readyURL\?\.port/);
  assert.doesNotMatch(appSource, /environment\["OUR_CHOICE_PORT"\]\s*=\s*"3000"/);
  assert.match(appSource, /process\.terminationHandler\s*=/);
  assert.match(appSource, /SIGKILL/);
  assert.doesNotMatch(appSource, /if completion != nil[\s\S]{0,220}SIGKILL/);
  assert.doesNotMatch(appSource, /now\(\) \+ 0\.35/);
  assert.match(infoPlist, /NSAllowsLocalNetworking/);
  assert.match(infoPlist, /OurChoiceSafariExtensionBundleIdentifier/);
  assert.match(
    infoPlist,
    /<key>CFBundleIconFile<\/key>\s*<string>OurChoice\.icns<\/string>/,
  );
  assert.match(buildScript, /node_modules["'],\s*["']vinext["'],\s*["']dist/);
  assert.match(buildScript, /Contents["'],\s*["']Resources/);
  assert.match(buildScript, /macos["'],\s*["']App["'],\s*["']OurChoice\.icns["']/);
  assert.match(
    buildScript,
    /copyFile\(appIcon,\s*join\(resourcesDirectory,\s*MACOS_APP_ICON_FILENAME\)\)/,
  );
  assert.match(buildScript, /OUR_CHOICE_BUILD_VERSION/);
  assert.match(releasePrepareScript, /safari-web-extension-packager/);
  assert.match(releasePrepareScript, /["']-target["']/);
  assert.match(releasePrepareScript, /SYMROOT=/);
  assert.match(releasePrepareScript, /OBJROOT=/);
  assert.match(releasePrepareScript, /CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO/);
  assert.match(releasePrepareScript, /SafariExtension\.entitlements/);
  assert.match(releasePrepareScript, /--entitlements/);
  assert.match(
    safariReleaseEntitlements,
    /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/,
  );
  assert.doesNotMatch(safariReleaseEntitlements, /get-task-allow/);
  assert.match(releasePrepareScript, /compileUniversalApp/);
  assert.match(releasePrepareScript, /installUniversalNode/);
  assert.match(releasePrepareScript, /writeReleaseCandidateManifest/);
  assert.match(releaseCandidateScript, /createHash\(["']sha256["']\)/);
  assert.match(releaseCandidateScript, /lstat/);
  assert.match(releaseEntrypointScript, /prepare-macos-release\.mjs/);
  assert.match(releaseEntrypointScript, /verify-macos-package\.mjs/);
  assert.doesNotMatch(packageScript, /safari-web-extension-packager/);
  assert.doesNotMatch(packageScript, /["']swiftc["']/);
  assert.doesNotMatch(packageScript, /["']xcodebuild["']/);
  assert.doesNotMatch(packageScript, /smoke-macos-runtime\.mjs/);
  assert.match(packageScript, /\.appex/);
  assert.match(packageScript, /codesign/);
  assert.match(packageScript, /SafariExtension\.entitlements/);
  assert.match(packageScript, /--entitlements/);
  assert.doesNotMatch(packageScript, /--preserve-metadata/);
  assert.doesNotMatch(
    packageScript,
    /--preserve-metadata=[^\r\n"']*(?:requirements|flags)/,
  );
  assert.match(packageScript, /productbuild/);
  assert.match(packageScript, /--product/);
  assert.match(packageScript, /productRequirements/);
  assert.match(releasePrepareScript, /13\.0/);
  assert.match(packageScript, /notarytool/);
  assert.match(packageScript, /OUR_CHOICE_NOTARY_KEY_PATH/);
  assert.match(packageScript, /OUR_CHOICE_NOTARY_KEY_ID/);
  assert.match(packageScript, /OUR_CHOICE_NOTARY_ISSUER_ID/);
  assert.match(packageScript, /--issuer/);
  assert.match(packageScript, /issuerID\s*\?/);
  assert.match(packageScript, /--output-format["'],\s*["']json/);
  assert.match(packageScript, /--timeout["'],\s*["']45m/);
  assert.match(
    packageScript,
    /--no-s3-acceleration/,
    "formal notarization must avoid accelerated multipart upload deadline failures",
  );
  assert.match(packageScript, /notarytool submit failed/);
  assert.match(packageScript, /submissionFailure[\s\S]+stderr/);
  assert.match(packageScript, /notarytool[\s\S]+["']log["']/);
  assert.match(packageScript, /\.notary-log\.json/);
  assert.match(releasePrepareScript, /lipo/);
  assert.match(releasePrepareScript, /MARKETING_VERSION=/);
  assert.match(releasePrepareScript, /CURRENT_PROJECT_VERSION=/);
  assert.match(packageScript, /CFBundleVersion/);
  assert.match(packageScript, /必须显式传入 --skip-notarization/);
  assert.match(packageScript, /--component-plist/);
  assert.match(packageScript, /BundleIsRelocatable/);
  assert.match(releasePrepareScript, /verifySafariAppexResources/);
  assert.match(releasePrepareScript, /SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS/);
  assert.match(packageScript, /await chmod\(directory, 0o755\)/);
  assert.match(packageScript, /await chmod\(externalPreference, 0o644\)/);
  assert.match(packageScript, /--allow-unnotarized[\s\S]+notarizePackage/);
  assert.match(packageScript, /--defer-runtime-smoke/);
  assert.match(packageScript, /verifyReleaseCandidateManifest/);
  assert.match(packageScript, /promotePackage/);
  assert.match(packageScript, /\.staging-/);
  assert.doesNotMatch(packageScript, /await rm\(outputPackage/);
  const chromePolicyIndex = packageScript.indexOf(
    "const chromeExtensionID = resolvePackagingChromeExtensionID",
  );
  const workDirectoryIndex = packageScript.indexOf("const workDirectory = await mkdtemp");
  assert.ok(chromePolicyIndex >= 0, "formal packaging must resolve Chrome policy up front");
  assert.ok(
    chromePolicyIndex < workDirectoryIndex,
    "formal Chrome ID validation must precede temporary/output artifact mutation",
  );
  assert.match(packageScript, /--manual-chrome-install/);
  assert.match(localPackageScript, /Our-Choice-local-unsigned\.pkg/);
  assert.match(localPackageScript, /installer\.local\.component/);
  assert.match(localPackageScript, /BundleIsRelocatable/);
  assert.match(localPackageScript, /productbuild/);
  assert.match(localPackageScript, /--product/);
  assert.match(localPackageScript, /productRequirements/);
  assert.match(localPackageScript, /13\.0/);
  assert.doesNotMatch(localPackageScript, /["']--sign["']/);
  assert.doesNotMatch(localPackageScript, /OUR_CHOICE_(?:APP|INSTALLER)_SIGN_IDENTITY/);
  assert.match(safariCheckScript, /safari-web-extension-packager/);
  assert.match(safariCheckScript, /SAFARI_EXTENSION_INFO_PLIST_BUILD_SETTINGS/);
  assert.match(safariCheckScript, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(safariCheckScript, /CODE_SIGN_STYLE=Manual/);
  assert.match(safariCheckScript, /CODE_SIGN_IDENTITY=-/);
  assert.match(safariCheckScript, /AD_HOC_CODE_SIGNING_ALLOWED=YES/);
  assert.match(safariCheckScript, /com\.apple\.security\.app-sandbox/);
  assert.match(safariCheckScript, /lsregister/);
  assert.match(safariCheckScript, /pluginkit/);
  assert.match(safariCheckScript, /--embed-app/);
  assert.match(safariCheckScript, /OurChoiceSafariExtensionBundleIdentifier/);
  assert.match(safariCheckScript, /Contents["'],\s*["']PlugIns/);
  assert.match(safariCheckScript, /codesign/);
  assert.match(safariCheckScript, /--deep/);
  assert.match(safariCheckScript, /["']-target["']/);
  assert.match(safariCheckScript, /NSExtensionPointIdentifier/);
  assert.match(safariCheckScript, /arm64/);
  assert.match(safariCheckScript, /x86_64/);
  assert.equal(
    [...packageScript.matchAll(/verbatimSymlinks:\s*true/g)].length,
    2,
    "Safari extension and signed App copies should preserve relative symlinks verbatim",
  );
  assert.match(verifyScript, /pkgutil[\s\S]+--check-signature/);
  assert.match(verifyScript, /developer certificate issued by Apple for distribution/);
  assert.match(verifyScript, /Signed with a trusted timestamp/);
  assert.match(verifyScript, /pkgutil[\s\S]+--expand-full/);
  assert.match(verifyScript, /Distribution/);
  assert.match(verifyScript, /hostArchitectures/);
  assert.match(verifyScript, /LSMinimumSystemVersion/);
  assert.match(verifyScript, /appMinimumSystemVersion/);
  assert.match(verifyScript, /appexMinimumSystemVersion/);
  assert.match(verifyScript, /minimumSystemVersion/);
  assert.match(verifyScript, /PackageInfo/);
  assert.match(verifyScript, /validatePackageInfoRootAttributes/);
  assert.match(verifyScript, /install-location/);
  assert.match(verifyScript, /relocatable/);
  assert.match(verifyScript, /Payload/);
  assert.match(verifyScript, /Scripts/);
  assert.match(verifyScript, /lsbom/);
  assert.match(verifyScript, /Bom/);
  assert.match(verifyScript, /codesign[\s\S]+--deep[\s\S]+--strict/);
  assert.match(verifyScript, /flags=.*runtime/);
  assert.match(verifyScript, /TeamIdentifier/);
  assert.match(verifyScript, /Timestamp=/);
  assert.match(verifyScript, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(verifyScript, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(verifyScript, /com\.apple\.security\.app-sandbox/);
  assert.match(verifyScript, /validateExactEntitlements/);
  assert.match(verifyScript, /Our Choice Safari Extension\.appex/);
  assert.match(verifyScript, /External Extensions/);
  assert.match(verifyScript, /external_update_url/);
  assert.match(verifyScript, /--manual-chrome-install/);
  assert.match(verifyScript, /--defer-runtime-smoke/);
  assert.match(verifyScript, /runtimeVerified/);
  assert.match(verifyScript, /resolveVerifierChromeExtensionID/);
  assert.match(verifyScript, /NSExtension\.NSExtensionPointIdentifier/);
  assert.match(verifyScript, /validateSafariExtensionDisplayMetadata/);
  assert.match(verifyScript, /CFBundleDisplayName/);
  assert.match(verifyScript, /CFBundleName/);
  assert.match(verifyScript, /verifySafariAppexResources/);
  assert.match(verifyScript, /requireExactDirectoryEntries/);
  assert.match(verifyScript, /verifyBomAllowlist/);
  assert.match(payloadValidationScript, /不允许额外安装内容/);
  assert.match(payloadValidationScript, /AppleDouble/);
  assert.match(verifyScript, /spctl[\s\S]+--type["'],\s*["']install/);
  assert.match(verifyScript, /stapler["'],\s*["']validate/);
  assert.match(verifyScript, /smoke-macos-runtime\.mjs/);
  assert.match(verifyScript, /validateMacOSAppIcon/);
  assert.ok(
    [...verifyScript.matchAll(/["']--arch["'],\s*architecture/g)].length >= 2,
    "formal verifier must inspect signature metadata and entitlements for every Mach-O slice",
  );
  assert.match(localVerifyScript, /Status:\\s\+no signature/);
  assert.match(localVerifyScript, /Signature=adhoc/);
  assert.match(localVerifyScript, /TeamIdentifier=not set/);
  assert.match(localVerifyScript, /installer\.local\.component/);
  assert.match(localVerifyScript, /Distribution/);
  assert.match(localVerifyScript, /validatePackageInfoRootAttributes/);
  assert.match(localVerifyScript, /hostArchitectures/);
  assert.match(localVerifyScript, /LSMinimumSystemVersion/);
  assert.match(localVerifyScript, /appexMinimumSystemVersion/);
  assert.match(localVerifyScript, /minimumSystemVersion/);
  assert.match(localVerifyScript, /validateSafariExtensionDisplayMetadata/);
  assert.match(localVerifyScript, /CFBundleDisplayName/);
  assert.match(localVerifyScript, /CFBundleName/);
  assert.match(localVerifyScript, /com\.apple\.security\.app-sandbox/);
  assert.match(localVerifyScript, /com\.apple\.security\.get-task-allow/);
  assert.match(localVerifyScript, /verifySafariAppexResources/);
  assert.match(localVerifyScript, /smoke-macos-runtime\.mjs/);
  assert.match(localVerifyScript, /validateMacOSAppIcon/);
  assert.ok(
    [...localVerifyScript.matchAll(/["']--arch["'],\s*architecture/g)].length >= 2,
    "local verifier must inspect signature metadata and entitlements for every Mach-O slice",
  );
  assert.doesNotMatch(localVerifyScript, /--allow-local|--local-development/);
  assert.doesNotMatch(localVerifyScript, /manual-chrome-install/);
  assert.doesNotMatch(localPackageScript, /manual-chrome-install/);
  assert.match(spec, /docker compose up --build/);
  assert.match(spec, /正式 `productbuild` 必须传入 product requirements/);
  assert.match(
    spec,
    /正式主应用、Safari `\.appex` 与内置 Node 的 `com\.apple\.security\.get-task-allow`/,
  );
  assert.match(compose, /^services:\s*\n\s{2}our-choice:/m);
  assert.match(compose, /ghcr\.io\/diygod\/rsshub:chromium-bundled/);
  assert.match(dockerIgnore, /^build\/?$/m);
});

test("manual macOS release workflow protects credentials and uploads only a verified PKG", async () => {
  const workflow = await text(".github/workflows/macos-release.yml");
  const job = (name) => {
    const marker = `  ${name}:\n`;
    const start = workflow.indexOf(marker);
    assert.ok(start >= 0, `missing ${name} job`);
    const remainder = workflow.slice(start + marker.length);
    const nextJob = remainder.search(/\n  [a-z][a-z0-9_]*:\n/);
    return nextJob < 0 ? remainder : remainder.slice(0, nextJob);
  };

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /runs-on: macos-26-intel/);
  assert.match(workflow, /DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/);
  assert.match(workflow, /OUR_CHOICE_BUILD_VERSION: \$\{\{ github\.run_number \}\}\.\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f/);
  assert.ok(
    [...workflow.matchAll(/persist-credentials:\s*false/g)].length >= 3,
    "every repository checkout in a privileged path must avoid persisted Git credentials",
  );
  assert.ok(
    [...workflow.matchAll(/ref:\s*\$\{\{ github\.sha \}\}/g)].length >= 3,
    "every repository checkout must be pinned to the dispatched commit",
  );

  const buildCandidate = job("build_candidate");
  assert.doesNotMatch(buildCandidate, /environment:/);
  assert.doesNotMatch(buildCandidate, /secrets\./);
  assert.match(buildCandidate, /npm ci/);
  assert.match(buildCandidate, /npm run mac:build/);
  assert.match(buildCandidate, /prepare-macos-release\.mjs/);
  assert.match(buildCandidate, /smoke-macos-runtime\.mjs/);
  assert.match(buildCandidate, /NODE_DARWIN_ARM64_SHA256: fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d/);
  assert.match(buildCandidate, /NODE_DARWIN_X64_SHA256: efeec6641a2f15f5396d27cd0b32f5062d6689d1e9e5d89607d0b29bda890233/);
  assert.match(buildCandidate, /printf '%s  %s\\n' "\$expected_sha256" "\$archive" \| shasum -a 256 -c -/);
  assert.match(buildCandidate, /Our-Choice-release-candidate\.tar\.gz/);
  assert.match(buildCandidate, /shasum -a 256/);
  assert.match(buildCandidate, /Upload frozen release candidate/);
  assert.match(buildCandidate, /tests\/macos-runtime\.test\.mjs/);
  assert.match(buildCandidate, /tests\/macos-native-shell\.test\.mjs/);

  const appleSign = job("apple_sign");
  assert.match(appleSign, /needs: build_candidate/);
  assert.match(appleSign, /environment:\s*\n\s+name: macos-release/);
  assert.match(appleSign, /MACOS_APPLICATION_CERTIFICATE_BASE64/);
  assert.match(appleSign, /MACOS_INSTALLER_CERTIFICATE_BASE64/);
  assert.match(appleSign, /APPLE_NOTARY_KEY_BASE64/);
  assert.match(appleSign, /Download frozen release candidate/);
  assert.match(appleSign, /Our-Choice-notarized-candidate\.pkg/);
  assert.match(appleSign, /node scripts\/package-macos\.mjs/);
  assert.match(appleSign, /--manual-chrome-install/);
  assert.match(appleSign, /macos-release-candidate\.mjs/);
  assert.match(appleSign, /tar -tvzf "\$archive"/);
  assert.match(appleSign, /archive contains a link or unsupported entry/);
  assert.match(appleSign, /if: \$\{\{ always\(\) \}\}/);
  assert.match(appleSign, /security lock-keychain/);
  assert.match(appleSign, /security delete-keychain/);
  assert.doesNotMatch(appleSign, /security delete-keychain[^\n]+\|\| true/);
  const importIndex = appleSign.indexOf("- name: Import Developer ID certificates");
  const packageIndex = appleSign.indexOf("- name: Sign and notarize frozen installer candidate");
  const cleanupIndex = appleSign.indexOf("- name: Remove signing credentials");
  const uploadIndex = appleSign.indexOf("- name: Upload signed notarized candidate");
  assert.ok(importIndex >= 0 && importIndex < packageIndex && packageIndex < cleanupIndex);
  assert.ok(cleanupIndex < uploadIndex);
  const credentialPhase = appleSign.slice(importIndex, cleanupIndex);
  assert.doesNotMatch(
    credentialPhase,
    /npm (?:ci|run)|swiftc|xcodebuild|prepare-macos-release|smoke-macos-runtime/,
  );
  assert.doesNotMatch(appleSign, /OUR_CHOICE_CHROME_WEB_STORE_(?:CLIENT|REFRESH)/);

  const verifyCandidate = job("verify_candidate");
  assert.match(verifyCandidate, /needs: apple_sign/);
  assert.doesNotMatch(verifyCandidate, /environment:|secrets\./);
  assert.match(
    verifyCandidate,
    /node scripts\/verify-macos-package\.mjs[\s\\]+build\/macos\/Our-Choice-notarized-candidate\.pkg[\s\\]+--manual-chrome-install/,
  );
  assert.match(verifyCandidate, /Our-Choice-notarized-candidate\.pkg\.sha256/);
  assert.doesNotMatch(verifyCandidate, /Our-Choice\.pkg(?:\s|$)/m);

  const publish = job("publish");
  assert.match(publish, /needs:\s*\[apple_sign, verify_candidate\]/);
  assert.doesNotMatch(publish, /environment:|secrets\.|node |npm /);
  assert.match(publish, /shasum -a 256 -c/);
  assert.match(publish, /mv Our-Choice-notarized-candidate\.pkg Our-Choice\.pkg/);
  assert.match(publish, /Upload verified installer/);
  assert.match(publish, /build\/macos\/Our-Choice\.pkg\.sha256/);

  assert.doesNotMatch(workflow, /cws_gate|CHROME_WEB_STORE|CHROME_EXTENSION_ID/);
  assert.ok(workflow.indexOf("  build_candidate:") < workflow.indexOf("  apple_sign:"));
  assert.ok(workflow.indexOf("  apple_sign:") < workflow.indexOf("  verify_candidate:"));
  assert.ok(workflow.indexOf("  verify_candidate:") < workflow.indexOf("  publish:"));

  assert.match(workflow, /NODE_DIST_VERSION: "22\.23\.1"/);
  assert.ok(
    [...workflow.matchAll(/node-version: "22\.23\.1"/g)].length >= 3,
    "every macOS release job must use the pinned Node toolchain",
  );
  assert.doesNotMatch(workflow, /inputs\.node_version|SHASUMS256\.txt/);
});
