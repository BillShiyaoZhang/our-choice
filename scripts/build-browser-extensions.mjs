#!/usr/bin/env node

import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(projectRoot, "browser-extension");

function requestedOutput() {
  let value = null;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--out") {
      value = process.argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--out=")) {
      value = argument.slice("--out=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!value) return join(projectRoot, "build", "browser-extensions");
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

async function copyResources(source, destination) {
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Extension resource root must be a regular directory: ${source}`);
  }
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if ([".DS_Store", "README.md"].includes(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Extension resources must not contain symbolic links: ${from}`);
    }
    if (metadata.isDirectory()) {
      await copyResources(from, to);
      continue;
    }
    if (metadata.isFile()) {
      await copyFile(from, to);
      continue;
    }
    throw new Error(`Extension resources must contain only regular files: ${from}`);
  }
}

async function resetManagedDirectory(directory) {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link extension output: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

const outputRoot = requestedOutput();
const relativeOutput = relative(sourceRoot, outputRoot);
if (!relativeOutput || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput))) {
  throw new Error("Extension output must be outside browser-extension/.");
}
await mkdir(outputRoot, { recursive: true });
const outputRootMetadata = await lstat(outputRoot);
if (!outputRootMetadata.isDirectory() || outputRootMetadata.isSymbolicLink()) {
  throw new Error(`Extension output root must be a regular directory: ${outputRoot}`);
}
const [realSourceRoot, realOutputRoot] = await Promise.all([
  realpath(sourceRoot),
  realpath(outputRoot),
]);
const realRelativeOutput = relative(realSourceRoot, realOutputRoot);
if (!realRelativeOutput || (!realRelativeOutput.startsWith("..") && !isAbsolute(realRelativeOutput))) {
  throw new Error("Resolved extension output must be outside browser-extension/.");
}

const manifest = JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Only Manifest V3 builds are supported.");

for (const browserName of ["chrome", "safari"]) {
  const browserOutput = join(outputRoot, browserName);
  await resetManagedDirectory(browserOutput);
  await copyResources(sourceRoot, browserOutput);
  await writeFile(
    join(browserOutput, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

console.log(`Browser extension resources written to ${outputRoot}`);
