// config.rs — Configuration loader for wifios-reconciler
//
// Reads config.toml from the same directory as the binary, or from the path
// specified by the RECONCILER_CONFIG env var.

use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub general:    GeneralConfig,
    pub reconciler: ReconcilerConfig,
    pub watchdog:   WatchdogConfig,
    pub sysctl:     SysctlConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    pub state_file: String,
    pub state_dir:  String,
    pub log_level:  String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ReconcilerConfig {
    pub reconcile_interval_secs: u64,
    pub recovery_timeout_secs:   u64,
    pub api_base_url:            String,
    pub stale_mac_expiry_secs:   u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct WatchdogConfig {
    pub probe_interval_secs:      u64,
    pub dns_resolver:             String,
    pub dns_port:                 u16,
    pub probe_domain:             String,
    pub failure_threshold:        u32,
    pub restart_backoff_min_secs: u64,
    pub restart_backoff_max_secs: u64,
    pub max_restarts_per_window:  u32,
    pub jitter_ms:                u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SysctlConfig {
    pub apply_on_startup:     bool,
    pub tcp_keepalive_time:   u32,
    pub tcp_keepalive_intvl:  u32,
    pub tcp_keepalive_probes: u32,
    pub tcp_retries2:         u32,
}

// ─── Default impls (fallback values when config.toml is absent) ─────────────

impl Default for Config {
    fn default() -> Self {
        Self {
            general:    GeneralConfig::default(),
            reconciler: ReconcilerConfig::default(),
            watchdog:   WatchdogConfig::default(),
            sysctl:     SysctlConfig::default(),
        }
    }
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            state_file: "../config/session-state.json".into(),
            state_dir:  "../config".into(),
            log_level:  "info".into(),
        }
    }
}

impl Default for ReconcilerConfig {
    fn default() -> Self {
        Self {
            reconcile_interval_secs: 10,
            recovery_timeout_secs:   5,
            api_base_url:            "http://127.0.0.1:3000".into(),
            stale_mac_expiry_secs:   300,
        }
    }
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            probe_interval_secs:      15,
            dns_resolver:             "127.0.0.1".into(),
            dns_port:                 53,
            probe_domain:             "google.com".into(),
            failure_threshold:        3,
            restart_backoff_min_secs: 10,
            restart_backoff_max_secs: 300,
            max_restarts_per_window:  5,
            jitter_ms:                2000,
        }
    }
}

impl Default for SysctlConfig {
    fn default() -> Self {
        Self {
            apply_on_startup:     true,
            tcp_keepalive_time:   120,
            tcp_keepalive_intvl:  15,
            tcp_keepalive_probes: 5,
            tcp_retries2:         8,
        }
    }
}

// ─── Loader ──────────────────────────────────────────────────────────────────

pub fn load() -> Config {
    let config_path = std::env::var("RECONCILER_CONFIG")
        .unwrap_or_else(|_| "config.toml".to_string());

    let path = Path::new(&config_path);
    if !path.exists() {
        log::warn!(
            "Config file '{}' not found — using built-in defaults",
            config_path
        );
        return Config::default();
    }

    match std::fs::read_to_string(path) {
        Ok(contents) => match toml::from_str::<Config>(&contents) {
            Ok(cfg) => {
                log::info!("Loaded config from '{}'", config_path);
                cfg
            }
            Err(e) => {
                log::error!("Failed to parse config '{}': {} — using defaults", config_path, e);
                Config::default()
            }
        },
        Err(e) => {
            log::error!("Failed to read config '{}': {} — using defaults", config_path, e);
            Config::default()
        }
    }
}
