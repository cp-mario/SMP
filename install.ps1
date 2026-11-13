<#
.SYNOPSIS
    SMP Installer (Windows)
.DESCRIPTION
    Installs dependencies, builds the web panel, compiles smp.exe and places it on PATH.
#>
$ErrorActionPreference = "Stop"

Write-Host "SMP Installer (Windows)" -ForegroundColor Green

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ensure bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Installing Bun..." -ForegroundColor Cyan
    iwr -useb https://bun.sh/install.ps1 | iex
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}

Write-Host "Installing dependencies (server)..." -ForegroundColor Cyan
Push-Location "$root/server"
bun install
Pop-Location

Write-Host "Installing dependencies (web)..." -ForegroundColor Cyan
Push-Location "$root/web"
bun install
Pop-Location

Write-Host "Building web panel..." -ForegroundColor Cyan
Push-Location "$root/web"
bun run build
Pop-Location

Write-Host "Building smp.exe..." -ForegroundColor Cyan
Push-Location "$root/server"
bun run build
Pop-Location

$bin = "$root/server/dist/smp.exe"
$installDir = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (Test-Path $bin) {
    Copy-Item $bin -Destination "$installDir\smp.exe" -Force
    $publicSrc = "$root/server/src/public"
    $publicDst = "$installDir\public"
    if (Test-Path $publicSrc) {
        if (Test-Path $publicDst) { Remove-Item -Recurse -Force $publicDst }
        Copy-Item -Recurse $publicSrc -Destination $publicDst
    }
    Write-Host "Installed smp.exe to $installDir\smp.exe" -ForegroundColor Green
} else {
    $entry = Resolve-Path "$root/server/src/index.js" -ErrorAction SilentlyContinue
    if (-not $entry) { throw "Server entry not found: $root/server/src/index.js" }
    $wrapper = "@echo off`r`nbun run `"$entry`" %*`r`n"
    Set-Content -Path "$installDir\smp.cmd" -Value $wrapper -Encoding ASCII
    Write-Host "Installed smp.cmd wrapper" -ForegroundColor Green
}

Write-Host "Done. Run: smp start  (open http://localhost:3001)" -ForegroundColor Green