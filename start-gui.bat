@echo off
chcp 65001 >nul
setlocal
set "NODE=node"
if defined ARENA_NODE_PATH set "NODE=%ARENA_NODE_PATH%"
set "ARENA_HEADED=1"
set "DATA_DIR=%~dp0.arena-gui"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not defined ARENA_AGENT_BRIDGE_KEY set "ARENA_AGENT_BRIDGE_KEY=local-dev-key"
set "ARENA_ARCHIVE_DIR="
if exist "%~dp0archive-dir.txt" (
  for /f "delims=" %%p in ('powershell -NoProfile -Command "Get-Content -LiteralPath %~dp0archive-dir.txt -Encoding UTF8"') do set "ARENA_ARCHIVE_DIR=%%p"
)
cd /d "%~dp0"
echo Starting arena-bridge GUI on http://127.0.0.1:20140/
echo Logs are written to: %DATA_DIR%\bridge.log
echo This window stays open while the bridge runs. Close it to stop the bridge.
echo.
start /b "" "%NODE%" "src/index.mjs" > "%DATA_DIR%\bridge.log" 2>&1
timeout /t 6 >nul
set "UP=0"
netstat -an | findstr ":20140" >nul && set "UP=200"
if "%UP%"=="200" goto BRIDGE_UP
goto BRIDGE_DOWN

:BRIDGE_UP
start "" http://127.0.0.1:20140/
echo.
echo DONE. bridge is up. If the browser did not open, visit the URL above manually.
echo Full logs: %DATA_DIR%\bridge.log
goto END

:BRIDGE_DOWN
echo.
echo BRIDGE DID NOT COME UP. Last log (%DATA_DIR%\bridge.log):
echo ----------------------------------------------------------------
if exist "%DATA_DIR%\bridge.log" (type "%DATA_DIR%\bridge.log")
echo ----------------------------------------------------------------
echo.
echo Most likely the Arena login cookie expired. Re-login in this folder:
echo   "%NODE%" bin/login.mjs --email YOU@example.com --password YOURPASSWORD

:END
echo.
echo Press any key to close this window and stop the bridge.
pause
