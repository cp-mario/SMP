<#
.SYNOPSIS
    SMP Installer (Windows)
.DESCRIPTION
    Installs Bun (official installer) if missing, asks for the release channel,
    downloads the source from GitHub, installs the server/web dependencies,
    builds the Svelte panel, removes development-only files and installs
    everything into %LOCALAPPDATA%\SMP (or $env:SMP_INSTALL_DIR).
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell 5.1 defaults to old TLS versions on some systems; GitHub
# requires TLS 1.2.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

Write-Host "SMP Installer (Windows)" -ForegroundColor Green

function Get-BunCommand {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# --- Bun (official installer, only when missing) ---

$bun = Get-BunCommand
if (-not $bun) {
    Write-Host "Installing Bun..." -ForegroundColor Cyan
    powershell -c "irm bun.sh/install.ps1|iex"
    $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
    $env:PATH = "$bunBin;$env:PATH"
    $bun = Get-BunCommand
    if (-not $bun) { throw "Bun installation failed." }
}

Write-Host "Bun: $(& $bun --version)"

# --- Release channel (SMP_CHANNEL or interactive prompt) ---

$channelAnswer = if ($env:SMP_CHANNEL) { $env:SMP_CHANNEL } else { "" }

if (-not $channelAnswer -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    Write-Host "Choose the release channel:" -ForegroundColor Cyan
    Write-Host "  1) Stable (recommended)"
    Write-Host "  2) Experimental (pre-releases included)"
    $channelAnswer = (Read-Host "Channel [1/stable, default 1]").Trim().ToLowerInvariant()
}

$channel = if ($channelAnswer -in @("2", "experimental", "exp", "beta", "pre")) { "experimental" } else { "stable" }
Write-Host "Channel: $channel"

# --- Resolve the latest release of the channel (Atom feed / latest page, no API) ---

if ($channel -eq "experimental") {
    try {
        $atom = (Invoke-WebRequest "https://github.com/cp-mario/SMP/releases.atom" -UseBasicParsing).Content
        $entry = [regex]::Match($atom, "(?s)<entry>.*?</entry>").Value
        $tag = [regex]::Match($entry, "<title>([^<]+)</title>").Groups[1].Value.Trim()
    } catch {
        throw "Could not resolve the latest $channel release from GitHub: $($_.Exception.Message)"
    }
} else {
    try {
        $page = (Invoke-WebRequest "https://github.com/cp-mario/SMP/releases/latest" -UseBasicParsing).Content
        $tag = [regex]::Match($page, "<title>[^<]*?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[^<]*</title>").Groups[1].Value
    } catch {
        throw "Could not resolve the latest $channel release from GitHub: $($_.Exception.Message)"
    }
}
if (-not $tag) { throw "Could not resolve the latest $channel release from GitHub." }
$version = $tag -replace '^v', ''
Write-Host "Downloading SMP $tag (source)..." -ForegroundColor Cyan

# --- Refuse to overwrite a running installation ---

$port = if ($env:SMP_PORT) { $env:SMP_PORT } else { "3001" }
$running = $false
try {
    $health = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2
    if ($health.Content -match '"service"\s*:\s*"smp"') { $running = $true }
} catch { }

if ($running) {
    throw "An SMP panel is already running on port $port. Stop it before installing, or use Settings -> Updates to update in place."
}

# --- Install directory ---

$installDir = if ($env:SMP_INSTALL_DIR) { $env:SMP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "SMP" }
$installDir = [System.IO.Path]::GetFullPath($installDir)
$parent = Split-Path $installDir -Parent
if (-not $parent) { throw "Could not determine the parent directory of $installDir." }
New-Item -ItemType Directory -Force -Path $parent | Out-Null

# --- Download and unpack the source ---

# Keep the download on the same volume as the installation: the final swap is
# then a rename (no copying of node_modules) and moving the extracted tree
# cannot fail on a cross-volume move.
$work = Join-Path $parent (".smp-download-" + [guid]::NewGuid().ToString("N"))
$stage = $null
$backup = $null

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work "smp.zip"
    $downloaded = $false
    for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
        try {
            Invoke-WebRequest "https://github.com/cp-mario/SMP/archive/refs/tags/$tag.zip" -OutFile $zip
            $downloaded = $true
        } catch {
            if ($attempt -eq 3) { throw "Failed to download SMP source: $($_.Exception.Message)" }
            Start-Sleep -Seconds 2
        }
    }
    Expand-Archive -Path $zip -DestinationPath $work -Force
    $src = Get-ChildItem $work -Directory | Where-Object { $_.Name -like "SMP-*" } | Select-Object -First 1
    if (-not $src) { throw "Unexpected archive layout: no SMP-<version> folder inside the zip." }

    # The stage lives next to the installation so the final swap is a rename on the
    # same volume (no copying of node_modules).
    $stage = Join-Path $parent (".smp-install-" + [guid]::NewGuid().ToString("N"))
    $backup = Join-Path $parent (".smp-backup-" + [guid]::NewGuid().ToString("N"))

    Move-Item -LiteralPath $src.FullName -Destination $stage

    if (-not (Test-Path -LiteralPath (Join-Path $stage "start.js"))) {
        throw "Unexpected archive layout: start.js not found."
    }

    # --- Install dependencies, build the panel, drop development files ---

    if (Test-Path -LiteralPath (Join-Path $stage "scripts\install-app.js")) {
        Write-Host "Installing dependencies and building the web panel..." -ForegroundColor Cyan

        & $bun run (Join-Path $stage "scripts\install-app.js")
        if ($LASTEXITCODE -ne 0) { throw "install-app.js exited with code $LASTEXITCODE." }
    } else {
        # Releases older than scripts/install-app.js install on first launch.
        Write-Host "This release predates the pre-install step; dependencies will be installed on first launch."
        foreach ($rel in @("web\tests", "web\README.md", "web\scripts", ".github", ".junie", "dev.js")) {
            Remove-Item -LiteralPath (Join-Path $stage $rel) -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # --- Replace previous installation ---

    if (Test-Path -LiteralPath $installDir) {
        Write-Host "Backing up previous installation..."
        Move-Item -LiteralPath $installDir -Destination $backup
    }

    try {
        Move-Item -LiteralPath $stage -Destination $installDir
    } catch {
        if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $installDir)) {
            Move-Item -LiteralPath $backup -Destination $installDir
        }
        throw
    }

    if (-not (Test-Path -LiteralPath (Join-Path $installDir "start.js"))) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $installDir }
        throw "The installed tree is missing start.js."
    }

    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally {
    # If the script died after moving the previous installation aside but
    # before the new one was in place, put it back.
    if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $installDir)) {
        Move-Item -LiteralPath $backup -Destination $installDir -ErrorAction SilentlyContinue
    }
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "Installed SMP $version to $installDir" -ForegroundColor Green
Write-Host ('Run the panel with: bun run "{0}\start.js"' -f $installDir) -ForegroundColor Green