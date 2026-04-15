<#
  WiFi Zone OS V3 — Windows Installer
  Run as Administrator in PowerShell:
    Set-ExecutionPolicy Bypass -Scope Process -Force
    .\scripts\install.ps1
#>

param()
$ErrorActionPreference = "Stop"

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
if (-not (Test-Path "db")) { New-Item -ItemType Directory -Path "db" | Out-Null }

# ── 4. Initialise database ───────────────────────────────────────────────────
Write-Host ""
Write-Host "🗄️  Initialising database..." -ForegroundColor Yellow
node -e @"
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const fs      = require('fs');
const schema  = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
const db      = new sqlite3.Database(path.join(__dirname, 'db', 'wifi.db'));
db.exec(schema, (err) => {
  if (err) { console.error('Schema error:', err.message); process.exit(1); }
  console.log('DB initialised.');
  db.close();
});
"@
if ($LASTEXITCODE -ne 0) { Write-Error "Database initialisation failed." }
Write-Host "✅ Database ready" -ForegroundColor Green

# ── 5. Summary ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   Installation complete!                          " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "👉 Start the system with:" -ForegroundColor White
Write-Host "     .\scripts\start.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "🌐 Admin panel will be at: http://localhost:3000/login.html" -ForegroundColor White
Write-Host "🔑 Default credentials:  admin / admin123  (change on first login)" -ForegroundColor White
Write-Host ""
