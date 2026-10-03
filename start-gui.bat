@echo off
setlocal
set "LAUNCHER=%~dp0ArenaLocalBridge.exe"
if not exist "%LAUNCHER%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\build-launcher.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
  set "LAUNCHER=%~dp0dist\ArenaLocalBridge.exe"
)
start "" "%LAUNCHER%" --root "%~dp0." %*
