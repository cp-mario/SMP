#!/usr/bin/env bun
// Prepares a downloaded SMP source tree for production:
//   1. installs server/ and web/ dependencies with a frozen lockfile,
//   2. builds the Svelte panel into server/src/public,
//   3. removes development-only files (tests, CI, dev launcher).
//
// The installers run this in a staging directory before moving it into place,
// so the first launch of the panel only has to start the server.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunCommand } from "./bun-bin.js";
import { ensureWebBuild } from "./build-web.js";
import { installDependencies } from "./deps.js";
import { pruneTree } from "./prune.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");
const webDir = path.join(root, "web");

function fail(message) {
  console.error(`SMP install failed: ${message}`);
  process.exit(1);
}

function bunVersion(bun) {
  try {
    return execFileSync(bun, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function versionAtLeast(version, major, minor, patch) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) return false;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return a > major || (a === major && (b > minor || (b === minor && c >= patch)));
}

function readAppVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

async function main() {
  if (!existsSync(path.join(root, "package.json")) || !existsSync(path.join(root, "start.js"))) {
    fail("this does not look like an SMP source tree.");
  }

  const bun = bunCommand();
  const version = bunVersion(bun);
  if (!versionAtLeast(version, 1, 4, 4)) {
    fail(`Bun ${version || "(unknown)"} is too old; SMP requires Bun >= 1.4.4 (run: bun upgrade).`);
  }

  const appVersion = readAppVersion();
  console.log(`Preparing SMP ${appVersion} in ${root}`);
  console.log(`Bun ${version}`);

  await installDependencies(serverDir, "server", { bun });
  await installDependencies(webDir, "web", { bun });

  const build = await ensureWebBuild({ root, webDir, force: true });
  if (!build.ok) fail(build.error || "the web build failed.");

  const indexPath = path.join(root, "server", "src", "public", "index.html");
  if (!existsSync(indexPath)) fail("the web build did not produce server/src/public/index.html.");

  const removed = pruneTree(root);
  if (removed.length) console.log(`Removed development files: ${removed.join(", ")}`);

  console.log(`SMP ${appVersion} is ready in ${root}`);
  console.log(`Start it with: bun run "${path.join(root, "start.js")}"`);
}

main().catch((error) => fail(error?.message || String(error)));