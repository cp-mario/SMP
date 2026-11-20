// Removes development-only files from an installed tree.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

// Mirrors .gitattributes export-ignore: release archives should never carry
// these, but a local source tree or an older archive still can.
export const DEV_PATHS = [
  ".github",
  ".junie",
  "dev.js",
  "web/tests",
  "web/README.md",
  "web/scripts",
];

export function pruneTree(root) {
  const removed = [];
  for (const rel of DEV_PATHS) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(rel);
    } catch {}
  }
  return removed;
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] || ".");
  const removed = pruneTree(root);
  if (removed.length) console.log(`Removed development files: ${removed.join(", ")}`);
  else console.log("Nothing to prune.");
}