import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("desktop runtime monitors its immutable macOS parent without keeping itself alive", async () => {
  const { startParentProcessMonitor } = await import("../macos/runtime/server.mjs");
  assert.equal(typeof startParentProcessMonitor, "function");

  let currentParentPID = 41_001;
  let scheduledCheck;
  let scheduledMilliseconds;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const cleared = [];
  let parentExitCount = 0;

  const monitor = startParentProcessMonitor({
    expectedParentPID: 41_001,
    currentParentPID: () => currentParentPID,
    onParentExit: () => { parentExitCount += 1; },
    schedule: (callback, milliseconds) => {
      scheduledCheck = callback;
      scheduledMilliseconds = milliseconds;
      return timer;
    },
    cancelSchedule: (value) => { cleared.push(value); },
  });

  assert.ok(scheduledMilliseconds > 0 && scheduledMilliseconds <= 1_000);
  assert.equal(timer.unrefCalled, true);
  assert.equal(parentExitCount, 0);

  scheduledCheck();
  assert.equal(parentExitCount, 0);

  currentParentPID = 1;
  scheduledCheck();
  scheduledCheck();
  assert.equal(parentExitCount, 1);
  assert.deepEqual(cleared, [timer]);

  monitor.stop();
  assert.deepEqual(cleared, [timer]);

  let disabledScheduleCount = 0;
  for (const invalidParentPID of [null, "", "0", "-1", "1.5", 2_147_483_648]) {
    startParentProcessMonitor({
      expectedParentPID: invalidParentPID,
      currentParentPID: () => 1,
      onParentExit: () => assert.fail("disabled monitor must not report parent exit"),
      schedule: () => { disabledScheduleCount += 1; },
    });
  }
  assert.equal(disabledScheduleCount, 0);
});

test("desktop runtime upgrades an in-flight graceful shutdown when its parent exits", async () => {
  const { createShutdownCoordinator } = await import("../macos/runtime/server.mjs");
  assert.equal(typeof createShutdownCoordinator, "function");

  let finishClose;
  const closePromise = new Promise((resolve) => { finishClose = resolve; });
  const scheduled = [];
  const cancelled = [];
  const exits = [];
  let monitorStops = 0;
  const coordinator = createShutdownCoordinator({
    closeRuntime: () => closePromise,
    stopParentMonitor: () => { monitorStops += 1; },
    scheduleForceExit: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      scheduled.push(timer);
      return timer;
    },
    cancelForceExit: (timer) => { cancelled.push(timer); },
    exit: (code) => { exits.push(code); },
    reportError() {},
  });

  const graceful = coordinator.shutdown("SIGTERM");
  assert.equal(scheduled.length, 0);
  assert.equal(monitorStops, 0, "parent monitoring must remain active while close is pending");

  const upgraded = coordinator.shutdown("parent exit", { forceExit: true });
  assert.equal(upgraded, graceful);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 3_000);
  coordinator.shutdown("parent exit again", { forceExit: true });
  assert.equal(scheduled.length, 1, "repeat signals must not reset the force-exit deadline");

  scheduled[0].callback();
  assert.deepEqual(exits, [1]);
  finishClose();
  await graceful;
  assert.equal(monitorStops, 1);
  assert.deepEqual(cancelled, [scheduled[0]]);
});

