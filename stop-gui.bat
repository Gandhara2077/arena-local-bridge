@echo off
setlocal
set "LAUNCHER=%~dp0ArenaLocalBridge.exe"
if not exist "%LAUNCHER%" set "LAUNCHER=%~dp0dist\ArenaLocalBridge.exe"
if not exist "%LAUNCHER%" (
  echo No launcher has been built for this folder. Nothing was stopped.
  exit /b 0
)
"%LAUNCHER%" --root "%~dp0." --stop %*
