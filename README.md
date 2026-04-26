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
  |- MAC Engine           (arp scan + MAC-randomization dedup)
  |- Session Scheduler    (1 s tick + atomic state snapshot)
  |- Network Tuning       (TCP keepalive + fq_codel/CAKE on Linux)
  |- DNS Watchdog         (captive portal liveness + restart guard)
  +- Rust Reconciler      (startup recovery + periodic reconciliation)
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
| +-server.js           <- Main Express server + all API routes
| +-auth.js             <- bcrypt password helpers
| +-db.js               <- Shared SQLite connection + promise wrappers
| +-mac-engine.js       <- ARP scan -> upsert devices into DB (MAC-dedup aware)
| +-firewall.js         <- Windows Firewall block/allow (input-validated)
| +-dns-server.js       <- DNS captive-portal redirect
| +-scheduler.js        <- 1-second session timer + atomic state snapshot
| +-payment.js          <- GCash-style pending payment + confirm
| +-voucher.js          <- Voucher code generator
| +-qr.js               <- QR code image (base64 PNG)
| +-analytics.js        <- Revenue + device stats
| +-receipt.js          <- Plain-text receipt generator
| +-network-tuning.js   <- TCP keepalive + fq_codel/CAKE tuning (Linux/Windows)
| +-watchdog.js         <- DNS resolver liveness watchdog + portal restart guard
| +-mac-randomization.js <- MAC randomization detection + session dedup/expiry
+-frontend/
| +-login.html           <- Admin login page
| +-change-password.html <- First-login password change
| +-portal.html          <- User WiFi purchase portal
+-admin-panel/
| +-dashboard.html   <- Admin dashboard (SPA)
| +-dashboard.js     <- Dashboard logic / API calls
+-db/
| +-schema.sql       <- SQLite schema (includes is_randomized, updated_at)
+-config/
| +-pricing.json         <- Tier pricing config
| +-session-state.json   <- Durable session snapshot (auto-generated)
+-reconciler/            <- Rust state reconciliation daemon
| +-Cargo.toml
| +-config.toml          <- Daemon configuration knobs
| +-src/
|   +-main.rs            <- Entry point + signal handling
|   +-config.rs          <- Config loader with sane defaults
|   +-state_store.rs     <- Atomic state persistence (temp→fsync→rename→fsync dir)
|   +-reconciler.rs      <- Desired-state vs live-state convergence + MAC dedup
|   +-watchdog.rs        <- DNS probe + captive portal restart with backoff
|   +-sysctl.rs          <- Idempotent Linux sysctl tuning
+-scripts/
| +-install.ps1              <- One-command Windows installer
| +-start.ps1                <- Start all services
| +-starlink_healthcheck.sh  <- Starlink bypass-mode health check (Linux router)
+-tests/
| +-mac-randomization.test.js  <- Unit tests for MAC randomization logic
| +-atomic-persistence.test.js <- Atomic write + crash-recovery tests
| +-watchdog.test.js           <- Watchdog state + API surface tests
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
| MAC randomization dedup | no | yes |
| Atomic state-to-disk persistence | no | yes |
| TCP keepalive + CAKE/fq_codel tuning | no | yes |
| DNS watchdog with restart guard | no | yes |
| Rust state reconciliation daemon | no | yes |
| Starlink health check script | no | yes |

---

## Starlink Edge Hardening

### Network Tuning (Linux router)

On Linux (e.g. OpenWrt router), `backend/network-tuning.js` automatically applies at startup:

- **TCP keepalive** — detects silent Starlink link drops within ~2 minutes instead of the kernel default of 2 hours:
  ```
  tcp_keepalive_time   = 120 s
  tcp_keepalive_intvl  =  15 s
  tcp_keepalive_probes =   5
  tcp_retries2         =   8
  ```
- **Queue discipline** — installs `cake` (preferred) or `fq_codel` on the WAN interface to eliminate bufferbloat under Starlink's variable-latency link:
  ```sh
  tc qdisc replace dev eth0 root cake bandwidth 1Gbit nat ethernet
  ```
  Override the interface via `WAN_IFACE=eth0` env var.

On Windows, `netsh` is used to tune the TCP keepalive timer.

All tuning is **idempotent** — current values are read before writing, so settings already at the desired value are never re-written.

---

### No-Drift Atomic State Persistence

`backend/scheduler.js` uses the atomic **temp → fsync → rename → fsync(dir)** pattern to persist the session snapshot to `config/session-state.json`.  This ensures:

- A power cycle or OOM kill always leaves a **complete, consistent** snapshot.
- On restart, the Rust reconciler reads the snapshot and restores firewall rules within the configured `recovery_timeout_secs` (default 5 s).

The snapshot is written:
- Every 30 seconds (background heartbeat).
- Immediately after each session expiry event.
- 5 seconds after startup.

---

### DNS Watchdog

`backend/watchdog.js` probes the configured DNS resolver every ~15 s (with jitter).  When `failure_threshold` (default 3) consecutive probes fail:

1. The captive portal service is restarted.
2. **Exponential backoff** prevents restart storms (10 s → 20 s → … → 300 s cap).
3. A **rolling 10-minute window** caps total restarts at 5 (`max_restarts_per_window`).

Configuration via env vars:
| Env var | Default | Description |
|---|---|---|
| `WD_PROBE_INTERVAL_MS` | `15000` | Probe interval (ms) |
| `WD_PROBE_DOMAIN` | `google.com` | Domain to resolve |
| `WD_FAILURE_THRESHOLD` | `3` | Consecutive failures before restart |
| `WD_BACKOFF_MIN_MS` | `10000` | Minimum restart backoff |
| `WD_BACKOFF_MAX_MS` | `300000` | Maximum restart backoff |
| `WD_MAX_RESTARTS` | `5` | Max restarts per 10-minute window |
| `DNS_RESOLVER` | `127.0.0.1` | Resolver to probe |

