@echo off
cd /d "%~dp0"
echo Stopping any old Talyfocous server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lines = netstat -ano | Select-String ':3847\s+.*LISTENING'; foreach ($line in $lines) { $processId = ($line.ToString().Trim() -split '\s+')[-1]; if ($processId -match '^\d+$') { Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue } }"
timeout /t 2 /nobreak >nul
echo Starting Talyfocous from this folder...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-talyfocous.ps1"
if errorlevel 1 pause
