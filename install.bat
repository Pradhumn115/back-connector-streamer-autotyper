@echo off
rem Beamdesk one-click installer - Windows.
rem
rem Double-click this file. It relaunches itself as Administrator, installs
rem Node.js if it's missing or too old, then installs deps, prerequisites
rem (ffmpeg, cloudflared, VB-Cable), builds, and opens the launcher menu.
rem
rem Admin rights are needed because the audio-loopback driver (VB-Cable) and
rem Chocolatey both refuse to install without them.
rem
rem Flags:  --yes  answer every consent prompt with "yes"
rem         --no-launch  stop after building
setlocal EnableExtensions EnableDelayedExpansion
title Beamdesk installer

set "NODE_MIN_MAJOR=20"
set "ARGS=%*"

rem ---------------------------------------------------------------- elevate
rem "net session" is the standard admin probe: it fails for a non-elevated
rem process. If we aren't elevated, re-launch through PowerShell's RunAs verb
rem (the UAC prompt) and let this instance exit.
net session >nul 2>&1
if not errorlevel 1 goto :elevated

echo Beamdesk needs Administrator rights to install its prerequisites.
echo Approve the Windows prompt that is about to appear...
rem -ArgumentList rejects an empty string, which is exactly the double-click
rem case, so only pass it through when there are actually arguments.
if defined ARGS (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%ARGS%' -Verb RunAs"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
)
if errorlevel 1 (
  echo.
  echo Elevation was cancelled or failed. Right-click install.bat and pick
  echo "Run as administrator" to try again.
  pause
)
exit /b

:elevated
rem An elevated process starts in C:\Windows\system32, so go back to the repo.
cd /d "%~dp0"

set "ASSUME_YES="
set "LAUNCH=1"
for %%a in (%ARGS%) do (
  if /i "%%~a"=="--yes" set "ASSUME_YES=1"
  if /i "%%~a"=="-y" set "ASSUME_YES=1"
  if /i "%%~a"=="--no-launch" set "LAUNCH="
)

echo.
echo === Beamdesk installer =========================================
echo Repo: %CD%
echo.

rem ------------------------------------------------------------ node check
echo [1/4] Checking Node.js...
call :node_major
if defined NODE_MAJOR (
  if !NODE_MAJOR! GEQ %NODE_MIN_MAJOR% (
    for /f "delims=" %%v in ('node -v') do echo   OK - Node %%v already installed
    goto :node_ready
  )
  for /f "delims=" %%v in ('node -v') do echo   Node %%v is older than the required v%NODE_MIN_MAJOR%.
) else (
  echo   Node.js isn't installed.
)

rem winget ships with Windows 10 1809+ / 11 and is the least surprising way to
rem get an official Node build; the MSI download below covers older machines
rem and images where App Installer is missing.
where winget >nul 2>&1
if not errorlevel 1 (
  echo   Installing Node.js LTS via winget...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  call :refresh_path
  call :node_major
  if defined NODE_MAJOR if !NODE_MAJOR! GEQ %NODE_MIN_MAJOR% goto :node_installed
)

echo   Falling back to the official Node.js MSI installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node-windows.ps1"
if errorlevel 1 (
  echo.
  echo   Couldn't install Node.js automatically.
  echo   Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
call :refresh_path
call :node_major
if not defined NODE_MAJOR goto :node_failed
if !NODE_MAJOR! LSS %NODE_MIN_MAJOR% goto :node_failed

:node_installed
for /f "delims=" %%v in ('node -v') do echo   OK - Node %%v installed

:node_ready
where npm >nul 2>&1
if errorlevel 1 (
  echo   npm is missing even though node is installed - reinstall Node from https://nodejs.org
  pause
  exit /b 1
)

rem --------------------------------------------------------------- install
echo.
echo [2/4] Installing workspace dependencies (npm install)...
call npm install
if errorlevel 1 (
  echo   npm install failed.
  pause
  exit /b 1
)

echo.
echo [3/4] Installing prerequisites (ffmpeg, cloudflared, VB-Cable)...
if defined ASSUME_YES (
  call npm run setup -- --yes
) else (
  call npm run setup
)
if errorlevel 1 echo   Some prerequisites didn't install - beamdesk still runs; see the notes above.

echo.
echo [4/4] Building (shared, agent, client)...
call npm run build
if errorlevel 1 (
  echo   Build failed.
  pause
  exit /b 1
)

echo.
echo === Beamdesk is installed ======================================
echo Run it any time with:  npm start
echo.
if not defined LAUNCH (
  pause
  exit /b 0
)
if defined ASSUME_YES goto :launch
set "REPLY=y"
set /p "REPLY=Open the beamdesk launcher now? [Y/n] "
if /i "!REPLY!"=="n" (
  pause
  exit /b 0
)

:launch
call npm start
pause
exit /b 0

:node_failed
echo.
echo   Node.js still isn't on PATH after installing.
echo   Close this window, open a new one, and run install.bat again.
pause
exit /b 1

rem ------------------------------------------------------------- functions
rem Major version of the node on PATH, or undefined when there is no node.
:node_major
set "NODE_MAJOR="
where node >nul 2>&1 || goto :eof
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
goto :eof

rem A just-installed Node isn't on this already-running process's PATH, so pull
rem the machine + user PATH back out of the registry and add the default install
rem directory for good measure.
:refresh_path
for /f "tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| find "REG_"') do set "MACHINE_PATH=%%b"
for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul ^| find "REG_"') do set "USER_PATH=%%b"
set "PATH=%ProgramFiles%\nodejs;%MACHINE_PATH%;%USER_PATH%;%PATH%"
goto :eof
