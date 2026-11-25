@echo off
cd /d "C:\Users\hp\Desktop\trading"
if not exist "%TEMP%\opencode" mkdir "%TEMP%\opencode" >nul 2>&1
echo === %DATE% %TIME% >> "%TEMP%\opencode\shadow-worker.log"
node "C:\Users\hp\Desktop\trading\.shadow-build\scripts\shadow_cli.js" cycle >> "%TEMP%\opencode\shadow-worker.log" 2>&1
