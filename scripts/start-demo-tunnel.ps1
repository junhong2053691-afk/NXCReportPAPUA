$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Get-Cloudflared {
  $candidates = @(
    "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe"
  )
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "cloudflared not found. Install Cloudflare Tunnel, then retry."
}

function Test-PortOpen([int]$Port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

$infoJson = node (Join-Path $Root "scripts\ensure-demo-config.js")
$info = $infoJson | ConvertFrom-Json
$port = [int]$info.port

if (-not (Test-PortOpen $port)) {
  Write-Host "Starting demo server on port $port ..."
  $startDemo = Join-Path $Root "scripts\start-demo.ps1"
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startDemo
  ) | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-PortOpen $port)) {
    if ((Get-Date) -gt $deadline) {
      throw "Demo server did not start on port $port"
    }
    Start-Sleep -Milliseconds 400
  }
}

$cf = Get-Cloudflared
$env:TUNNEL_EDGE_IP_VERSION = "4"

Write-Host ""
Write-Host "Demo login"
Write-Host "  username: $($info.username)"
Write-Host "  password: $($info.password)"
Write-Host "  company:  demo"
Write-Host ""
Write-Host "Quick Tunnel URL will appear below (changes every restart)."
Write-Host "For a stable hostname (needs a Cloudflare domain):"
Write-Host "  cloudflared tunnel login"
Write-Host "  cloudflared tunnel create trader-demo"
Write-Host "  cloudflared tunnel route dns trader-demo demo.your-domain"
Write-Host "  cloudflared tunnel run trader-demo"
Write-Host ""

& $cf tunnel --url "http://localhost:$port" --edge-ip-version 4
