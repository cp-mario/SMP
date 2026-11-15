// Resolve a real bun executable, preferring it over shell shims on Windows.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function bunCommand() {
  if (process.platform !== "win32") return "bun";
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun.exe") : "",
    join(homedir(), ".bun", "bin", "bun.exe"),
    join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "bun.exe"),
    join(process.env.APPDATA || "", "npm", "bun.cmd"),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return "bun";
}