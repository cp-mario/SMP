// SMP dev.js - Starts the API (3001) and the Vite dev server with HMR (5173).
// `bun run dev` keeps hot reload; `bun run start` serves the built app without it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunCommand } from "./scripts/bun-bin.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(root, "server");
const webDir = path.join(root, "web");
const apiPort = Number(process.env.SMP_PORT || 3001);
const webPort = Number(process.env.SMP_WEB_PORT || 5173);
const skipInstall = process.env.SMP_SKIP_INSTALL === "1";
const bun = bunCommand();

async function ensureDependencies(dir, label) {
  if (skipInstall || existsSync(path.join(dir, "node_modules"))) return;
  console.log(`Installing ${label} dependencies...`);
  const code = await new Promise((resolve) => {
    const child = spawn(bun, ["install"], { cwd: dir, stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 0));
    child.on("error", (e) => { console.error(`[${label}-install] ${e?.message || e}`); resolve(1); });
  });
  if (code !== 0) { console.error(`Could not install ${label} dependencies.`); process.exit(code); }
}

const children = [];
let shuttingDown = false;

function launch(label, args, cwd, env = {}) {
  const child = spawn(bun, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (e) => console.error(`[${label}] failed to spawn: ${e?.message || e}`));
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`\n[${label}] exited with code ${code ?? 0}; stopping the other process...`);
    shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await ensureDependencies(serverDir, "server");
await ensureDependencies(webDir, "web");

console.log(`API  http://localhost:${apiPort}`);
console.log(`Web  http://localhost:${webPort} (HMR on, proxies /api to ${apiPort})`);

launch("server", ["run", "src/index.js"], serverDir, {
  SMP_PORT: String(apiPort),
  PORT: String(apiPort),
});
launch("web", ["run", "dev"], webDir, {
  SMP_PORT: String(apiPort),
  SMP_WEB_PORT: String(webPort),
});

await new Promise(() => {});