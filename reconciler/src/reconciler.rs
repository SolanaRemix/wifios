// reconciler.rs — Desired-state vs live-runtime reconciliation
//
// On startup:  read persisted state, issue firewall restore commands to the
//              Node.js backend API.  Target: converge within 5 s.
// Periodic:    every `reconcile_interval_secs`, compare desired state from
//              disk with live state from the backend API and converge.
// Conflict:    desired state always wins (last-write-wins on status field).
// MAC-random:  entries where is_randomized=true and last_seen is stale are
//              pruned from desired state (dedup by IP when applicable).

use crate::config::Config;
use crate::state_store::{DesiredState, SessionEntry, StateStore};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use serde::Deserialize;
use log::{info, warn, error, debug};

/// Live session row returned by GET /users.
#[derive(Debug, Deserialize)]
struct LiveSession {
    mac:       String,
    ip:        Option<String>,
    status:    String,
    time_left: i64,
}

pub struct Reconciler {
    cfg:   Config,
    store: StateStore,
    http:  reqwest::blocking::Client,
}

impl Reconciler {
    pub fn new(cfg: Config) -> Self {
        let store = StateStore::new(
            cfg.general.state_file.clone(),
            cfg.general.state_dir.clone(),
        );
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(4))
            .build()
            .expect("failed to build HTTP client");
        Self { cfg, store, http }
    }

    // ─── Startup Recovery ───────────────────────────────────────────────────

    /// Load persisted state and restore firewall rules via the backend API.
    /// Returns the number of sessions restored, or 0 if no state file exists.
    pub fn startup_recovery(&self) -> usize {
        let deadline = Instant::now()
            + Duration::from_secs(self.cfg.reconciler.recovery_timeout_secs);

        let state = match self.store.load() {
            Ok(Some(s)) => s,
            Ok(None)    => {
                info!("[reconciler] no persisted state — starting fresh");
                return 0;
            }
            Err(e) => {
                error!("[reconciler] failed to load state: {e}");
                return 0;
            }
        };

        info!(
            "[reconciler] startup recovery: {} session(s) in persisted state (v{})",
            state.sessions.len(), state.version
        );

        let mut restored = 0;
        for (mac, entry) in &state.sessions {
            if Instant::now() > deadline {
                warn!("[reconciler] recovery timeout reached — {} session(s) not restored", state.sessions.len() - restored);
                break;
            }

            // Skip stale randomized MACs on startup — they will be reconciled
            // or pruned on the next reconciliation cycle.
            if entry.is_randomized && entry.is_stale(self.cfg.reconciler.stale_mac_expiry_secs) {
                debug!("[reconciler] skipping stale randomized MAC {mac} on startup");
                continue;
            }

            if let Err(e) = self.apply_entry(mac, entry) {
                warn!("[reconciler] failed to restore {mac}: {e}");
            } else {
                restored += 1;
                debug!("[reconciler] restored {mac} → {}", entry.status);
            }
        }
        info!("[reconciler] startup recovery complete: {restored} session(s) restored");
        restored
    }

    // ─── Periodic Reconciliation ─────────────────────────────────────────────

    /// Fetch live state from backend, compare with desired state, converge.
    pub fn reconcile(&self) {
        // Load desired state from disk.
        let mut desired = match self.store.load() {
            Ok(Some(s)) => s,
            Ok(None)    => StateStore::empty(),
            Err(e) => {
                error!("[reconciler] cannot load desired state: {e}");
                return;
            }
        };

        // Fetch live state from backend.
        let live = match self.fetch_live_sessions() {
            Ok(s)  => s,
            Err(e) => {
                warn!("[reconciler] cannot fetch live sessions: {e}");
                return;
            }
        };

        let mut changes = 0;

        // ── Prune stale randomized MACs from desired state ────────────────
        let expiry = self.cfg.reconciler.stale_mac_expiry_secs;
        let before = desired.sessions.len();
        desired.sessions.retain(|_mac, entry| {
            if entry.is_randomized && entry.is_stale(expiry) {
                debug!("[reconciler] pruning stale randomized MAC {}", entry.mac);
                false
            } else {
                true
            }
        });
        let pruned = before - desired.sessions.len();
        if pruned > 0 {
            info!("[reconciler] pruned {pruned} stale randomized MAC(s)");
            changes += pruned;
        }

        // ── Dedup randomized MACs by IP ───────────────────────────────────
        // If two entries share the same IP and one is randomized, merge them.
        let ip_to_canonical: HashMap<String, String> = desired
            .sessions
            .values()
            .filter(|e| !e.is_randomized && e.ip.is_some())
            .map(|e| (e.ip.clone().unwrap(), e.mac.clone()))
            .collect();

        let mut to_remove: Vec<String> = Vec::new();
        for (mac, entry) in desired.sessions.iter() {
            if entry.is_randomized {
                if let Some(ip) = &entry.ip {
                    if let Some(canonical) = ip_to_canonical.get(ip) {
                        if canonical != mac {
                            debug!(
                                "[reconciler] dedup: randomized {mac} shares IP {ip} with canonical {canonical} — removing ghost"
                            );
                            to_remove.push(mac.clone());
                        }
                    }
                }
            }
        }
        for mac in &to_remove {
            desired.sessions.remove(mac);
            changes += 1;
        }
        if !to_remove.is_empty() {
            info!("[reconciler] deduped {} ghost randomized session(s)", to_remove.len());
        }

        // ── Converge: desired → live ───────────────────────────────────────
        for (mac, desired_entry) in &desired.sessions {
            let live_entry = live.iter().find(|l| &l.mac == mac);
            match live_entry {
                Some(live) if live.status == desired_entry.status => {
                    // Already aligned — nothing to do.
                }
                Some(live) => {
                    info!(
                        "[reconciler] mismatch for {mac}: desired={} live={} — converging",
                        desired_entry.status, live.status
                    );
                    if let Err(e) = self.apply_entry(mac, desired_entry) {
                        warn!("[reconciler] converge failed for {mac}: {e}");
                    } else {
                        changes += 1;
                    }
                }
                None => {
                    // Entry in desired state but not in live — apply it.
                    debug!("[reconciler] {mac} in desired but not live — applying");
                    if let Err(e) = self.apply_entry(mac, desired_entry) {
                        warn!("[reconciler] apply failed for {mac}: {e}");
                    } else {
                        changes += 1;
                    }
                }
            }
        }

        if changes > 0 {
            info!("[reconciler] reconciliation cycle: {changes} change(s)");
            // Persist updated desired state after pruning/dedup.
            if let Err(e) = self.store.save(&desired) {
                error!("[reconciler] failed to persist updated state: {e}");
            }
        } else {
            debug!("[reconciler] reconciliation cycle: no changes needed");
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fn fetch_live_sessions(&self) -> anyhow::Result<Vec<LiveSession>> {
        let url = format!("{}/users", self.cfg.reconciler.api_base_url);
        let resp = self.http.get(&url).send()?;
        if !resp.status().is_success() {
            anyhow::bail!("GET /users returned {}", resp.status());
        }
        Ok(resp.json::<Vec<LiveSession>>()?)
    }

    fn apply_entry(&self, mac: &str, entry: &SessionEntry) -> anyhow::Result<()> {
        let base = &self.cfg.reconciler.api_base_url;
        let endpoint = match entry.status.as_str() {
            "active" => format!("{base}/allow/{mac}"),
            _        => format!("{base}/block/{mac}"),
        };
        let resp = self.http.post(&endpoint).send()?;
        if !resp.status().is_success() {
            anyhow::bail!("POST {endpoint} returned {}", resp.status());
        }
        Ok(())
    }

    /// Update the desired state store with a session entry from the backend.
    /// Called externally to integrate live DB changes into the durable snapshot.
    pub fn update_session(
        &self,
        mac:          &str,
        ip:           Option<String>,
        status:       &str,
        time_left:    i64,
        is_randomized: bool,
    ) {
        let mut state = match self.store.load() {
            Ok(Some(s)) => s,
            Ok(None)    => StateStore::empty(),
            Err(e)      => { error!("[reconciler] update_session load error: {e}"); return; }
        };
        let entry = SessionEntry {
            mac:          mac.to_string(),
            ip,
            status:       status.to_string(),
            time_left,
            is_randomized,
            last_seen:    std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
        };
        state.sessions.insert(mac.to_string(), entry);
        if let Err(e) = self.store.save(&state) {
            error!("[reconciler] failed to persist after update_session: {e}");
        }
    }
}
