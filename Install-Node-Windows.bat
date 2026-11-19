@echo off
REM Double-click this file on Windows to check for Node.js, install it if missing, and start IRBY Dental Ledger.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ========================================================
echo     IRBY Dental Ledger — Windows Setup ^& Launcher
echo ========================================================
echo.

set "NODE_BIN="

if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "%USERPROFILE%\.volta\bin\node.exe" set "NODE_BIN=%USERPROFILE%\.volta\bin\node.exe"

if not defined NODE_BIN (
  for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    if not defined NODE_BIN set "NODE_BIN=%%I"
  )
)

if defined NODE_BIN (
  for /f "delims=" %%V in ('"%NODE_BIN%" -v 2^>nul') do set "NODE_VER=%%V"
  echo [OK] Node.js is already installed (!NODE_VER! at "!NODE_BIN!")
  echo.
  echo Starting IRBY Dental Ledger...
  if exist "%~dp0IRBY Dental Ledger.exe" (
    start "" "%~dp0IRBY Dental Ledger.exe"
  ) else (
    call "%~dp0start-desktop-pc.bat"
  )
  exit /b 0
)

echo Node.js is not yet installed on this Windows PC.
echo IRBY Dental Ledger requires Node.js ^(v22 LTS^) for its database and server.
echo.
echo Downloading the official Windows installer ^(.msi^) from nodejs.org...

set "TMP_MSI=%TEMP%\node-v22-lts-x64.msi"
set "MSI_URL=https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"

curl.exe -L -# -o "%TMP_MSI%" "%MSI_URL%"

if errorlevel 1 (
  echo.
  echo Direct download failed. Opening nodejs.org in your browser...
  start "" "https://nodejs.org/en/download"
  echo Please run the installer downloaded in your browser, then re-open IRBY Dental Ledger.
  pause
  exit /b 1
)

if not exist "%TMP_MSI%" (
  echo.
  echo Direct download failed. Opening nodejs.org in your browser...
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

echo.
echo Launching Windows installer wizard...
echo Please click 'Next' and follow the prompts to complete the installation.
msiexec.exe /i "%TMP_MSI%"

if exist "%TMP_MSI%" del /f /q "%TMP_MSI%" >nul 2>nul

if exist "%ProgramFiles%\nodejs\node.exe" (
  echo.
  echo [OK] Node.js successfully installed!
  echo.
  echo Starting IRBY Dental Ledger...
  if exist "%~dp0IRBY Dental Ledger.exe" (
    start "" "%~dp0IRBY Dental Ledger.exe"
  ) else (
    call "%~dp0start-desktop-pc.bat"
  )
  exit /b 0
)

echo.
echo If installation finished in a custom directory, please re-open IRBY Dental Ledger.exe.
pause
exit /b 0
