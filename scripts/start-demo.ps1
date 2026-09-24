$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$infoJson = node (Join-Path $Root "scripts\ensure-demo-config.js")
$info = $infoJson | ConvertFrom-Json

$env:TRADER_CONFIG = Join-Path $Root "config.demo.json"
$env:TRADER_DB = Join-Path $Root "server\db\trader-demo.db"
$env:TRADER_STATE_DIR = Join-Path $Root "demo-state"
New-Item -ItemType Directory -Force -Path $env:TRADER_STATE_DIR | Out-Null

Write-Host ""
Write-Host "Demo trader dashboard"
Write-Host "  URL:      http://localhost:$($info.port)"
Write-Host "  username: $($info.username)"
Write-Host "  password: $($info.password)"
Write-Host "  company:  demo (empty, no platform API)"
Write-Host "  db:       $($env:TRADER_DB)"
Write-Host ""

node (Join-Path $Root "server\index.js")
