<#
  WiFi Zone OS V3 — Windows Installer
  Run as Administrator in PowerShell:
    Set-ExecutionPolicy Bypass -Scope Process -Force
    .\scripts\install.ps1
#>

param()
$ErrorActionPreference = "Stop"

# ── Resolve & change to the project root ─────────────────────────────────────
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   WiFi Zone OS V3 — Installer                    " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check / Install Node.js ────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "📦 Installing Node.js via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS -e --accept-source-agreements --accept-package-agreements
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
} else {
    $nodeVer = node --version
    Write-Host "✅ Node.js already installed: $nodeVer" -ForegroundColor Green
}

# ── 2. Install npm dependencies ───────────────────────────────────────────────
Write-Host ""
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed." }
Write-Host "✅ Dependencies installed" -ForegroundColor Green

# ── 3. Create db directory if missing ────────────────────────────────────────
if (-not (Test-Path (Join-Path $Root "db"))) {
    New-Item -ItemType Directory -Path (Join-Path $Root "db") | Out-Null
}

# ── 4. Initialise database ───────────────────────────────────────────────────
Write-Host ""
Write-Host "🗄️  Initialising database..." -ForegroundColor Yellow
# Use npm run init-db — it resolves its own paths relative to the project root
node scripts/init-db.js
if ($LASTEXITCODE -ne 0) { Write-Error "Database initialisation failed." }
Write-Host "✅ Database ready" -ForegroundColor Green

# ── 5. Register auto-start task (optional, requires Admin) ───────────────────
Write-Host ""
$answer = Read-Host "📋 Register WiFi Zone OS to auto-start on logon? (y/N)"
if ($answer -match '^[Yy]$') {
    $startScript = Join-Path $Root "scripts\start.ps1"
    $taskCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
    schtasks /create /tn "WiFiZoneOS" /tr $taskCmd /sc onlogon /rl HIGHEST /f 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Auto-start task registered (Task: WiFiZoneOS)" -ForegroundColor Green
        Write-Host "   To remove:  schtasks /delete /tn WiFiZoneOS /f" -ForegroundColor Gray
    } else {
        Write-Host "⚠️  schtasks registration failed — run as Administrator to register auto-start." -ForegroundColor Yellow
    }
} else {
    Write-Host "ℹ️  Skipped auto-start registration." -ForegroundColor Gray
    Write-Host "   To register later:  schtasks /create /tn WiFiZoneOS /tr ""powershell -File scripts\start.ps1"" /sc onlogon /rl HIGHEST /f" -ForegroundColor Gray
}

# ── 6. Summary ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   Installation complete!                          " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "👉 Start the system with:" -ForegroundColor White
Write-Host "     .\scripts\start.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "🌐 Admin panel will be at: http://localhost:3000/login.html" -ForegroundColor White
Write-Host "🔑 On first setup, use the temporary admin password printed during database initialisation above (init-db output), then change it after logging in." -ForegroundColor Yellow
Write-Host ""
