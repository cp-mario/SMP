import AdmZip from "adm-zip";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BaseLoader, fetchJson } from "./BaseLoader.js";

const RELEASES_API = "https://api.github.com/repos/EndstoneMC/endstone/releases?per_page=30";
const CACHE_MS = 10 * 60 * 1000;
let releaseCache = { at: 0, releases: [] };

function platformPart() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return null;
}

function isX64() {
  return ["x64", "x86_64", "amd64"].includes(String(process.arch || "").toLowerCase());
}

function startScriptName() {
  return process.platform === "win32" ? "start-endstone.cmd" : "start-endstone.sh";
}

function bundleVersion(tag) {
  return String(tag || "").trim().replace(/^v/i, "");
}

function bdsVersion(release) {
  const body = String(release?.body || "");
  const m = body.match(/BDS\s+version\s+v?([0-9]+(?:\.[0-9]+)+)/i)
    || body.match(/Bedrock\s+Dedicated\s+Server\s+v?([0-9]+(?:\.[0-9]+)+)/i);
  return m ? m[1] : null;
}

function assetFor(release) {
  const platform = platformPart();
  if (!platform || !isX64()) return null;
  const re = new RegExp(`^endstone-.*-${platform}-x86_64\\.zip$`, "i");
  return (release?.assets || []).find((asset) => re.test(String(asset?.name || ""))) || null;
}

function sha256Of(asset) {
  const digest = String(asset?.digest || "");
  const m = digest.match(/^sha256:([a-f0-9]{64})$/i);
  return m ? m[1] : null;
}

function winStartScript() {
  return [
    "@echo off",
    "setlocal",
    "pushd \"%~dp0\"",
    "set \"WHEEL=\"",
    "for %%f in (\"%~dp0endstone-*.whl\") do set \"WHEEL=%%f\"",
    "if \"%WHEEL%\"==\"\" (",
    "  echo Could not find an endstone wheel next to this script. 1>&2",
    "  popd",
    "  exit /b 1",
    ")",
    "where uv >nul 2>&1",
    "if errorlevel 1 (",
    "  if exist \"%USERPROFILE%\\.local\\bin\\uv.exe\" (",
    "    set \"PATH=%USERPROFILE%\\.local\\bin;%PATH%\"",
    "  ) else (",
    "    echo Installing uv...",
    "    powershell -ExecutionPolicy ByPass -NoProfile -Command \"irm https://astral.sh/uv/install.ps1 | iex\"",
    "    if errorlevel 1 (",
    "      echo Failed to install uv. 1>&2",
    "      popd",
    "      exit /b 1",
    "    )",
    "    set \"PATH=%USERPROFILE%\\.local\\bin;%PATH%\"",
    "  )",
    ")",
    "if not exist \".venv\\Scripts\\python.exe\" (",
    "  echo Creating Endstone virtual environment...",
    "  uv venv --managed-python --python 3.13 .venv",
    "  if errorlevel 1 (",
    "    echo Failed to create the Endstone virtual environment. 1>&2",
    "    popd",
    "    exit /b 1",
    "  )",
    ")",
    "uv pip install --python .venv \"%WHEEL%\"",
    "if errorlevel 1 (",
    "  echo Failed to install the Endstone wheel. 1>&2",
    "  popd",
    "  exit /b 1",
    ")",
    "\".venv\\Scripts\\python.exe\" -m endstone -i -y %*",
    "set \"CODE=%ERRORLEVEL%\"",
    "popd",
    "endlocal & exit /b %CODE%",
    "",
  ].join("\r\n");
}

function linuxStartScript() {
  return [
    "#!/usr/bin/env bash",
    "set -e",
    "cd \"$(dirname \"$0\")\"",
    "WHEEL=\"$(ls endstone-*.whl 2>/dev/null | head -n 1 || true)\"",
    "if [ -z \"$WHEEL\" ]; then",
    "  echo \"Could not find an endstone wheel next to this script.\" >&2",
    "  exit 1",
    "fi",
    "if command -v uv >/dev/null 2>&1; then",
    "  :",
    "elif [ -x \"$HOME/.local/bin/uv\" ]; then",
    "  export PATH=\"$HOME/.local/bin:$PATH\"",
    "else",
    "  echo \"Installing uv...\"",
    "  curl -LsSf https://astral.sh/uv/install.sh | sh",
    "  export PATH=\"$HOME/.local/bin:$PATH\"",
    "fi",
    "if [ ! -x \".venv/bin/python\" ]; then",
    "  echo \"Creating Endstone virtual environment...\"",
    "  uv venv --managed-python --python 3.13 .venv",
    "fi",
    "uv pip install --python .venv \"$WHEEL\"",
    "exec .venv/bin/python -m endstone -i -y \"$@\"",
    "",
  ].join("\n");
}

