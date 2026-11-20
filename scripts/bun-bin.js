// Resolve a real bun executable, preferring the running one over shell shims.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function isBunExecutable(value) {
  return /(^|[\\/])bun(\.exe)?$/i.test(String(value || ""));
}

export function bunCommand() {
  const exec = process.execPath || "";
  if (isBunExecutable(exec)) return exec;
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