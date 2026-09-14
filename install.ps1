<#
.SYNOPSIS
  dsh-sunflower: 新机器上一键复现 DSH 环境（Windows）。

.DESCRIPTION
  把仓库里两块东西放到 $DSH_HOME 下的正确位置，让 profiles/web 的相对链接成立：

    $DSH_HOME/
    ├─ plugins/                三个本地插件（persona / tts-voice / im-readonly）
    └─ profiles/web/           web 配置档：插件清单 + cordis.patch.yml + 本地鲸鱼挂件

  为什么必须镜像这种布局：profiles/web/package.json 用 link:../../plugins/xxx
  引用同级目录，只有 plugins/ 与 profiles/ 同级时相对路径才成立。

  注：浏览器桥与 Chrome/Firefox 扩展（dsh-browser/）暂未随本仓库分发，
  详见 README「浏览器扩展」一节。

.PARAMETER SkipDshInstall
  跳过全局安装 @deepseek-ai/dsh（你已经装过时用）。

.PARAMETER DshHome
  DSH 主目录，默认取环境变量 DSH_HOME，再默认 %USERPROFILE%\.dsh。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipDshInstall
#>
[CmdletBinding()]
param(
    [switch]$SkipDshInstall,
    [string]$DshHome = $env:DSH_HOME
)

$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$RepoRoot = $PSScriptRoot

function Step([int]$n, [int]$total, [string]$msg) { Write-Host "`n[$n/$total] $msg" -ForegroundColor Cyan }
function Exec([string]$label, [string]$cmd) {
    Write-Host "   > $label" -ForegroundColor DarkGray
    # 2>&1：pnpm 会把横幅写进 stderr，而 $ErrorActionPreference='Stop' 下
    # PowerShell 把「原生命令写 stderr」当成终止性错误，会在命令其实成功时中断脚本。
    # 合并到 stdout 后正常继续；真正的成败仍由 $LASTEXITCODE 判定。
    Invoke-Expression "$cmd 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "FAILED: $label (exit $LASTEXITCODE)" }
}
function Place([string]$src, [string]$dest) {
    if (-not (Test-Path $src)) { throw "源目录不存在: $src" }
    if (Test-Path $dest) {
        Write-Host "   > 已存在，备份为 $dest.bak" -ForegroundColor DarkYellow
        if (Test-Path "$dest.bak") { Remove-Item "$dest.bak" -Recurse -Force }
        Move-Item $dest "$dest.bak" -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -Recurse -Force $src $dest
}

Write-Host "dsh-sunflower 安装器" -ForegroundColor Green
Write-Host "  Repo    : $RepoRoot"
Write-Host "  DSH_HOME: $DshHome"
Write-Host "  SkipDshInstall: $SkipDshInstall"

# [1/4] 前置工具 ----------------------------------------------------------
Step 1 4 '前置检查：node / git / npm'
foreach ($t in @('node', 'git', 'npm')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
        throw "缺少前置工具 '$t'，请先安装后重跑。"
    }
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "需要 Node.js 20+，当前为 $(& node -v)" }
Write-Host "   > Node $(& node -v)  OK"

if (-not (Get-Command 'pnpm' -ErrorAction SilentlyContinue)) {
    Write-Host '   > 未找到 pnpm，改用 corepack 启用' -ForegroundColor DarkYellow
    Exec 'corepack enable' 'corepack enable'
    Exec 'corepack prepare pnpm@11.7.0 --activate' 'corepack prepare pnpm@11.7.0 --activate'
} else {
    Write-Host "   > pnpm $(pnpm -v)  OK"
}

# [2/4] dsh CLI ----------------------------------------------------------
if (-not $SkipDshInstall) {
    Step 2 4 'dsh CLI'
    if (Get-Command 'dsh' -ErrorAction SilentlyContinue) {
        Write-Host '   > 已安装，跳过'
    } else {
        Exec 'npm install -g @deepseek-ai/dsh' 'npm install -g @deepseek-ai/dsh'
    }
} else {
    Step 2 4 'dsh CLI（已跳过）'
}

# [3/4] 放置目录 ----------------------------------------------------------
Step 3 4 "放置目录 -> $DshHome"

$plugDest = Join-Path $DshHome 'plugins'
$profDest = Join-Path $DshHome 'profiles\web'

Place (Join-Path $RepoRoot 'plugins') $plugDest
Write-Host "   > plugins      -> $plugDest  (3 个本地插件)"

Place (Join-Path $RepoRoot 'profiles\web') $profDest
Write-Host "   > profiles/web -> $profDest"

# [4/4] 安装 profile 依赖 ------------------------------------------------
Step 4 4 '安装 web profile 依赖（含三个 link: 本地插件）'
Push-Location $profDest
try {
    Exec 'pnpm install' 'pnpm install'
} finally { Pop-Location }

# 收尾 -------------------------------------------------------------------
Write-Host "`n安装完成。接下来：" -ForegroundColor Green
Write-Host '  1. 重启 dsh：dsh web'
Write-Host '  2. 配置凭据：DEEPSEEK_API_KEY（鲸鱼挂件余额必需）'
Write-Host '  3. 桌面端：双击 desktop\start.bat'
Write-Host ''
Write-Host '注意：agent/ 与 qq-bot/ 不在本脚本范围内，且其中的脚本含尖括号占位符，' -ForegroundColor DarkYellow
Write-Host '      使用前必须按 README 的「占位符替换清单」改成你自己的路径。' -ForegroundColor DarkYellow