test("parent monitor terminates a child after its direct parent is force-killed", {
  skip: process.platform === "win32",
}, async (t) => {
  const moduleURL = new URL("../macos/runtime/server.mjs", import.meta.url).href;
  const monitoredChildProgram = `
    import { startParentProcessMonitor } from ${JSON.stringify(moduleURL)};
    startParentProcessMonitor({
      expectedParentPID: process.ppid,
      onParentExit: () => process.exit(0),
    });
    process.stdout.write("MONITORED_CHILD " + process.pid + "\\n");
    setInterval(() => {}, 60_000);
  `;
  const directParentProgram = `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(monitoredChildProgram)}], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    setInterval(() => {}, 60_000);
  `;
  const directParent = spawn(
    process.execPath,
    ["--input-type=module", "--eval", directParentProgram],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let monitoredPID;
  t.after(() => {
    if (directParent.exitCode === null && directParent.signalCode === null) {
      directParent.kill("SIGKILL");
    }
    if (monitoredPID !== undefined) {
      try { process.kill(monitoredPID, "SIGKILL"); } catch {}
    }
  });

  let stdout = "";
  let stderr = "";
  directParent.stderr.setEncoding("utf8");
  directParent.stderr.on("data", (chunk) => { stderr += chunk; });
  directParent.stdout.setEncoding("utf8");
  directParent.stdout.on("data", (chunk) => { stdout += chunk; });

  const deadline = Date.now() + 3_000;
  while (monitoredPID === undefined && Date.now() < deadline) {
    const match = stdout.match(/MONITORED_CHILD (\d+)/);
    if (match) {
      monitoredPID = Number(match[1]);
      break;
    }
    if (directParent.exitCode !== null || directParent.signalCode !== null) break;
    await delay(20);
  }
  assert.ok(Number.isInteger(monitoredPID), `child did not start\n${stderr}`);

  directParent.kill("SIGKILL");
  await once(directParent, "exit");

  let monitoredChildStillExists = true;
  const exitDeadline = Date.now() + 3_000;
  while (monitoredChildStillExists && Date.now() < exitDeadline) {
    try {
      process.kill(monitoredPID, 0);
    } catch (error) {
      if (error?.code === "ESRCH") monitoredChildStillExists = false;
      else throw error;
    }
    if (monitoredChildStillExists) await delay(25);
  }
  assert.equal(monitoredChildStillExists, false, "monitored child remained after parent death");
});

test("desktop server entry closes its listeners after the macOS launcher is force-killed", {
  skip: process.platform === "win32" || process.env.OUR_CHOICE_NETWORK_TEST !== "1",
}, async (t) => {
  const projectPath = fileURLToPath(new URL("..", import.meta.url));
  const dataDirectory = await mkdtemp(join(tmpdir(), "our-choice-parent-exit-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const serverPath = join(projectPath, "macos", "runtime", "server.mjs");
  const launcherProgram = `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, [${JSON.stringify(serverPath)}], {
      cwd: ${JSON.stringify(projectPath)},
      env: {
        ...process.env,
        OUR_CHOICE_PARENT_PID: String(process.pid),
        OUR_CHOICE_DATA_DIR: ${JSON.stringify(dataDirectory)},
        OUR_CHOICE_PORT: "0",
        OUR_CHOICE_WEB_ROOT: ${JSON.stringify(projectPath)},
        OUR_CHOICE_VINEXT_ROOT: ${JSON.stringify(join(projectPath, "node_modules", "vinext", "dist"))},
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.stdout.write("SERVER_CHILD " + child.pid + "\\n");
    setInterval(() => {}, 60_000);
  `;
  const launcher = spawn(
    process.execPath,
    ["--input-type=module", "--eval", launcherProgram],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let serverPID;
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    if (serverPID !== undefined) {
      try { process.kill(serverPID, "SIGKILL"); } catch {}
    }
  });

  let stdout = "";
  let stderr = "";
  launcher.stdout.setEncoding("utf8");
  launcher.stdout.on("data", (chunk) => { stdout += chunk; });
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => { stderr += chunk; });

  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline) {
    serverPID ??= Number(stdout.match(/SERVER_CHILD (\d+)/)?.[1]) || undefined;
    if (serverPID !== undefined && stdout.includes("OUR_CHOICE_READY ")) break;
    if (launcher.exitCode !== null || launcher.signalCode !== null) break;
    await delay(25);
  }
  assert.ok(Number.isInteger(serverPID), `desktop server did not launch\n${stderr}`);
  assert.match(stdout, /OUR_CHOICE_READY /, `desktop server was not ready\n${stderr}`);

  launcher.kill("SIGKILL");
  await once(launcher, "exit");

  let serverStillExists = true;
  const exitDeadline = Date.now() + 4_000;
  while (serverStillExists && Date.now() < exitDeadline) {
    try {
      process.kill(serverPID, 0);
    } catch (error) {
      if (error?.code === "ESRCH") serverStillExists = false;
      else throw error;
    }
    if (serverStillExists) await delay(25);
  }
  assert.equal(serverStillExists, false, `desktop server remained after launcher death\n${stderr}`);
});

