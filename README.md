# SMP

Minecraft server panel: a web UI to create, configure and run Minecraft servers, browse and install mods and modpacks, manage backups and ports.

## Install

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/cp-mario/SMP/main/install.sh | sh
```

**Windows** (PowerShell as Administrator)

```powershell
powershell -c "irm https://raw.githubusercontent.com/cp-mario/SMP/main/install.ps1|iex"
```

The installer asks for the release channel (latest **stable** — recommended — or latest **experimental**), installs Bun with the official installer if missing, downloads the source of that release from GitHub, and installs the project into `/opt/smp` (Linux) or `C:\Program Files\smp` (Windows). It then installs the dependencies, builds the web panel and prints how to run it.

## Run

```sh
bun run /opt/smp/start.js
```

The launcher installs missing dependencies, builds the web app, checks the port (default `3001`) and starts the API + panel at http://localhost:3001.

## Update

The panel checks GitHub releases for the selected channel (stable = final releases only, experimental = pre-releases included) and updates itself in place in its installation directory: Settings → Updates, or:

```sh
bun run /opt/smp/server/src/cli.js update          # latest of the current channel
bun run /opt/smp/server/src/cli.js update exp      # latest experimental
```

## Features

- Multi-server management with start/stop, live logs and status.
- Loaders: Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Quilt, Endstone, Bedrock, PumpkinMC and custom jars.
- Mods and modpacks from Modrinth, CurseForge, Hangar, FTB and Spiget, with update detection.
- Backups (on stop, on update, on loader change) with pruning.
- Port allocation and conflict detection (port guard).
- SFTP file access to server directories.
- Java version management per server.

## CLI

```sh
bun run server/src/cli.js <command>
```

| Command | Description |
| --- | --- |
| `status` | Show panel status |
| `start` / `run` | Start the panel server |
| `stop` | Stop a running panel |
| `update [channel]` | Self-update from GitHub |
| `version` | Print the version |
| `uninstall` | Uninstall instructions |

## Development

Requirements: [Bun](https://bun.sh) >= 1.4.4.

```sh
git clone https://github.com/cp-mario/SMP
cd SMP

# server (API, port 3001)
cd server && bun install && bun run dev

# web (panel, port 5173, proxies /api to 3001)
cd web && bun install && bun run dev
```

Or build everything and run the panel once:

```sh
bun install          # in server/ and web/
bun run build        # builds the web panel into server/src/public
bun run start        # runs start.js (install, build, launch)
```

Web tests: `cd web && bun test ./tests`

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `SMP_PORT` / `PORT` | `3001` | Panel port |
| `SMP_DATA_DIR` | `~/.smp` | Database, backups and server data |
| `SMP_REPO` | `cp-mario/SMP` | GitHub repo used for updates |
| `SMP_SKIP_INSTALL` | `0` | Skip dependency install on launch |
| `SMP_SKIP_BUILD` | `0` | Skip web build on launch (useful when the install dir is read-only) |
| `SMP_PORT_GUARD_DELAY_MS` | `15000` | Port guard first check delay |
| `SMP_PORT_GUARD_INTERVAL_MS` | `10000` | Port guard check interval |

## Project layout

```
install.sh / install.ps1   one-shot installers (GitHub release -> /opt/smp or C:\Program Files\smp)
start.js                   launcher (port check, deps, build, run)
server/                    Elysia API (Bun), loaders, mods, backups, SFTP, self-update
web/                       Svelte 5 + Vite web panel
.github/workflows/         pre-release + version sync automation
```

## License

MIT