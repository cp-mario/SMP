#!/usr/bin/env bun
// Version helper for the release workflows (and for local use).
//
// The root package.json is the single source of truth for the panel version.
//
//   bun scripts/version.js bump            # 0.1.0 -> 0.1.1, prints the new version
//   bun scripts/version.js set 1.2.3       # write an exact version, prints it
//   bun scripts/version.js get             # print the current version
//
// Exit codes: 0 ok, 1 usage/validation error, 2 already up to date (set).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, "utf8"));
}

/** Writes the version keeping the rest of the file byte-identical. */
function writeVersion(version) {
  const raw = readFileSync(pkgPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const pkg = readPkg();
  pkg.version = version;
  // 2-space indent is what the repository uses; keep a trailing newline.
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + eol);
}

function parseVersion(value) {
  const m = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function currentVersion() {
  const pkg = readPkg();
  if (!parseVersion(pkg.version)) {
    console.error(`package.json has an invalid version: ${pkg.version}`);
    process.exit(1);
  }
  return String(pkg.version).trim();
}

function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "get") {
    console.log(currentVersion());
    return;
  }

  if (cmd === "bump") {
    const [major, minor, patch] = parseVersion(currentVersion());
    const next = `${major}.${minor}.${patch + 1}`;
    writeVersion(next);
    console.log(next);
    return;
  }

  if (cmd === "set") {
    const parsed = parseVersion(arg);
    if (!parsed) {
      console.error(`Usage: bun scripts/version.js set <major.minor.patch> (got "${arg ?? ""}")`);
      process.exit(1);
    }
    const next = parsed.join(".");
    const current = currentVersion();
    if (current === next) {
      console.error(`package.json is already at ${next}`);
      process.exit(2);
    }
    writeVersion(next);
    console.log(next);
    return;
  }

  console.error("Usage: bun scripts/version.js <bump|set <version>|get>");
  process.exit(1);
}

if (!existsSync(pkgPath)) {
  console.error(`package.json not found at ${pkgPath}`);
  process.exit(1);
}

main();