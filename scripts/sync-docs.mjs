import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "docs");
const destination = path.join(projectRoot, "public", "docs");

await mkdir(path.dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });

console.log("Documentation synced to public/docs/");
