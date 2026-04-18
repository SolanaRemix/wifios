<#
  WiFi Zone OS V3 — Start Script
  Run as Administrator (required for firewall + DNS on port 53):
    .\scripts\start.ps1
#>

param()
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

# ── Administrator privilege check ─────────────────────────────────────────────
$currentIdentity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ""
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Administrator privileges are required for DNS on port 53 and firewall operations." -ForegroundColor Red
    Write-Host "Please restart PowerShell as Administrator and run .\scripts\start.ps1 again." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   WiFi Zone OS V3 — Starting...                  " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

$processes = @()

try {
    # ── Main server (HTTP API + static files) ────────────────────────────────────
    Write-Host "🔥 Starting main server (port 3000)..." -ForegroundColor Yellow
    $server = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $Root "backend\server.js") `
        -WorkingDirectory $Root `
        -PassThru -NoNewWindow
    $processes += $server

    # ── DNS captive-portal server ────────────────────────────────────────────────
    Write-Host "🌐 Starting DNS server (port 53)..." -ForegroundColor Yellow
    $dns = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $Root "backend\dns-server.js") `
        -WorkingDirectory $Root `
        -PassThru -NoNewWindow
    $processes += $dns

    # ── Session scheduler ─────────────────────────────────────────────────────────
    Write-Host "⏱  Starting session scheduler..." -ForegroundColor Yellow
    $scheduler = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $Root "backend\scheduler.js") `
        -WorkingDirectory $Root `
        -PassThru -NoNewWindow
    $processes += $scheduler

    # ── MAC engine ────────────────────────────────────────────────────────────────
    Write-Host "📡 Starting MAC engine..." -ForegroundColor Yellow
    $macEngine = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $Root "backend\mac-engine.js") `
        -WorkingDirectory $Root `
        -PassThru -NoNewWindow
    $processes += $macEngine

    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host "   ✅ WiFi Zone OS V3 is running!                 " -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "🌐 Admin Login:  http://localhost:3000/login.html" -ForegroundColor White
    Write-Host "📶 User Portal:  http://localhost:3000/portal.html" -ForegroundColor White
    Write-Host ""
    Write-Host "Process IDs:" -ForegroundColor Gray
    Write-Host "  Server     PID: $($server.Id)"    -ForegroundColor Gray
    Write-Host "  DNS        PID: $($dns.Id)"       -ForegroundColor Gray
    Write-Host "  Scheduler  PID: $($scheduler.Id)" -ForegroundColor Gray
    Write-Host "  MAC Engine PID: $($macEngine.Id)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press Ctrl+C or close this window to stop all services." -ForegroundColor Gray

    # Wait for all child processes — script blocks until every service exits
    Wait-Process -Id ($processes | ForEach-Object { $_.Id }) -ErrorAction SilentlyContinue
}
finally {
    # Always stop every child process, whether this block exits normally,
    # via Ctrl+C, an unhandled error, or the console window closing.
    foreach ($proc in $processes) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    Write-Host "🛑 All WiFi Zone OS services stopped." -ForegroundColor Red
}
