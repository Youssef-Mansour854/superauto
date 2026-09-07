# Scalping Strategy Backtest Runner (PowerShell)
param(
    [switch]$Refresh
)

$env:ELECTRON_RUN_AS_NODE = "1"
$env:NODE_PATH = "$PSScriptRoot\node_modules"

$argsList = @("$PSScriptRoot\backtest\runner.js")
if ($Refresh) {
    $argsList += "--refresh"
}

Write-Host ">>> Launching Backtest Engine..." -ForegroundColor Cyan
Start-Process -FilePath "C:\Users\hp\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe" -ArgumentList $argsList -Wait -NoNewWindow

if (Test-Path "$PSScriptRoot\backtest_console.txt") {
    Get-Content "$PSScriptRoot\backtest_console.txt"
}
