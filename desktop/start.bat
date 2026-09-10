@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title DeepSeek Harness

echo ============================================
echo   DeepSeek Harness Launcher
echo ============================================
echo.

rem ---- Node.js check ----
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo         Install Node.js 20+ from https://nodejs.org/ and retry.
    exit /b 1
)

rem ---- first run: install npm deps ----
if not exist "node_modules\electron" (
    echo Installing dependencies, first run only...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Check the network and retry.
        exit /b 1
    )
    echo.
)

rem ---- first run: download Electron runtime (~150MB) ----
if not exist "node_modules\electron\dist\electron.exe" (
    echo Downloading Electron runtime, ~150MB, first run only...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call node node_modules\electron\install.js
    if errorlevel 1 (
        echo.
        echo npmmirror failed, retrying with default source...
        set "ELECTRON_MIRROR="
        call node node_modules\electron\install.js
        if errorlevel 1 (
            echo.
            echo [ERROR] Electron runtime download failed.
            echo         Run manually:
            echo           set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
            echo           node node_modules\electron\install.js
            exit /b 1
        )
    )
    echo.
)

rem ---- launch ----
call npm start
if errorlevel 1 (
    echo.
    echo [ERROR] Launch failed. Make sure DSH CLI is installed:
    echo          npm install -g @deepseek-ai/dsh
    exit /b 1
)

endlocal
