import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vp = join(root, "web", "node_modules", "vite-plus", "bin", "vp");
const args = process.argv.slice(2);
const command = args[0] ?? "build";

function bunCommand() {
  if (process.platform === "win32") {
    const home = homedir();
    const candidates = [
      join(home, ".bun", "bin", "bun.exe"),
      join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "bun.exe"),
      join(process.env.APPDATA || "", "npm", "bun.cmd"),
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
  }
  return "bun";
}

const res = spawnSync(bunCommand(), [vp, command, ...args.slice(1), "web"], {
  cwd: root,
  stdio: "inherit",
});

if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 0);