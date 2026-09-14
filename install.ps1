<#
.SYNOPSIS
  dsh-sunflower: 新机器上一键复现完整 DSH 环境（Windows）。

.DESCRIPTION
  把仓库里的四块东西放到 $DSH_HOME 下的正确位置，让 profiles/web 的相对链接全部成立：

    $DSH_HOME/
    ├─ dsh-browser/            浏览器桥插件 + Chrome/Firefox MV3 扩展（本脚本会 pnpm build）
    ├─ plugins/                四个本地插件（persona / tts-voice / im-readonly / whale-autostart）
    └─ profiles/web/           web 配置档：插件清单 + cordis.patch.yml + 本地鲸鱼挂件

  为什么必须镜像这种布局：profiles/web/package.json 里用 link:../../plugins/xxx 与
  link:../../dsh-browser/... 引用同级目录，只有三者同级时相对路径才成立。

.PARAMETER SkipDshInstall
  跳过全局安装 @deepseek-ai/dsh（你已经装过时用）。

.PARAMETER SkipBuild
  跳过 pnpm 构建（不推荐，除非你确定 dsh-browser 已构建过）。

.PARAMETER DshHome
  DSH 主目录，默认取环境变量 DSH_HOME，再默认 %USERPROFILE%\.dsh。

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
$RepoRoot = $PSScriptRoot

function Step([int]$n, [int]$total, [string]$msg) { Write-Host "`n[$n/$total] $msg" -ForegroundColor Cyan }
function Exec([string]$label, [string]$cmd) {
    Write-Host "   > $label" -ForegroundColor DarkGray
    # 2>&1：pnpm / vite 会把横幅写进 stderr，而 $ErrorActionPreference='Stop' 下
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
Write-Host "  SkipDshInstall: $SkipDshInstall   SkipBuild: $SkipBuild"

# [1/6] 前置工具 ----------------------------------------------------------
Step 1 6 '前置检查：node / git / npm'
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

# [2/6] dsh CLI ----------------------------------------------------------
if (-not $SkipDshInstall) {
    Step 2 6 'dsh CLI'
    if (Get-Command 'dsh' -ErrorAction SilentlyContinue) {
        Write-Host '   > 已安装，跳过'
    } else {
        Exec 'npm install -g @deepseek-ai/dsh' 'npm install -g @deepseek-ai/dsh'
    }
} else {
    Step 2 6 'dsh CLI（已跳过）'
}

# [3/6] 放置三块目录 ------------------------------------------------------
Step 3 6 "放置目录 -> $DshHome"

$bbDest   = Join-Path $DshHome 'dsh-browser'
$plugDest = Join-Path $DshHome 'plugins'
$profDest = Join-Path $DshHome 'profiles\web'

Place (Join-Path $RepoRoot 'dsh-browser') $bbDest
Write-Host "   > dsh-browser  -> $bbDest"

Place (Join-Path $RepoRoot 'plugins') $plugDest
Write-Host "   > plugins      -> $plugDest  (4 个本地插件)"

Place (Join-Path $RepoRoot 'profiles\web') $profDest
Write-Host "   > profiles/web -> $profDest"

# [4/6] 构建 dsh-browser --------------------------------------------------
if (-not $SkipBuild) {
    Step 4 6 '构建 dsh-browser（bridge lib/ + extension dist/）'
    Push-Location $bbDest
    try {
        Exec 'pnpm install' 'pnpm install'
        Exec 'pnpm build'   'pnpm build'
    } finally { Pop-Location }
} else {
    Step 4 6 '构建 dsh-browser（已跳过）'
}

# [5/6] 安装 profile 依赖 ------------------------------------------------
Step 5 6 '安装 web profile 依赖（含四个 link: 本地插件）'
Push-Location $profDest
try {
    Exec 'pnpm install' 'pnpm install'
} finally { Pop-Location }

# [6/6] 扩展解压目录 -----------------------------------------------------
Step 6 6 "复制扩展 -> $DshHome\browser-extension"
$extSrc  = Join-Path $bbDest 'extensions\dsh-browser\dist'
$extDest = Join-Path $DshHome 'browser-extension'
if (Test-Path $extSrc) {
    if (Test-Path $extDest) { Remove-Item -Recurse -Force $extDest }
    Copy-Item -Recurse -Force $extSrc $extDest
    Write-Host '   > 已复制'
} else {
    Write-Host '   > 扩展尚未构建，请去掉 -SkipBuild 重跑' -ForegroundColor Yellow
}

# 收尾 -------------------------------------------------------------------
Write-Host "`n安装完成。接下来：" -ForegroundColor Green
Write-Host '  1. 浏览器加载扩展：chrome://extensions -> 打开「开发者模式」->「加载已解压的扩展程序」'
Write-Host "     选择：$extDest"
Write-Host '  2. 重启 dsh：dsh web'
Write-Host '  3. Firefox（若使用）：把下面的 token 填进扩展设置'
Write-Host "     $DshHome\ext-bridge-token"
Write-Host '  4. 配置凭据：DEEPSEEK_API_KEY（鲸鱼挂件余额必需）'
Write-Host '  5. 桌面端：双击 desktop\start.bat'
Write-Host ''
Write-Host '注意：agent/ 与 qq-bot/ 不在本脚本范围内，且其中的脚本含尖括号占位符，' -ForegroundColor DarkYellow
Write-Host '      使用前必须按 README 的「占位符替换清单」改成你自己的路径。' -ForegroundColor DarkYellow
