<#
.SYNOPSIS
  dsh-setup: device-agnostic one-shot installer (Windows).

.DESCRIPTION
  Reproduces the author's DeepSeek Harness desktop environment on a fresh machine:
    * dsh-browser  : bridge plugin + Chrome/Firefox MV3 extension (builds it)
    * profiles/web : the 'web' profile (all plugin bundles + local whale-widget
                     + browser bridge), linked by RELATIVE paths so it is portable.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipDshInstall
#>
[CmdletBinding()]
param(
    [switch]$SkipDshInstall,
    [switch]$SkipBuild,
    [string]$DshHome = $env:DSH_HOME
)

$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Step([int]$n, [string]$msg) { Write-Host "`n[$n/6] $msg" -ForegroundColor Cyan }
function Exec([string]$label, [string]$cmd) {
    Write-Host "   > $label" -ForegroundColor DarkGray
    Invoke-Expression $cmd
    if ($LASTEXITCODE -ne 0) { throw "FAILED: $label" }
}

Write-Host "dsh-setup portable installer" -ForegroundColor Green
Write-Host "  Repo    : $RepoRoot"
Write-Host "  DSH_HOME: $DshHome"
Write-Host "  SkipDshInstall: $SkipDshInstall   SkipBuild: $SkipBuild"

# [1/6] prerequisites ----------------------------------------------------
Step 1 'Prerequisites: node / git / pnpm'
foreach ($t in @(@('node', 'node'), @('git', 'git'), @('npm', 'npm'))) {
    if (-not (Get-Command $t[1] -ErrorAction SilentlyContinue)) {
        throw "Missing prerequisite '$($t[0])' ($($t[1])). Install it first, then re-run."
    }
}
if (-not (Get-Command 'pnpm' -ErrorAction SilentlyContinue)) {
    Write-Host '   > pnpm not found; enabling via corepack'
    Exec 'corepack enable' 'corepack enable'
    Exec 'corepack prepare pnpm@11.7.0 --activate' 'corepack prepare pnpm@11.7.0 --activate'
}

# [2/6] dsh CLI ----------------------------------------------------------
if (-not $SkipDshInstall) {
    Step 2 'dsh CLI'
    if (Get-Command 'dsh' -ErrorAction SilentlyContinue) {
        Write-Host '   > dsh already installed'
    } else {
        Write-Host '   > npm install -g @deepseek-ai/dsh'
        Exec 'npm install -g @deepseek-ai/dsh' 'npm install -g @deepseek-ai/dsh'
    }
} else {
    Step 2 'dsh CLI (skipped)'
}

# [3/6] dsh-browser workspace -------------------------------------------
Step 3 "dsh-browser workspace -> $DshHome\dsh-browser"
$bbDest = Join-Path $DshHome 'dsh-browser'
$bbSrc  = Join-Path $RepoRoot 'dsh-browser'
if (Test-Path $bbDest) {
    Write-Host "   > existing $bbDest found; moving to $bbDest.bak"
    Move-Item $bbDest "$bbDest.bak" -Force
}
Copy-Item -Recurse -Force $bbSrc $bbDest

# [4/6] build -------------------------------------------------------------
if (-not $SkipBuild) {
    Step 4 'Build dsh-browser (bridge lib/ + extension dist/)'
    Push-Location $bbDest
    try {
        Exec 'pnpm install' 'pnpm install'
        Exec 'pnpm build'   'pnpm build'
    } finally { Pop-Location }
} else {
    Step 4 'Build dsh-browser (skipped)'
}

# [5/6] web profile ------------------------------------------------------
Step 5 "web profile -> $DshHome\profiles\web"
$profDest = Join-Path $DshHome 'profiles\web'
$profSrc  = Join-Path $RepoRoot 'profiles\web'
if (Test-Path $profDest) {
    Write-Host "   > existing $profDest found; moving to $profDest.bak"
    Move-Item $profDest "$profDest.bak" -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $DshHome 'profiles') | Out-Null
Copy-Item -Recurse -Force $profSrc $profDest
Push-Location $profDest
try {
    Exec 'pnpm install (profile plugins)' 'pnpm install'
} finally { Pop-Location }

# [6/6] unpacked extension to stable load dir ---------------------------
Step 6 "Copy extension -> $DshHome\browser-extension"
$extSrc  = Join-Path $bbDest 'extensions\dsh-browser\dist'
$extDest = Join-Path $DshHome 'browser-extension'
if (Test-Path $extSrc) {
    if (Test-Path $extDest) { Remove-Item -Recurse -Force $extDest }
    Copy-Item -Recurse -Force $extSrc $extDest
    Write-Host "   > copied. Load this dir in chrome://extensions"
} else {
    Write-Host '   > extension NOT built yet. Re-run without -SkipBuild' -ForegroundColor Yellow
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host   "  1. Open chrome://extensions, enable Developer mode, 'Load unpacked':"
Write-Host ("     {0}" -f $extDest)
Write-Host   "  2. Restart dsh:  dsh web"
Write-Host   "  3. Firefox (if used): paste token from $DshHome\ext-bridge-token into extension settings"
Write-Host   "  4. Configure DEEPSEEK_API_KEY in dsh credentials (whale widget balance); optional DEEPSEEK_PLATFORM_TOKEN"
