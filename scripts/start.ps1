<#
  WiFi Zone OS V3 — Start Script
  Run as Administrator (required for firewall + DNS on port 53):
    .\scripts\start.ps1
#>

param()
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   WiFi Zone OS V3 — Starting...                  " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

# ── Main server (HTTP API + static files) ────────────────────────────────────
Write-Host "🔥 Starting main server (port 3000)..." -ForegroundColor Yellow
$server = Start-Process -FilePath "node" `
    -ArgumentList (Join-Path $Root "backend\server.js") `
    -WorkingDirectory $Root `
    -PassThru -NoNewWindow

# ── DNS captive-portal server ────────────────────────────────────────────────
Write-Host "🌐 Starting DNS server (port 53)..." -ForegroundColor Yellow
$dns = Start-Process -FilePath "node" `
    -ArgumentList (Join-Path $Root "backend\dns-server.js") `
    -WorkingDirectory $Root `
    -PassThru -NoNewWindow

# ── Session scheduler ─────────────────────────────────────────────────────────
Write-Host "⏱  Starting session scheduler..." -ForegroundColor Yellow
$scheduler = Start-Process -FilePath "node" `
    -ArgumentList (Join-Path $Root "backend\scheduler.js") `
    -WorkingDirectory $Root `
    -PassThru -NoNewWindow

# ── MAC engine ────────────────────────────────────────────────────────────────
Write-Host "📡 Starting MAC engine..." -ForegroundColor Yellow
$macEngine = Start-Process -FilePath "node" `
    -ArgumentList (Join-Path $Root "backend\mac-engine.js") `
    -WorkingDirectory $Root `
    -PassThru -NoNewWindow

Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host "   ✅ WiFi Zone OS V3 is running!                 " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 Admin Login:  http://localhost:3000/login.html" -ForegroundColor White
Write-Host "📶 User Portal:  http://localhost:3000/portal.html" -ForegroundColor White
Write-Host ""
Write-Host "Process IDs:" -ForegroundColor Gray
Write-Host "  Server    PID: $($server.Id)"    -ForegroundColor Gray
Write-Host "  DNS       PID: $($dns.Id)"       -ForegroundColor Gray
Write-Host "  Scheduler PID: $($scheduler.Id)" -ForegroundColor Gray
Write-Host "  MAC Engine PID: $($macEngine.Id)" -ForegroundColor Gray
Write-Host ""
Write-Host ""
Write-Host "Press Ctrl+C or close this window to stop all services." -ForegroundColor Gray

# Register a clean-up handler so Ctrl+C kills child processes
$null = Register-EngineEvent PowerShell.Exiting -Action {
    foreach ($pid in @($server.Id, $dns.Id, $scheduler.Id, $macEngine.Id)) {
        try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch {}
    }
    Write-Host "🛑 All WiFi Zone OS services stopped." -ForegroundColor Red
}

# Wait until the main server exits; if it does, stop the others too
Wait-Process -Id $server.Id -ErrorAction SilentlyContinue
foreach ($proc in @($dns, $scheduler, $macEngine)) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
}
Write-Host "🛑 Server exited — all child services stopped." -ForegroundColor Red
