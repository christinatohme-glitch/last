@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

set "SYS32=%SystemRoot%\System32"
set "CURL=%SYS32%\curl.exe"
set "PING=%SYS32%\ping.exe"

rem Packaged desktop app (Microsoft Store / installer build)
if exist "%APP_DIR%\dist\win-unpacked\Talyfocous.exe" (
    start "" "%APP_DIR%\dist\win-unpacked\Talyfocous.exe"
    exit /b 0
)

rem Find Node.js — desktop shortcuts may start with a minimal PATH
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\node\node.exe"

if not defined NODE_EXE (
    echo.
    echo Talyfocous could not find Node.js.
    echo Install it from https://nodejs.org/ then try again.
    echo.
    pause
    exit /b 1
)

if not exist "%APP_DIR%\node_modules" (
    echo Installing required files, please wait...
    if exist "%ProgramFiles%\nodejs\npm.cmd" (
        call "%ProgramFiles%\nodejs\npm.cmd" install --prefix "%APP_DIR%"
    ) else (
        echo npm was not found. Reinstall Node.js from https://nodejs.org/
        pause
        exit /b 1
    )
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

rem If server is already running, open the app
if exist "%CURL%" (
    "%CURL%" -fsS "http://localhost:3847/api/health" >nul 2>nul
    if not errorlevel 1 (
        start "" "http://localhost:3847"
        exit /b 0
    )
)

rem Start server in background
start "Talyfocous Server" /min "%NODE_EXE%" --max-old-space-size=8192 "%APP_DIR%\server.js"

rem Wait until server responds (up to 40 seconds)
for /L %%I in (1,1,40) do (
    if exist "%PING%" "%PING%" 127.0.0.1 -n 2 >nul
    if exist "%CURL%" (
        "%CURL%" -fsS "http://localhost:3847/api/health" >nul 2>nul
        if not errorlevel 1 goto :open_browser
    ) else (
        if %%I GEQ 5 goto :open_browser
    )
)

echo.
echo Talyfocous could not start the server.
echo Close any old Talyfocous window and try again.
echo.
pause
exit /b 1

:open_browser
start "" "http://localhost:3847"
exit /b 0
