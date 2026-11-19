@echo off
REM Double-click to start IRBY Dental Ledger on the clinic PC (Windows 10+).
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
where node >nul 2>nul || (echo Node.js 22.13 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
start "" http://localhost:3000
node --disable-warning=ExperimentalWarning server/index.js
pause
