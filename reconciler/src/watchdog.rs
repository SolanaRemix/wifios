// watchdog.rs — DNS resolver liveness watchdog + captive portal restart guard
//
// Behaviour:
//   • Probe the local DNS resolver at `dns_resolver:dns_port` by sending a
//     minimal A-record query for `probe_domain`.
//   • On consecutive `failure_threshold` failures, trigger a restart of the
//     captive portal by calling the backend's restart endpoint.
//   • Exponential backoff (capped at `restart_backoff_max_secs`) prevents
//     restart storms.  A rolling 10-minute window caps the restart count at
//     `max_restarts_per_window`.
//   • Jitter is applied to the probe interval to avoid synchronised probes
//     across multiple watchdog instances.

use crate::config::{Config, WatchdogConfig};
use log::{debug, error, info, warn};
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

/// Simple DNS question record — we build a minimal UDP DNS A-query by hand
/// so we have zero extra dependencies for this hot path.
fn build_dns_query(domain: &str, tx_id: u16) -> Vec<u8> {
    let mut pkt: Vec<u8> = Vec::with_capacity(64);

    // Header: ID | FLAGS | QDCOUNT | ANCOUNT | NSCOUNT | ARCOUNT
    pkt.extend_from_slice(&tx_id.to_be_bytes()); // ID
    pkt.extend_from_slice(&[0x01, 0x00]);         // Flags: standard query, RD=1
    pkt.extend_from_slice(&[0x00, 0x01]);         // QDCOUNT = 1
    pkt.extend_from_slice(&[0x00, 0x00]);         // ANCOUNT = 0
    pkt.extend_from_slice(&[0x00, 0x00]);         // NSCOUNT = 0
    pkt.extend_from_slice(&[0x00, 0x00]);         // ARCOUNT = 0

    // QNAME: encode each label as length-prefixed bytes, terminated by 0x00
    for label in domain.split('.') {
        let bytes = label.as_bytes();
        pkt.push(bytes.len() as u8);
        pkt.extend_from_slice(bytes);
    }
    pkt.push(0x00);                               // root label

    // QTYPE = A (1), QCLASS = IN (1)
    pkt.extend_from_slice(&[0x00, 0x01]);
    pkt.extend_from_slice(&[0x00, 0x01]);

    pkt
}

/// Returns true if `buf` looks like a valid DNS response to our query
/// (matching transaction ID, QR bit set, no RCODE error, at least 1 answer).
fn is_valid_dns_response(buf: &[u8], tx_id: u16) -> bool {
    if buf.len() < 12 {
        return false;
    }
    let resp_id = u16::from_be_bytes([buf[0], buf[1]]);
    if resp_id != tx_id {
        return false;
    }
    let flags = u16::from_be_bytes([buf[2], buf[3]]);
    let qr    = (flags >> 15) & 1;     // 1 = response
    let rcode = flags & 0x000F;         // 0 = no error, 3 = NXDOMAIN (still responsive)
    let ancount = u16::from_be_bytes([buf[6], buf[7]]);

    qr == 1 && (rcode == 0 || rcode == 3) && ancount > 0 || (qr == 1 && rcode == 3)
}

/// Probe DNS once.  Returns true on success (any non-error response received).
fn probe_dns_once(cfg: &WatchdogConfig) -> bool {
    let addr: SocketAddr = format!("{}:{}", cfg.dns_resolver, cfg.dns_port)
        .parse()
        .unwrap_or_else(|_| "127.0.0.1:53".parse().unwrap());

    let tx_id: u16 = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42)) as u16;

    let query = build_dns_query(&cfg.probe_domain, tx_id);

    // Bind to any available local port.
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s)  => s,
        Err(e) => { warn!("[watchdog] failed to bind UDP socket: {e}"); return false; }
    };
    if socket.set_read_timeout(Some(Duration::from_secs(2))).is_err() {
        return false;
    }

    if socket.send_to(&query, addr).is_err() {
        return false;
    }

    let mut buf = [0u8; 512];
    match socket.recv_from(&mut buf) {
        Ok((n, _src)) => is_valid_dns_response(&buf[..n], tx_id),
        Err(_)        => false,
    }
}

// ─── Watchdog task ──────────────────────────────────────────────────────────

