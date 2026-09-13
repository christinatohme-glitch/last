@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Starting VisionBooks...
start http://localhost:3847
node --max-old-space-size=8192 server.js
