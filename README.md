# WiFi Zone OS V3

> A smart, semi-automated WiFi vending platform for Windows + Starlink.
> Works like a Piso WiFi machine — users scan a QR code, pay, and get timed access.

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Node.js 16+](https://img.shields.io/badge/Node.js-%3E%3D16-green.svg)](https://nodejs.org)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](https://www.microsoft.com/windows)

---

## Architecture

```
[ User Phone ]
     down  (QR Scan)
[ User Portal  — http://192.168.1.2:3000/portal.html ]
     down
[ WiFi Zone OS V3  (Windows PC / Mini PC) ]
  |- Express HTTP Server  (port 3000)
  |- DNS Captive Portal   (port 53)
  |- MAC Engine           (arp scan)
  +- Session Scheduler    (1 s tick)
     down
[ Windows Firewall  — block / allow per device ]
     down
[ Internet  (Starlink) ]
```

---

## Quick Start (Windows)

```powershell
# 1. Open PowerShell as Administrator
# 2. Navigate to the project folder
cd wifi-zone

# 3. Run the installer
Set-ExecutionPolicy Bypass -Scope Process -Force
.\scripts\install.ps1

# 4. Start all services
.\scripts\start.ps1
```

Admin panel: **http://localhost:3000/login.html**
On first initialization, the server generates a random 24-character temporary admin password and prints it once to the terminal. Use that password to log in (username: `admin`), then change it immediately on first login.

---

## Project Structure

```
wifi-zone/
+-backend/
| +-server.js        <- Main Express server + all API routes
| +-auth.js          <- bcrypt password helpers
| +-db.js            <- Shared SQLite connection + promise wrappers
| +-mac-engine.js    <- ARP scan -> upsert devices into DB
| +-firewall.js      <- Windows Firewall block/allow (input-validated)
| +-dns-server.js    <- DNS captive-portal redirect
| +-scheduler.js     <- 1-second session timer + auto-block on expiry
| +-payment.js       <- GCash-style pending payment + confirm
| +-voucher.js       <- Voucher code generator
| +-qr.js            <- QR code image (base64 PNG)
| +-analytics.js     <- Revenue + device stats
| +-receipt.js       <- Plain-text receipt generator
+-frontend/
| +-login.html           <- Admin login page
| +-change-password.html <- First-login password change
| +-portal.html          <- User WiFi purchase portal
+-admin-panel/
| +-dashboard.html   <- Admin dashboard (SPA)
| +-dashboard.js     <- Dashboard logic / API calls
+-db/
| +-schema.sql       <- SQLite schema
+-config/
| +-pricing.json     <- Tier pricing config
+-scripts/
| +-install.ps1      <- One-command Windows installer
| +-start.ps1        <- Start all services
+-package.json
```

---

## Features

| Feature | V2 | V3 |
|---|---|---|
| Admin login + forced password change | yes | yes |
| MAC detection (ARP scan) | yes | yes |
| Windows Firewall block/allow | yes | yes |
| DNS captive portal redirect | yes | yes |
| Session timer (per-second) | yes | yes |
| GCash-style pending payments | no | yes |
| Voucher system | no | yes |
| QR code generator | no | yes |
| Revenue dashboard + charts | no | yes |
| Receipt generation | no | yes |
| Device management (block button) | no | yes |
| 4-tier pricing config | no | yes |
| Session tokens (express-session) | no | yes |

---

## UI Screenshots

### Admin Login Page

```
+=======================================+
|                                       |
|               [wifi]                  |
|          WiFi Zone OS                 |
|           Admin Login - V3            |
|                                       |
|  +---------------------------------+  |
|  | Username                        |  |
|  |  +---------------------------+  |  |
|  |  | admin                     |  |  |
|  |  +---------------------------+  |  |
|  |                                 |  |
|  | Password                        |  |
|  |  +---------------------------+  |  |
|  |  | ........                  |  |  |
|  |  +---------------------------+  |  |
|  |                                 |  |
|  |  +===========================+  |  |
|  |  |          Login            |  |  |
|  |  +===========================+  |  |
|  +---------------------------------+  |
|                                       |
+=======================================+
 Dark glass-morphism card on gradient bg
```

---

### Admin Dashboard - Overview Tab

```
+==================================================================+
| [wifi] WiFi Zone OS  |  Dashboard Overview                       |
| -------------------- | ----------------------------------------  |
| Home Overview (sel)  |                                            |
| Devices              |  +----------+ +----------+ +----------+   |
| Payments             |  | Total    | | Active   | | Expired  |   |
| Vouchers             |  | Devices  | | Sessions | |          |   |
| QR Code              |  |   12     | |    5     | |    3     |   |
|                      |  +----------+ +----------+ +----------+   |
| -------------------  |  +----------+ +------------------------+  |
| Logout               |  | Blocked  | |  Total Revenue          |  |
|                      |  |    4     | |   P1,240.00             |  |
|                      |  +----------+ +------------------------+  |
|                      |                                            |
|                      |  Hourly Revenue (last 24 h)               |
|                      |  +-------------------------------------+  |
|                      |  |       ##                             |  |
|                      |  |    ## ##  ##                         |  |
|                      |  | ## ## ##  ## ##                      |  |
|                      |  | -------   ------  ------            |  |
|                      |  | 08 09 10  11 12 ...                  |  |
|                      |  +-------------------------------------+  |
|                      |                                            |
|                      |  Recent Confirmed Payments                 |
|                      |  +----------------+--------------+------+ |
|                      |  | Ref            | MAC          |  P   | |
|                      |  +----------------+--------------+------+ |
|                      |  | PAY-1714...    | aa:bb:cc:... |  P20 | |
|                      |  | PAY-1713...    | 11:22:33:... |  P10 | |
|                      |  +----------------+--------------+------+ |
+==================================================================+
```

---

### Admin Dashboard - Devices Tab

```
+==================================================================+
| [wifi] WiFi Zone OS  |  Connected Devices                        |
| -------------------- | ----------------------------------------  |
| Devices (selected)   |  MAC           IP            Status  Time  Actions
|                      |  aa:bb:cc:..   192.168.1.10  active  22:15  Block  Allow
|                      |  11:22:33:..   192.168.1.11  active  60:00  Block  Allow
|                      |  de:ad:be:..   192.168.1.12  blocked  0:00  Block  Allow
|                      |  ca:fe:ba:..   192.168.1.13  expired  0:00  Block  Allow
+==================================================================+
```

---

### Admin Dashboard - Payments Tab

```
+==================================================================+
| [wifi] WiFi Zone OS  |  Payments                                  |
|                      |                                            |
|                      |  +-------------------------------------+  |
|                      |  | Confirm Pending Payment              |  |
|                      |  |  Ref: [ PAY-1714001234567_______ ]   |  |
|                      |  |               +================+     |  |
|                      |  |               |  Confirm       |     |  |
|                      |  |               +================+     |  |
|                      |  +-------------------------------------+  |
|                      |                                            |
|                      |  Ref          MAC        P     Status     |
|                      |  -----------------------------------------|
|                      |  PAY-171...   aa:bb:..   P20   confirmed  |
|                      |  PAY-171...   11:22:..   P10   pending    |
+==================================================================+
```

---

### Admin Dashboard - Vouchers Tab

```
+==================================================================+
| [wifi] WiFi Zone OS  |  Vouchers                                  |
|                      |                                            |
|                      |  Duration: [ 30 minutes v ]               |
|                      |            +==================+           |
|                      |            |   Generate       |           |
|                      |            +==================+           |
|                      |  Voucher: WIFI-AB3X2Z (30 min)            |
|                      |                                            |
|                      |  Code          Duration   Status          |
|                      |  ----------------------------------------- |
|                      |  WIFI-AB3X2Z   00:30:00   Available       |
|                      |  WIFI-PQ9R7Y   01:00:00   Used            |
+==================================================================+
```

---

### Admin Dashboard - QR Code Tab

```
+==================================================================+
| [wifi] WiFi Zone OS  |  Portal QR Code                            |
|                      |                                            |
|                      |  [ Generate QR ]                           |
|                      |                                            |
|                      |  +-----------------------------------+    |
|                      |  | ## ## ## ## ## ## ## ## ## ## ##  |    |
|                      |  | ##    ##    ##    ## ##    ##  ## |    |
|                      |  | ## ## ## ## ## ## ## ## ## ## ##  |    |
|                      |  |      (300x300 px QR image)        |    |
|                      |  +-----------------------------------+    |
|                      |  http://192.168.1.2:3000/                  |
+==================================================================+
```

---

### User Portal (Mobile View)

```
+===========================+
|          [wifi]           |
|       WiFi Zone           |
|  Select a plan to connect |
|                           |
|  +--------+ +--------+   |
|  |  P10   | |  P20   |   |
|  | 30 min | |  1 hr  |   |
|  +--------+ +--------+   |
|  +--------+ +--------+   |
|  |  P50   | |  P80   |   |
|  |  3 hr  | | 24 hr  |   |
|  +--------+ +--------+   |
|                           |
|  Your Device MAC          |
|  +-------------------+   |
|  | aa:bb:cc:dd:ee:ff |   |
|  +-------------------+   |
|                           |
|  +===================+   |
|  |  Buy P10 - 30min  |   |
|  +===================+   |
|                           |
|  Have a voucher?          |
|  +-----------+ +------+  |
|  | WIFI-XXXX | |Redeem|  |
|  +-----------+ +------+  |
|                           |
|  Session active:          |
|       00:29:58            |
+===========================+
```

---

## Security Notes

- Passwords hashed with **bcrypt** (10 rounds)
- Admin sessions via **express-session** with `httpOnly` cookies
- MAC and IP inputs **validated with regex** before use in firewall commands
- SQL uses **parameterized statements** — no raw string interpolation
- First login forces a **mandatory password change**

---

## Configuration

Edit `config/pricing.json` to change plans:

```json
{
  "rates": [
    { "price": 10, "time": 1800,  "label": "30 minutes" },
    { "price": 20, "time": 3600,  "label": "1 hour"     },
    { "price": 50, "time": 10800, "label": "3 hours"    },
    { "price": 80, "time": 86400, "label": "24 hours"   }
  ]
}
```

Environment variables (optional):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `PORTAL_IP` | `192.168.1.2` | IP DNS redirects all queries to |
| `DNS_PORT` | `53` | DNS server port |
| `SESSION_SECRET` | auto-generated 64-char hex string | Session signing secret, persisted to `config/.session-secret` |

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/login` | — | Admin login |
| POST | `/change-password` | yes | Change admin password |
| POST | `/logout` | yes | End session |
| GET | `/users` | yes | List all devices |
| POST | `/block/:mac` | yes | Block a device |
| POST | `/allow/:mac` | yes | Allow a device |
| POST | `/pay` | — | Create pending payment |
| POST | `/confirm-payment` | yes | Confirm + activate session |
| GET | `/payments` | yes | List all payments |
| POST | `/voucher/generate` | yes | Create a voucher |
| POST | `/voucher/redeem` | — | Redeem a voucher |
| GET | `/vouchers` | yes | List all vouchers |
| GET | `/qr` | — | Get portal QR code |
| GET | `/analytics` | yes | Get dashboard stats |
| GET | `/receipts` | yes | List all receipts |
| GET | `/pricing` | — | Get pricing config |

---

## Limitations (honest)

Without a MikroTik router:
- No true hardware-level captive portal
- No per-device bandwidth shaping
- No perfect layer-2 isolation

With this OS alone:
- Works on Starlink today
- Fully monetizable
- Upgradable to MikroTik when ready

---

## Roadmap - V4

- AI dynamic pricing
- Telegram bot payment confirmations
- Remote cloud admin panel
- Multi-router mesh support
- Auto GCash verification API
- Smart congestion control

---

## License

MIT — see [LICENSE](LICENSE)
