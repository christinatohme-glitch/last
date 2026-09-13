@echo off
title Talyfocous - Build Store Package
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-store-msix.ps1"
echo.
echo ============================================================
echo  Build finished. Log saved to: last-build-log.txt
echo  Type EXIT and press Enter to close this window.
echo ============================================================
cmd /k
