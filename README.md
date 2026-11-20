# SMP

Minecraft server panel: a web UI to create, configure and run Minecraft servers, browse and install mods and modpacks, manage files, backups and ports.

> Minecraft is a registered trademark of Mojang Studios. SMP is an independent project and is not affiliated with, endorsed by, sponsored by or associated with Mojang Studios, or Microsoft.

## Features

- **Multi-server management** with start, stop, restart and force stop, live console (ANSI colours, command input, log search, streaming), CPU/RAM stats and EULA handling.
- **Loaders**: Vanilla, Paper, Purpur, Folia, Velocity, Fabric, Quilt, NeoForge, Forge, Endstone, Bedrock, PumpkinMC and custom jars, with per-loader build channels (stable/experimental).
- **Mods and modpacks** from Modrinth, CurseForge, Hangar, FTB and Spiget (Spigot), with update detection; import a modpack from a `.zip` or install one from a store, then update it in place.
- **File manager** in the browser (edit, upload, rename, move, zip/unzip, download) plus an optional **SFTP** server with a per-server user and password.
- **Backups** streamed as `tar.zst`: on stop, on update and on loader change, with a retention limit, pruning, restore and download.
- **Port management**: per-server port allocation with a port profile per loader, conflict detection and auto-fix (port guard).
- **Java management**: download and manage runtimes (Eclipse Temurin 8–25) per server, or use the system Java (`PATH` / `JAVA_HOME`).
- **Server icon and MOTD** editors (PNG/JPEG/BMP uploads are resized to 64×64).
- **Self-update** from GitHub releases (stable or experimental) and a danger zone to wipe servers, Java runtimes or the panel itself.

## Install

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/cp-mario/SMP/main/install.sh | sh
```

**Windows**

```powershell
powershell -c "irm https://raw.githubusercontent.com/cp-mario/SMP/main/install.ps1|iex"
```

The installer asks for the release channel (latest **stable** — recommended — or latest **experimental**), installs Bun with the official installer if missing, downloads the source of that release from GitHub and installs it into `/opt/smp` (Linux/macOS, needs `root` or `sudo`) or `%LOCALAPPDATA%\SMP` (Windows). It then installs the `server/` and `web/` dependencies, builds the web panel into `server/src/public` and removes development-only files (tests, CI, dev launcher), so the first launch only starts the server. Set `SMP_INSTALL_DIR` to choose another directory and `SMP_CHANNEL=stable|experimental` to skip the channel prompt. It prints the command to run.

## Run

```sh
bun run /opt/smp/start.js                 # Linux / macOS
bun run "%LOCALAPPDATA%\SMP\start.js"     # Windows
```

The launcher installs the missing `server/` and `web/` dependencies, rebuilds the web panel only when its sources or lockfiles changed, checks the port (default `3001`, with the option to stop a previous instance or start on the next free port) and starts the API + panel at http://localhost:3001. A normal start does no dependency or build work: both are skipped when their state markers match. Set `SMP_FORCE_BUILD=1` to force a rebuild.

## Update

The panel checks the GitHub releases of the selected channel (stable = final releases only, experimental = pre-releases included) and updates itself in place in its installation directory:

- Settings → Updates, or
- `bun run server/src/cli.js update [stable|experimental]`

The download replaces the installation (the previous one is kept until the new one is in place), then the launcher is restarted by the panel. `SMP_REPO` overrides the repository used for updates.

## Development

Requirements: [Bun](https://bun.sh) >= 1.4.4 (no Node.js needed).

```sh
git clone https://github.com/cp-mario/SMP
cd SMP
bun install

# API (:3001) + web panel (:5173) with hot reload
bun run dev
```

Open http://localhost:5173: the Vite dev server (rolldown) reloads the panel on every change and proxies `/api` to `http://localhost:3001`.

`bun run start` builds the panel when needed (first run, after an update or after a web edit) and serves it from the Bun API at http://localhost:3001, without hot reload.

Root scripts (run from the repository root, after installing `server/` and `web/`):

| Script | Description |
| --- | --- |
| `bun run dev` | `dev.js`: start the API and the Vite dev server with hot reload |
| `bun run start` | `start.js`: install missing deps, rebuild only when the web app changed, and launch (no hot reload) |
| `bun run build` | Build the web panel into `server/src/public` |
| `bun run build:web` | Same as `build` |
| `bun run build:server` | Compile the API into `server/dist/smp` |
| `bun run check` | `svelte-check` for the web app |
| `bun test` | Web tests (`web/tests`) |
| `bun run version` | Print the current version |
| `bun run bump:patch` | Bump the patch version in `package.json` |

`bun run build` needs the `web/` dependencies. `start.js` reuses the previous build when the web sources, configuration and lockfile are unchanged, so it only invokes Vite after an update or an edit.

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `SMP_PORT` / `PORT` | `3001` | Panel port |
| `SMP_DATA_DIR` | `~/.smp` | Database, servers, Java runtimes and backups |
| `SMP_REPO` | `cp-mario/SMP` | GitHub repo used for updates |
| `SMP_SKIP_INSTALL` | `0` | Skip dependency install on launch (`1`) |
| `SMP_SKIP_BUILD` | `0` | Skip web build on launch (`1`) |
| `SMP_FORCE_BUILD` | `0` | Rebuild the web panel even when its inputs did not change (`1`) |
| `SMP_INSTALL_DIR` | platform default | Installation directory used by `install.sh` / `install.ps1` |
| `SMP_BACKUP_ZSTD_LEVEL` | `3` | Backup zstd level (1–19) |
| `SMP_SFTP_PORT` | `2222` | SFTP listening port |
| `SMP_SFTP_AUTO` | `0` | Start SFTP at boot even if no server has it enabled (`1`) |
| `SMP_PORT_GUARD_DELAY_MS` | `15000` | Port guard first check delay |
| `SMP_PORT_GUARD_INTERVAL_MS` | `10000` | Port guard check interval |

The data directory contains `smp.sqlite` (servers, settings, mods, backups, schedules), `servers/<id>/` (instance files plus `backups/`), `java/` (managed runtimes), `update.log` and `wipe.log`.

## Project layout

```
install.sh / install.ps1   one-shot installers (GitHub release -> /opt/smp or %LOCALAPPDATA%\SMP)
start.js                   launcher (port check, deps, incremental build, run)
dev.js                     dev launcher (API + Vite dev server with hot reload)
scripts/                   bun executable lookup, dependency/build state, installer and version helper
server/                    Elysia API (Bun): loaders, mods, backups, files, SFTP, Java, self-update
web/                       Svelte 5 + Vite web panel (see web/README.md)
.github/workflows/         pre-release + version sync automation
```

## License

MIT