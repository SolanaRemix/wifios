// sysctl.rs — Idempotent Linux sysctl tuning for Starlink backhaul
//
// Applies TCP keepalive and retransmit settings to detect silent link drops
// quickly and reduce bufferbloat on variable-latency Starlink paths.
//
// On non-Linux targets, all functions are no-ops so the binary compiles and
// runs correctly on Windows/macOS development machines.

use crate::config::SysctlConfig;
use log::{debug, info, warn};

/// Apply all configured sysctl settings idempotently.
/// Each key is read first; if it already has the desired value, the write is
/// skipped so the function remains idempotent and safe to call on each startup.
pub fn apply(cfg: &SysctlConfig) {
    #[cfg(target_os = "linux")]
    {
        info!("[sysctl] applying Starlink-optimised kernel tuning...");
        set_if_changed("net.ipv4.tcp_keepalive_time",   cfg.tcp_keepalive_time);
        set_if_changed("net.ipv4.tcp_keepalive_intvl",  cfg.tcp_keepalive_intvl);
        set_if_changed("net.ipv4.tcp_keepalive_probes", cfg.tcp_keepalive_probes);
        set_if_changed("net.ipv4.tcp_retries2",         cfg.tcp_retries2);
        info!("[sysctl] kernel tuning complete");
    }
    #[cfg(not(target_os = "linux"))]
    {
        debug!("[sysctl] non-Linux platform — sysctl tuning skipped");
    }
}

#[cfg(target_os = "linux")]
fn set_if_changed(key: &str, desired: u32) {
    let sysctl_path = format!("/proc/sys/{}", key.replace('.', "/"));
    match std::fs::read_to_string(&sysctl_path) {
        Ok(current_str) => {
            let current: u32 = current_str.trim().parse().unwrap_or(u32::MAX);
            if current == desired {
                debug!("[sysctl] {key} already {desired} — no change needed");
                return;
            }
            match std::fs::write(&sysctl_path, format!("{desired}\n")) {
                Ok(_)  => info!("[sysctl] {key}: {current} → {desired}"),
                Err(e) => warn!("[sysctl] failed to set {key}={desired}: {e} (try running as root)"),
            }
        }
        Err(e) => {
            warn!("[sysctl] cannot read {key}: {e}");
        }
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SysctlConfig;

    #[test]
    fn apply_does_not_panic_on_any_platform() {
        // Just ensure the function doesn't panic regardless of OS.
        let cfg = SysctlConfig::default();
        apply(&cfg);
    }
}
