#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagingChromeExtensionID } from "./macos-chrome-registration.mjs";
import {
  defaultOutputPackage,
  parseArguments as parsePackageArguments,
} from "./package-macos.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hasSkipNotarization(arguments_) {
  return arguments_.some((argument) => (
    argument === "--skip-notarization" || argument.startsWith("--skip-notarization=")
  ));
}

export function withoutSigningCredentials(sourceEnvironment) {
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DEVELOPER_DIR",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "OUR_CHOICE_BUILD_VERSION",
    "OUR_CHOICE_NODE_ARM64",
    "OUR_CHOICE_NODE_X64",
    "OUR_CHOICE_CHROME_EXTENSION_ID",
    "OUR_CHOICE_DEVELOPMENT_TEAM",
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (allowedNames.has(name) && typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }
  return environment;
}

function runCommand(label, command, arguments_, environment = process.env) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(new Error(
        `${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`,
      ));
    });
  });
}

export async function runReleasePackaging(arguments_ = process.argv.slice(2)) {
  const skipNotarization = hasSkipNotarization(arguments_);
  const packageOptions = parsePackageArguments(arguments_);
  const configuredChromeExtensionID = process.env.OUR_CHOICE_CHROME_EXTENSION_ID;
  const manualChromeInstall = Boolean(packageOptions["manual-chrome-install"])
    || !configuredChromeExtensionID;
  resolvePackagingChromeExtensionID(
    configuredChromeExtensionID,
    { manualChromeInstall },
  );
  const safeEnvironment = withoutSigningCredentials(process.env);
  const prepareArguments = [];
  for (const name of ["node-arm64", "node-x64", "manifest"]) {
    if (packageOptions[name]) prepareArguments.push(`--${name}`, packageOptions[name]);
  }
  if (packageOptions.app) prepareArguments.push("--out", packageOptions.app);
  if (skipNotarization) prepareArguments.push("--skip-notarization");

  await runCommand("mac:build", "npm", ["run", "mac:build"], safeEnvironment);
  await runCommand(
    "prepare-macos-release.mjs",
    process.execPath,
    [resolve(root, "scripts", "prepare-macos-release.mjs"), ...prepareArguments],
    safeEnvironment,
  );
  await runCommand(
    "package-macos.mjs",
    process.execPath,
    [resolve(root, "scripts", "package-macos.mjs"), ...arguments_],
  );

  const packagePathValue = packageOptions.out
    ?? defaultOutputPackage({ skipNotarization });
  const packagePath = isAbsolute(packagePathValue)
    ? packagePathValue
    : resolve(root, packagePathValue);
  const verifierArguments = [
    resolve(root, "scripts", "verify-macos-package.mjs"),
    packagePath,
  ];
  if (skipNotarization) verifierArguments.push("--allow-unnotarized");
  if (manualChromeInstall) verifierArguments.push("--manual-chrome-install");
  await runCommand(
    "verify-macos-package.mjs",
    process.execPath,
    verifierArguments,
    safeEnvironment,
  );
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runReleasePackaging().catch((error) => {
    console.error(`[mac:package] ${error.message}`);
    process.exitCode = 1;
  });
}
