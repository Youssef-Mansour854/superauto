@echo off
setlocal
echo ===================================================
echo     Running Scalping Backtest (5m Engine)
echo ===================================================

set ELECTRON_RUN_AS_NODE=1
set NODE_PATH=%~dp0node_modules

"C:\Users\hp\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" "%~dp0backtest\runner.js" %*

echo.
echo ===================================================
echo   Backtest Complete! Check backtest_results.md
echo ===================================================
pause
