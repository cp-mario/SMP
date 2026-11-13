<#
.SYNOPSIS
    SMP Installer (Windows)
.DESCRIPTION
    Installs Bun (official installer) if missing, asks for the release channel,
    downloads the source from GitHub and installs it into %LOCALAPPDATA%\SMP.
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

# --- Resolve the latest release of the channel (Atom feed / latest page, no API) ---
if ($channel -eq "experimental") {
    $atom = (Invoke-WebRequest "https://github.com/cp-mario/SMP/releases.atom" -UseBasicParsing).Content
    $entry = [regex]::Match($atom, "(?s)<entry>.*?</entry>").Value
    $tag = [regex]::Match($entry, "<title>([^<]+)</title>").Groups[1].Value.Trim()
} else {
    $page = (Invoke-WebRequest "https://github.com/cp-mario/SMP/releases/latest" -UseBasicParsing).Content
    $tag = [regex]::Match($page, "<title>[^<]*?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[^<]*</title>").Groups[1].Value
}
if (-not $tag) { throw "Could not resolve the latest $channel release from GitHub." }
$version = $tag -replace '^v', ''
Write-Host "Downloading SMP $tag (source)..." -ForegroundColor Cyan

# --- Download and unpack the source ---
$installDir = Join-Path $env:LOCALAPPDATA "SMP"

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

Write-Host ""
Write-Host "Installed SMP $version to $installDir" -ForegroundColor Green
Write-Host "Run the panel with: bun run ${installDir}\start.js\ (if it doesn't work, run it on a new terminal)" -ForegroundColor Green