pub async fn run_watchdog(cfg: Config) {
    let wdcfg = &cfg.watchdog;
    let api_base = &cfg.reconciler.api_base_url;

    info!(
        "[watchdog] started — probing {}:{} every ~{}s (jitter ±{}ms)",
        wdcfg.dns_resolver, wdcfg.dns_port,
        wdcfg.probe_interval_secs, wdcfg.jitter_ms
    );

    let mut consecutive_failures: u32 = 0;
    let mut backoff_secs: u64          = wdcfg.restart_backoff_min_secs;
    let mut last_restart_at: Option<Instant> = None;
    // Rolling window: (timestamp_secs, count)
    let mut restart_window: Vec<u64>   = Vec::new();
    let window_secs: u64               = 600; // 10 minutes

    loop {
        // ── Probe ──────────────────────────────────────────────────────────
        let ok = probe_dns_once(wdcfg);

        if ok {
            if consecutive_failures > 0 {
                info!("[watchdog] DNS resolver recovered after {consecutive_failures} failure(s)");
            }
            consecutive_failures = 0;
            backoff_secs = wdcfg.restart_backoff_min_secs; // reset backoff on recovery
        } else {
            consecutive_failures += 1;
            warn!(
                "[watchdog] DNS probe failed ({consecutive_failures}/{} threshold)",
                wdcfg.failure_threshold
            );
        }

        // ── Trigger restart if threshold exceeded ──────────────────────────
        if consecutive_failures >= wdcfg.failure_threshold {
            // Respect backoff: don't restart more frequently than `backoff_secs`.
            let should_restart = match last_restart_at {
                None       => true,
                Some(last) => last.elapsed().as_secs() >= backoff_secs,
            };

            // Storm guard: count restarts in the rolling window.
            let now_ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            restart_window.retain(|&t| now_ts - t < window_secs);
            let restarts_in_window = restart_window.len() as u32;

            if restarts_in_window >= wdcfg.max_restarts_per_window {
                warn!(
                    "[watchdog] storm guard: {} restart(s) in last {}s — holding off",
                    restarts_in_window, window_secs
                );
            } else if should_restart {
                info!(
                    "[watchdog] DNS failure threshold reached — restarting captive portal \
                     (backoff={}s, window_restarts={})",
                    backoff_secs, restarts_in_window
                );

                trigger_portal_restart(api_base, consecutive_failures).await;

                last_restart_at = Some(Instant::now());
                restart_window.push(now_ts);
                consecutive_failures = 0;

                // Exponential backoff, capped at max.
                backoff_secs = (backoff_secs * 2).min(wdcfg.restart_backoff_max_secs);
            }
        }

        // ── Sleep with jitter ──────────────────────────────────────────────
        let interval_ms = wdcfg.probe_interval_secs * 1000;
        let jitter_ms   = if wdcfg.jitter_ms > 0 {
            // Deterministic pseudo-jitter: use current second as seed offset.
            let seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            seed % wdcfg.jitter_ms
        } else {
            0
        };
        let sleep_ms = interval_ms.saturating_add(jitter_ms);
        debug!("[watchdog] sleeping {}ms", sleep_ms);
        sleep(Duration::from_millis(sleep_ms)).await;
    }
}

/// Call the backend to restart the DNS/captive-portal service and log context.
async fn trigger_portal_restart(api_base: &str, failure_count: u32) {
    let url = format!("{api_base}/internal/restart-portal");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();

    match client {
        Err(e) => {
            error!("[watchdog] failed to build HTTP client: {e}");
        }
        Ok(c) => {
            let body = serde_json::json!({
                "reason": "dns_watchdog",
                "consecutive_failures": failure_count
            });
            match c.post(&url).json(&body).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        info!("[watchdog] portal restart triggered successfully");
                    } else {
                        warn!("[watchdog] portal restart returned HTTP {}", resp.status());
                    }
                }
                Err(e) => {
                    warn!("[watchdog] portal restart request failed: {e}");
                }
            }
        }
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_query_builds_correctly() {
        let pkt = build_dns_query("example.com", 0xABCD);
        // Header is 12 bytes; ID bytes first
        assert_eq!(pkt[0], 0xAB);
        assert_eq!(pkt[1], 0xCD);
        // QDCOUNT = 1
        assert_eq!(pkt[4], 0x00);
        assert_eq!(pkt[5], 0x01);
    }

    #[test]
    fn valid_dns_response_detection_nxdomain() {
        // Build a minimal NXDOMAIN response (RCODE=3, QR=1, ANCOUNT=0)
        let tx_id: u16 = 0x1234;
        let mut buf = vec![0u8; 12];
        buf[0] = 0x12; buf[1] = 0x34;    // ID
        buf[2] = 0x81; buf[3] = 0x83;    // QR=1, RD=1, RA=1, RCODE=3 (NXDOMAIN)
        buf[4] = 0x00; buf[5] = 0x00;    // ANCOUNT = 0
        assert!(is_valid_dns_response(&buf, tx_id));
    }

    #[test]
    fn invalid_dns_response_wrong_id() {
        let mut buf = vec![0u8; 12];
        buf[0] = 0xFF; buf[1] = 0xFF;
        buf[2] = 0x81; buf[3] = 0x80;
        buf[6] = 0x00; buf[7] = 0x01;    // ANCOUNT=1
        assert!(!is_valid_dns_response(&buf, 0x1234));
    }

    #[test]
    fn too_short_dns_response() {
        let buf = vec![0u8; 6];
        assert!(!is_valid_dns_response(&buf, 0x0001));
    }
}
