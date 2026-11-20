#!/usr/bin/env node
// SMP CLI entry (runs under bun)
// Usage: bun run cli.js <command> [args]
//   status    - show panel status
//   start     - start the panel server (alias: run)
//   stop      - stop a running panel server
//   update    - self-update from the latest release
//   version   - print version
//   uninstall - remove the smp launcher

import { $ } from "bun";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { appVersion, compareVersions, fetchLatestRelease, applyUpdate, RELEASES_FEED } from "./core/version.js";

function bunCommand() {
  if (process.platform === "win32") {
    const home = process.env.USERPROFILE || homedir();
    const candidates = [
      join(home, ".bun", "bin", "bun.exe"),
      join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "bun.exe"),
      join(process.env.APPDATA || "", "npm", "bun.cmd"),
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
  }
  return "bun";
}

const __dirname = dirnameOf(import.meta.url);
const ROOT = resolve(__dirname, "../..");
const SERVER_ENTRY = join(ROOT, "server/src/index.js");
const DEFAULT_PORT = Number(process.env.SMP_PORT || process.env.PORT || 3001);
const BIN_DIR = process.platform === "win32"
  ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm")
  : "/usr/local/bin";

function dirnameOf(metaUrl) {
  return fileURLToPath(new URL(".", metaUrl));
}

function json(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = json(await res.text());
    return { ok: res.ok, info: body };
  } catch {
    return { ok: false, info: null };
  }
}

async function pidOnPort(port) {
  try {
    const info = await probe(port);
    if (info.info?.pid) return info.info.pid;
  } catch { /* noop */ }
  return null;
}

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case "version":
    case "-v":
    case "--version":
      console.log(`smp ${appVersion()}`);
      break;

    case "status": {
      const p = await probe(DEFAULT_PORT);
      if (p.ok && p.info?.service === "smp") {
        const uptime = p.info.startedAt ? Math.round((Date.now() - p.info.startedAt) / 1000) : null;
        console.log(`SMP panel: running (http://localhost:${DEFAULT_PORT})`);
        console.log(`  pid: ${p.info.pid ?? "?"}${uptime != null ? ` · up ${uptime}s` : ""}`);
      } else if (p.ok) {
        console.log(`Port ${DEFAULT_PORT} is used by another service.`);
        process.exitCode = 1;
      } else {
        console.log("SMP panel: stopped");
      }
      break;
    }

    case "start":
    case "run": {
      if (!existsSync(SERVER_ENTRY)) {
        console.error(`Server entry not found: ${SERVER_ENTRY}`);
        process.exit(1);
      }
      const proc = Bun.spawn([bunCommand(), "run", SERVER_ENTRY], {
        cwd: ROOT,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, SMP_PORT: String(DEFAULT_PORT), PORT: String(DEFAULT_PORT) },
      });
      process.exit(await proc.exited);
      break;
    }

    case "stop": {
      const pid = await pidOnPort(DEFAULT_PORT);
      if (!pid) {
        console.log("SMP panel is not running.");
        break;
      }
      try {
        if (process.platform === "win32") await $`taskkill /PID ${pid} /T /F`.quiet();
        else process.kill(pid, "SIGTERM");
        console.log(`Stopped SMP panel (pid ${pid}).`);
      } catch (e) {
        console.error(`Could not stop pid ${pid}: ${e?.message || e}`);
        process.exitCode = 1;
      }
      break;
    }

    case "update": {
      console.log("Self-update: fetching the latest release…");
      try {
        const rel = await fetchLatestRelease();
        const current = appVersion();
        const newer = compareVersions(rel.version, current) > 0;
        console.log(`Installed: ${current}`);
        console.log(`Latest:    ${rel.version}${rel.isPrerelease ? " (pre-release)" : ""}`);
        if (newer) {
          console.log("A newer version is available.");
          if (rel.url) console.log(`Release:   ${rel.url}`);
          const channel = process.argv[3] || (rel.isPrerelease ? "experimental" : "stable");
          console.log(`Installing ${rel.version} (${channel})…`);
          const result = await applyUpdate({ target: rel.version, current, channel });
          for (const step of result.steps || []) console.log(`  [${step.status}] ${step.label}`);
          if (!result.ok) {
            if (result.code === "UP_TO_DATE") {
              console.log(`Already up to date (${current}).`);
              console.log(`Refresh the panel to load it: http://localhost:${DEFAULT_PORT}/update`);
            } else {
              console.error(`Update failed: ${result.message}`);
              process.exitCode = 1;
            }
          } else {
            console.log(result.message);
            console.log(`Refresh the panel to load the new version: http://localhost:${DEFAULT_PORT}/update`);
          }
        } else {
          console.log(`Already up to date (${current}).`);
          console.log(`Refresh the panel to load the installed version: http://localhost:${DEFAULT_PORT}/update`);
        }
        if (!rel.url && RELEASES_FEED) console.log(`Releases:  ${RELEASES_FEED}`);
      } catch (e) {
        const message = e?.status === 404
          ? "the GitHub repository is not available yet"
          : e?.message || String(e);
        console.error(`Update check failed: ${message}`);
        if (RELEASES_FEED) console.error(`Releases:  ${RELEASES_FEED}`);
        process.exitCode = 1;
      }
      break;
    }

    case "uninstall": {
      console.log("Uninstall removes the `smp` launcher. Panel data stays in your data directory.");
      console.log(`  Data directory: ${process.env.SMP_DATA_DIR || join(homedir(), ".smp")}`);
      console.log(`  Binary directory: ${BIN_DIR}`);
      console.log("Re-run install.sh / install.ps1 to reinstall.");
      break;
    }

    default:
      console.log("Usage: smp <status|start|run|stop|update|version|uninstall>");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});