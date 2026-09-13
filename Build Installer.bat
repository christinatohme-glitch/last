@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Building Windows download package...
call npm run dist:installer
echo.
echo Done. Check the dist folder for the installer.
pause
