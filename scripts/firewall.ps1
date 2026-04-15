<#
  WiFi Zone OS V3 — Optional standalone firewall enforcement script.
  Apply or remove Windows Firewall rules for a specific device by hand.

  Usage (run as Administrator):
    # Block a device
    .\scripts\firewall.ps1 -Action block  -IP 192.168.1.50 -MAC "aa:bb:cc:dd:ee:ff"

    # Allow / unblock a device
    .\scripts\firewall.ps1 -Action allow  -MAC "aa:bb:cc:dd:ee:ff"

    # Remove ALL WiFi Zone OS firewall rules
    .\scripts\firewall.ps1 -Action flush
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("block", "allow", "flush")]
    [string] $Action,

    [Parameter(Mandatory = $false)]
    [string] $IP,

    [Parameter(Mandatory = $false)]
    [string] $MAC
)

$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Validate-IP ([string]$addr) {
    if ($addr -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
        throw "Invalid IP address: $addr"
    }
    foreach ($octet in $addr.Split('.')) {
        if ([int]$octet -gt 255) { throw "IP octet out of range: $addr" }
    }
}

function Validate-MAC ([string]$mac) {
    if ($mac -notmatch '^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$') {
        throw "Invalid MAC address: $mac"
    }
}

function Get-RuleName ([string]$mac) {
    $clean = $mac -replace '[:\-]', ''
    return "WIFIOS_BLOCK_$($clean.ToUpper())"
}

# ── Actions ───────────────────────────────────────────────────────────────────

switch ($Action) {

    "block" {
        if (-not $IP)  { throw "-IP is required for action 'block'" }
        if (-not $MAC) { throw "-MAC is required for action 'block'" }
        Validate-IP  $IP
        Validate-MAC $MAC
        $ruleName = Get-RuleName $MAC

        Write-Host "🚫 Blocking $IP ($MAC)..." -ForegroundColor Yellow
        # Remove stale rule first (idempotent)
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        New-NetFirewallRule `
            -DisplayName  $ruleName `
            -Direction    Outbound `
            -RemoteAddress $IP `
            -Action       Block `
            -Profile      Any `
            -Enabled      True | Out-Null
        Write-Host "✅ Rule created: $ruleName" -ForegroundColor Green
    }

    "allow" {
        if (-not $MAC) { throw "-MAC is required for action 'allow'" }
        Validate-MAC $MAC
        $ruleName = Get-RuleName $MAC

        Write-Host "✅ Allowing $MAC — removing block rule..." -ForegroundColor Green
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        Write-Host "✅ Rule removed (if it existed): $ruleName" -ForegroundColor Green
    }

    "flush" {
        Write-Host "🧹 Removing all WiFi Zone OS firewall rules..." -ForegroundColor Yellow
        $rules = Get-NetFirewallRule -DisplayName "WIFIOS_BLOCK_*" -ErrorAction SilentlyContinue
        if ($rules) {
            $rules | Remove-NetFirewallRule
            Write-Host "✅ Removed $($rules.Count) rule(s)" -ForegroundColor Green
        } else {
            Write-Host "ℹ️  No WiFi Zone OS rules found" -ForegroundColor Gray
        }
    }
}
