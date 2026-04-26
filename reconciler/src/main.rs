// main.rs — wifios-reconciler entry point
//
// Spawns two independent async tasks:
//   1. Reconciler  — periodic desired-state ↔ live-state convergence.
//   2. Watchdog    — DNS resolver liveness probe + captive portal restart guard.
//
// On startup, runs synchronous recovery to restore firewall state from the
// durable snapshot within the configured timeout.

mod config;
mod reconciler;
mod state_store;
mod watchdog;
mod sysctl;

use config::Config;
use log::info;
use std::time::Duration;

#[tokio::main]
async fn main() {
    // ── Load configuration ────────────────────────────────────────────────
    let cfg = config::load();

    // ── Initialise logging ────────────────────────────────────────────────
    let log_level = cfg.general.log_level.clone();
    std::env::set_var("RUST_LOG", &log_level);
    env_logger::init();

    info!(
        "wifios-reconciler v{} starting (log_level={})",
        env!("CARGO_PKG_VERSION"),
        log_level
    );

    // ── Apply sysctl tuning (Linux only) ──────────────────────────────────
    if cfg.sysctl.apply_on_startup {
        sysctl::apply(&cfg.sysctl);
    }

    // ── Startup recovery (synchronous — must complete before event loop) ──
    let rec = reconciler::Reconciler::new(cfg.clone());
    let restored = rec.startup_recovery();
    info!("[main] startup recovery: {restored} session(s) restored");

    // ── Spawn reconciler loop ─────────────────────────────────────────────
    let cfg_rec = cfg.clone();
    let reconcile_interval = Duration::from_secs(cfg.reconciler.reconcile_interval_secs);

    let rec_task = tokio::spawn(async move {
        let r = reconciler::Reconciler::new(cfg_rec);
        loop {
            r.reconcile();
            tokio::time::sleep(reconcile_interval).await;
        }
    });

    // ── Spawn watchdog loop ───────────────────────────────────────────────
    let cfg_wd = cfg.clone();
    let wd_task = tokio::spawn(async move {
        watchdog::run_watchdog(cfg_wd).await;
    });

    // ── Wait for Ctrl-C / SIGTERM ─────────────────────────────────────────
    let shutdown = async {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate())
                .expect("failed to register SIGTERM handler");
            tokio::select! {
                _ = sigterm.recv() => info!("[main] SIGTERM received — shutting down"),
                _ = tokio::signal::ctrl_c() => info!("[main] SIGINT received — shutting down"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.expect("failed to install Ctrl-C handler");
            info!("[main] Ctrl-C received — shutting down");
        }
    };

    tokio::select! {
        _ = shutdown       => {}
        _ = rec_task       => { log::warn!("[main] reconciler task exited unexpectedly"); }
        _ = wd_task        => { log::warn!("[main] watchdog task exited unexpectedly"); }
    }

    info!("[main] wifios-reconciler stopped");
}