test("native shell isolates stdout parsing by launch generation and captures its requested port", async () => {
  const source = await readFile(
    new URL("../macos/App/OurChoiceApp.swift", import.meta.url),
    "utf8",
  );

  assert.match(source, /final class DesktopServerOutputParser/);
  assert.match(source, /private let lock = NSLock\(\)/);
  assert.match(source, /let outputParser = DesktopServerOutputParser\(\)/);
  assert.match(source, /let lines = outputParser\.consume\(data\)/);
  assert.match(
    source,
    /DispatchQueue\.main\.async[\s\S]{0,220}consumeServerOutput\([\s\S]{0,180}requestedPort: configuredPort/,
  );
  assert.match(
    source,
    /consumeServerOutput\([\s\S]{0,180}requestedPort: Int[\s\S]{0,120}guard startupGeneration == generation else \{ return \}/,
  );
  assert.match(source, /requestedPort == 0 \|\| ready\.port == requestedPort/);
  assert.doesNotMatch(source, /private var outputBuffer/);
  assert.doesNotMatch(source, /private var requestedDesktopPort/);
  assert.match(
    source,
    /"OUR_CHOICE_PARENT_PID"\s*:\s*String\([\s\S]{0,80}ProcessInfo\.processInfo\.processIdentifier[\s\S]{0,20}\)/,
  );
  assert.match(source, /import Security/);
  assert.match(
    source,
    /private func makeNativeBootstrapSecret\(\) throws -> String[\s\S]{0,500}32[\s\S]{0,500}SecRandomCopyBytes/,
  );
  assert.match(
    source,
    /private func startEmbeddedServer\(\)[\s\S]{0,500}let nativeBootstrapSecret = try makeNativeBootstrapSecret\(\)/,
  );
  assert.match(
    source,
    /"OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET"\s*:\s*nativeBootstrapSecret/,
  );
  assert.match(source, /"__OUR_CHOICE_NATIVE_BOOTSTRAP_SECRET__"/);
  assert.match(
    source,
    /WKUserScript\([\s\S]{0,500}injectionTime:\s*\.atDocumentStart[\s\S]{0,160}forMainFrameOnly:\s*true[\s\S]{0,120}in:\s*\.page/,
  );
  assert.match(source, /userContentController\.removeAllUserScripts\(\)/);
  assert.match(source, /userContentController\.addUserScript\(bootstrapScript\)/);
  assert.match(source, /for key in \["RSSHUB_BASE_URL", "RSSHUB_ACCESS_KEY"\]/);
  assert.doesNotMatch(source, /process\.environment\s*=\s*ProcessInfo\.processInfo\.environment/);
  assert.doesNotMatch(source, /appendToLog\([^)]*nativeBootstrapSecret/);
  assert.doesNotMatch(source, /UserDefaults[^\n]*nativeBootstrapSecret/);
});

test("native WebKit navigation trusts only the health-checked canonical IPv4 origin", async () => {
  const source = await readFile(
    new URL("../macos/App/OurChoiceApp.swift", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /private func isApplicationURL[\s\S]{0,420}url\.host\?\.lowercased\(\) == "127\.0\.0\.1"/,
  );
  assert.doesNotMatch(source, /\["localhost", "127\.0\.0\.1"\]\.contains/);
  assert.match(
    source,
    /decidePolicyFor navigationResponse[\s\S]{0,1100}navigationResponse\.isForMainFrame[\s\S]{0,300}isApplicationURL\(url\)[\s\S]{0,200}decisionHandler\(\.cancel\)/,
  );
  assert.match(
    source,
    /decidePolicyFor navigationAction[\s\S]{0,900}targetFrame\?\.isMainFrame == true[\s\S]{0,250}decisionHandler\(\.cancel\)/,
  );
  assert.match(
    source,
    /private func isAllowedExternalSubframeURL[\s\S]{0,500}\["http", "https"\][\s\S]{0,300}url\.user == nil[\s\S]{0,120}url\.password == nil/,
  );
  assert.match(
    source,
    /decidePolicyFor navigationAction[\s\S]{0,1400}targetFrame\?\.isMainFrame == false[\s\S]{0,500}isApplicationMainPage\(webView\)[\s\S]{0,300}isAllowedExternalSubframeURL\(url\)[\s\S]{0,160}decisionHandler\(\.allow\)/,
  );
  assert.match(
    source,
    /decidePolicyFor navigationResponse[\s\S]{0,1400}!navigationResponse\.isForMainFrame[\s\S]{0,350}isApplicationMainPage\(webView\)[\s\S]{0,300}isAllowedExternalSubframeURL\(url\)[\s\S]{0,160}decisionHandler\(\.allow\)/,
  );
});

test("native onboarding gives the exact unsigned Safari enablement steps", async () => {
  const source = await readFile(
    new URL("../macos/App/OurChoiceApp.swift", import.meta.url),
    "utf8",
  );

  assert.match(source, /browserExtensionGuideVersion\s*=\s*3/);
  assert.match(source, /Safari → 设置 → 高级/);
  assert.match(source, /显示开发者功能/);
  assert.match(source, /菜单栏“开发”/);
  assert.match(source, /允许未签名扩展/);
  assert.match(source, /退出 Safari 后[，、\s\S]{0,40}重置/);
});

test("native shell enables WebKit scrolling and refreshes Safari extension registration", async () => {
  const [source, styles, app] = await Promise.all([
    readFile(new URL("../macos/App/OurChoiceApp.swift", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/our-choice-app.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(source, /document\.documentElement\.dataset\.ourChoiceNative\s*=\s*"true"/);
  assert.match(source, /makeFirstResponder\(webView\)/);
  assert.match(styles, /html\[data-our-choice-native="true"\][\s\S]{0,500}overflow:\s*hidden/);
  assert.match(styles, /html\[data-our-choice-native="true"\][\s\S]{0,800}\.app-column[\s\S]{0,180}overflow-y:\s*auto/);
  assert.match(app, /querySelector<HTMLElement>\("\.app-column"\)/);
  assert.match(source, /LSRegisterURL\(Bundle\.main\.bundleURL as CFURL, true\)/);
  assert.match(source, /SFSafariExtensionManager\.getStateOfSafariExtension/);
  assert.match(source, /registerSafariExtensionHost/);
  assert.match(source, /允许未签名扩展/);
  assert.match(app, /nativeDesktopAuthorizationHeaders\(window, pairingCode\)/);
  assert.match(app, /原生应用已自动连接/);
});
