// Shared child-process helper: resolves with the exit code instead of throwing.
import { spawn } from "node:child_process";

export function run(cmd, args, cwd, label, { stdio = "inherit" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio, shell: false });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) console.error(`[${label}] exited with code ${code}`);
      resolve(code ?? 0);
    });
    child.on("error", (e) => {
      console.error(`[${label}] failed to spawn: ${e?.message || e}`);
      resolve(1);
    });
  });
}