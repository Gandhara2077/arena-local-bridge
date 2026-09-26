@echo off
chcp 65001 >nul
setlocal

REM start-gui.bat launches node detached (start /b), so closing its window does
REM not stop the bridge. This is the way to actually stop it: find whatever is
REM listening on the port and end that PID.
set "PID_ON_PORT="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":20140" ^| findstr LISTENING') do set "PID_ON_PORT=%%p"

if not defined PID_ON_PORT (
  echo No bridge is listening on port 20140.
  goto END
)

echo Stopping arena-bridge ^(PID %PID_ON_PORT%^)...
taskkill /F /PID %PID_ON_PORT% >nul 2>&1
if errorlevel 1 (
  echo Failed to stop PID %PID_ON_PORT%. Run this window as administrator and retry.
) else (
  echo Stopped.
)

:END
echo.
pause