---

### MAC Randomization Handling

Modern iOS, Android, and Windows devices use per-network MAC randomization.  `backend/mac-randomization.js` detects **locally-administered MACs** (bit 1 of octet 0 set) and:

1. **Deduplicates** — if a randomized MAC arrives on an IP that already has an active non-randomized session, the request is attributed to the existing session, preventing ghost entries.
2. **Prunes stale entries** — randomized MAC entries that haven't been seen for `MAC_STALE_SECS` (default 300 s) are automatically removed from the DB.

---

### Rust State Reconciliation Daemon

The `reconciler/` directory contains a standalone Rust binary (`wifios-reconciler`) that runs alongside the Node.js server:

```sh
# Build
cd reconciler
cargo build --release

# Run (reads config.toml from current directory)
./target/release/wifios-reconciler
```

Responsibilities:
- **Startup recovery** — reads `config/session-state.json` and calls the Node.js API to restore firewall rules within `recovery_timeout_secs`.
- **Periodic reconciliation** — every `reconcile_interval_secs`, compares desired state with live `/users` API state and converges diverged entries.
- **MAC dedup** — prunes stale randomized MAC entries and deduplicates ghost sessions sharing the same IP.
- **DNS watchdog** — independently probes the DNS resolver and calls `/internal/restart-portal` on threshold breach.
- **Linux sysctl tuning** — applies TCP keepalive settings on startup (configurable in `config.toml`).

See `reconciler/config.toml` for all configuration knobs and their defaults.

---

### Starlink Health Check Script

`scripts/starlink_healthcheck.sh` validates the full Starlink backhaul stack.  Suitable for cron or systemd timers:

```sh
# Run manually
./scripts/starlink_healthcheck.sh

# Quiet mode (warnings still go to stderr)
./scripts/starlink_healthcheck.sh --quiet

# Exit codes: 0 = all healthy, 1 = degraded (warnings), 2 = critical failure
```

Checks performed:
1. **Uplink reachability** — ping `8.8.8.8` and `1.1.1.1` via the WAN interface.
2. **DNS resolver** — resolve `google.com` against the configured resolver.
3. **Captive portal** — HTTP GET `http://192.168.1.2:3000/pricing` expecting HTTP 200.
4. **Queue discipline** — verify `cake` or `fq_codel` is active on the WAN interface.
5. **sysctl settings** — verify TCP keepalive values are within recommended ranges.

Configuration via env vars:
| Env var | Default | Description |
|---|---|---|
| `UPLINK_HOSTS` | `8.8.8.8 1.1.1.1` | Space-separated hosts to ping |
| `DNS_RESOLVER` | `8.8.8.8` | Resolver to test |
| `PORTAL_URL` | `http://192.168.1.2:3000/pricing` | Portal health URL |
| `WAN_IFACE` | auto-detected | WAN interface name |
| `PREFERRED_QDISC` | `cake` | Preferred queue discipline |

---

## Running Tests

```sh
npm test
```

Tests cover:
- MAC randomization detection and locally-administered bit logic.
- Atomic persistence correctness (write, read-back, crash simulation).
- Watchdog state machine and API surface.
- Rust unit tests: `cargo test` inside `reconciler/`.

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
- `/internal/restart-portal` endpoint restricted to localhost-only requests
- Atomic state file written with mode `0600` (owner read/write only)

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
| `WAN_IFACE` | auto-detected | WAN interface for qdisc tuning |
| `MAC_STALE_SECS` | `300` | Seconds before stale randomized MAC is pruned |
| `DNS_RESOLVER` | `127.0.0.1` | DNS resolver for watchdog probes |
| `CAKE_BANDWIDTH` | `1Gbit` | Bandwidth hint for CAKE qdisc (e.g. `250Mbit` for Starlink) |

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/login` | — | Admin login |
| POST | `/change-password` | yes | Change admin password |
| POST | `/logout` | — | End session |
| GET | `/users` | yes | List all devices |
| POST | `/block/:mac` | yes | Block a device |
| POST | `/allow/:mac` | yes | Allow a device |
| POST | `/pay` | — | Create pending payment |
| POST | `/confirm-payment` | yes | Confirm + activate session |
| GET | `/payments` | yes | List all payments |
| POST | `/voucher/generate` | yes | Create a voucher |
| POST | `/voucher/redeem` | — | Redeem a voucher |
| GET | `/vouchers` | yes | List all vouchers |
| GET | `/qr` | yes | Get portal QR code |
| GET | `/analytics` | yes | Get dashboard stats |
| GET | `/receipts` | yes | List all receipts |
| GET | `/pricing` | — | Get pricing config |
| POST | `/internal/restart-portal` | localhost-only | Restart captive portal (watchdog) |

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
| POST | `/logout` | — | End session |
| GET | `/users` | yes | List all devices |
| POST | `/block/:mac` | yes | Block a device |
| POST | `/allow/:mac` | yes | Allow a device |
| POST | `/pay` | — | Create pending payment |
| POST | `/confirm-payment` | yes | Confirm + activate session |
| GET | `/payments` | yes | List all payments |
| POST | `/voucher/generate` | yes | Create a voucher |
| POST | `/voucher/redeem` | — | Redeem a voucher |
| GET | `/vouchers` | yes | List all vouchers |
| GET | `/qr` | yes | Get portal QR code |
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
