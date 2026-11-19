@echo off
REM Double-click to open IRBY Dental Ledger as a standalone PC desktop window on Windows 10/11.
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
where node >nul 2>nul || (echo Node.js 22.13 or newer is required: https://nodejs.org & pause & exit /b 1)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)

REM Start the backend server in a minimized background window if not already listening on port 3000
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  start "IRBY Dental Ledger Server" /min cmd /c "node --disable-warning=ExperimentalWarning server/index.js"
  timeout /t 2 /nobreak >nul
)

REM Launch in borderless Desktop App window mode via Microsoft Edge or Google Chrome
where msedge >nul 2>nul
if not errorlevel 1 (
  start "" msedge --app=http://localhost:3000 --window-size=1360,860
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000 --window-size=1360,860
  exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --window-size=1360,860
  exit /b 0
)

start "" http://localhost:3000
