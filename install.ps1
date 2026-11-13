<#
.SYNOPSIS
    SMP Installer (Windows)
.DESCRIPTION
    Installs Bun (official installer) if missing, asks for the release channel,
    downloads the source from GitHub and installs it into C:\Program Files\smp.
#>
$ErrorActionPreference = "Stop"

Write-Host "SMP Installer (Windows)" -ForegroundColor Green

# --- Bun (official installer, only when missing) ---
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Bun..." -ForegroundColor Cyan
    powershell -c "irm bun.sh/install.ps1|iex"
    $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
    $env:PATH = "$bunBin;$env:PATH"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "Bun installation failed." }
}

# --- Release channel ---
Write-Host "Choose the release channel:" -ForegroundColor Cyan
Write-Host "  1) Stable (recommended)"
Write-Host "  2) Experimental (pre-releases included)"
$answer = (Read-Host "Channel [1/stable, default 1]").Trim().ToLowerInvariant()
$channel = if ($answer -in @("2", "experimental", "exp", "beta", "pre")) { "experimental" } else { "stable" }
Write-Host "Channel: $channel"

# --- Resolve the latest release of the channel ---
$repoApi = "https://api.github.com/repos/cp-mario/SMP"
try {
    if ($channel -eq "experimental") {
        $release = Invoke-RestMethod "$repoApi/releases?per_page=30" | Where-Object { -not $_.draft } | Select-Object -First 1
    } else {
        $release = Invoke-RestMethod "$repoApi/releases/latest"
    }
} catch {
    throw "Could not resolve the latest $channel release from GitHub: $($_.Exception.Message)"
}
if (-not $release -or -not $release.tag_name) { throw "No $channel release published yet." }
$tag = $release.tag_name
$version = $tag -replace '^v', ''
Write-Host "Downloading SMP $tag (source)..." -ForegroundColor Cyan

# --- Download and unpack the source ---
$installDir = "C:\Program Files\smp"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "This installer writes to `"$installDir`". Run PowerShell as Administrator." }

$tmp = Join-Path $env:TEMP "smp-install"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "smp.zip"
Invoke-WebRequest "https://github.com/cp-mario/SMP/archive/refs/tags/$tag.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force
if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$src = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "SMP-*" } | Select-Object -First 1
if (-not $src) { throw "Unexpected archive layout: no SMP-<version> folder inside the zip." }
Copy-Item "$($src.FullName)\*" -Destination $installDir -Recurse -Force
Remove-Item -Recurse -Force $tmp

# --- Dependencies and panel build ---
Write-Host "Installing dependencies (server)..." -ForegroundColor Cyan
Push-Location "$installDir\server"
bun install
Pop-Location

Write-Host "Installing dependencies (web)..." -ForegroundColor Cyan
Push-Location "$installDir\web"
bun install
Pop-Location

Write-Host "Building web panel..." -ForegroundColor Cyan
Push-Location "$installDir\web"
bun run build
Pop-Location

Write-Host ""
Write-Host "Installed SMP $version to $installDir" -ForegroundColor Green
Write-Host "Run the panel with: bun run $installDir\start.js" -ForegroundColor Green