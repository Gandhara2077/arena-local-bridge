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
set "ARENA_MCP_WORKSPACE="
if exist "%~dp0mcp-workspace.txt" (
  for /f "delims=" %%p in ('powershell -NoProfile -Command "Get-Content -LiteralPath %~dp0mcp-workspace.txt -Encoding UTF8"') do set "ARENA_MCP_WORKSPACE=%%p"
)
cd /d "%~dp0"

REM If the port is already taken, an earlier bridge is still running. `start /b`
REM below detaches node from this window, so closing the window never stopped
REM it. Left alone, the new instance would die on the port conflict while the
REM check further down still passes — reporting "up" while the process actually
REM serving is the old one, running old code.
set "STALE="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":20140" ^| findstr LISTENING') do set "STALE=%%p"
if defined STALE (
  echo Found a previous bridge still running ^(PID %STALE%^). Stopping it first...
  taskkill /F /PID %STALE% >nul 2>&1
  timeout /t 2 >nul
)

echo Starting arena-bridge GUI on http://127.0.0.1:20140/
echo Logs are written to: %DATA_DIR%\bridge.log
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
echo NOTE: the bridge keeps running in the background after this window closes.
echo To stop it, run stop-gui.bat.
echo.
echo Press any key to close this window.
pause