function writeStartScript(dir) {
  const name = startScriptName();
  const path = join(dir, name);
  writeFileSync(path, process.platform === "win32" ? winStartScript() : linuxStartScript(), "utf8");
  if (process.platform !== "win32") {
    try { chmodSync(path, 0o755); } catch {}
  }
  return path;
}

function extractBundle(zipPath, dir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length) throw new Error("Endstone bundle is empty");

  const first = entries[0].entryName.split("/")[0];
  const prefix = first && entries.every((entry) => entry.entryName.startsWith(`${first}/`)) ? `${first}/` : "";
  const extractedWheels = new Set();

  for (const entry of entries) {
    const rel = prefix && entry.entryName.startsWith(prefix) ? entry.entryName.slice(prefix.length) : entry.entryName;
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const out = join(dir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, entry.getData());
    if (/\.whl$/i.test(rel)) extractedWheels.add(rel);
    if (process.platform !== "win32" && /\.(sh|so)$/i.test(rel)) {
      try { chmodSync(out, 0o755); } catch {}
    }
  }

  // Keep exactly the wheel from the installed bundle; leftovers break `endstone-*.whl`.
  for (const file of readdirSync(dir)) {
    if (/^endstone-.*\.whl$/i.test(file) && !extractedWheels.has(file)) {
      try { rmSync(join(dir, file), { force: true }); } catch {}
    }
  }
}

export class EndstoneLoader extends BaseLoader {
  static id = "endstone";
  static name = "Endstone";
  static type = "native";
  static java = false;
  static eula = false;

  async _releases(force = false) {
    if (!platformPart() || !isX64()) throw new Error("Endstone only provides x86-64 builds for Windows and Linux");
    if (!force && releaseCache.releases.length && Date.now() - releaseCache.at < CACHE_MS) {
      return releaseCache.releases;
    }
    const releases = await fetchJson(RELEASES_API);
    const list = (Array.isArray(releases) ? releases : [])
      .filter((release) => release && !release.draft && !release.prerelease && assetFor(release))
      .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
    releaseCache = { at: Date.now(), releases: list };
    return list;
  }

  async getVersions() {
    const releases = await this._releases();
    return releases.map((release) => ({
      id: release.tag_name,
      stable: !release.prerelease,
      channel: release.prerelease ? "experimental" : "stable",
      meta: {
        mc: bdsVersion(release),
        publishedAt: release.published_at || null,
        url: release.html_url || null,
        name: release.name || release.tag_name,
      },
    }));
  }

  async resolveDownload(version) {
    const wanted = String(version || "").trim().replace(/^v/i, "");
    let releases = await this._releases();
    let release = releases.find((item) => bundleVersion(item.tag_name) === wanted);
    if (!release) {
      releases = await this._releases(true);
      release = releases.find((item) => bundleVersion(item.tag_name) === wanted);
    }
    if (!release) throw new Error(`Endstone version not found: ${version}`);

    const asset = assetFor(release);
    if (!asset) throw new Error("Endstone only provides x86-64 builds for Windows and Linux");

    return {
      url: asset.browser_download_url,
      fileName: asset.name,
      sha256: sha256Of(asset),
      size: asset.size,
      meta: { mc: bdsVersion(release) },
      postInstall: async ({ dir, sourcePath }) => {
        extractBundle(sourcePath, dir);
        writeStartScript(dir);
        try { rmSync(sourcePath, { force: true }); } catch {}
      },
    };
  }

  async install(opts = {}) {
    const result = await super.install(opts);
    const dir = opts.dir || ".";
    // A new wheel must be installed by the start script again on the next boot.
    try { rmSync(join(dir, ".venv"), { recursive: true, force: true }); } catch {}
    const script = startScriptName();
    const path = join(dir, script);
    result.file = script;
    result.path = path;
    result.size = existsSync(path) ? statSync(path).size : 0;
    result.exec = null;
    return result;
  }

  getExecution({ jar, dir = "." } = {}) {
    const script = /\.(cmd|sh)$/i.test(String(jar || "")) ? String(jar) : startScriptName();
    const python = process.platform === "win32"
      ? join(dir, ".venv", "Scripts", "python.exe")
      : join(dir, ".venv", "bin", "python");

    // Once uv has provisioned the environment, run Python directly so the
    // process tree (and strict port guarding) sees the real server PID.
    if (existsSync(python)) {
      return {
        type: "native",
        command: python,
        args: ["-m", "endstone", "-i", "-y"],
        jar: script,
      };
    }

    if (process.platform === "win32") {
      return {
        type: "native",
        command: "cmd.exe",
        args: ["/d", "/s", "/c", script],
        jar: script,
      };
    }

    return {
      type: "native",
      command: "bash",
      args: [script],
      jar: script,
    };
  }
}
