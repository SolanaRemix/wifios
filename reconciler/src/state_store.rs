// state_store.rs — Durable desired-state persistence with atomic write semantics
//
// Write protocol:
//   1. Serialize state to JSON bytes.
//   2. Write bytes to a sibling temp file (same filesystem → same rename() domain).
//   3. fsync the temp file to flush data to storage.
//   4. Atomically rename temp → state_file (POSIX rename is atomic on same FS).
//   5. Best-effort fsync the parent directory so the new directory entry survives.
//
// This ensures the reader always sees a complete, consistent snapshot even if
// power is lost mid-write.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// The serializable desired state persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesiredState {
    /// Schema version — bump when breaking changes are made.
    pub version: u32,
    /// Epoch seconds of last successful write.
    pub updated_at: u64,
    /// Map of MAC address → session entry.
    pub sessions: HashMap<String, SessionEntry>,
}

/// A single session entry describing the desired firewall disposition for a device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    /// Normalised MAC address (lowercase, colon-delimited).
    pub mac: String,
    /// Last known IP address.
    pub ip: Option<String>,
    /// Desired firewall state: "active" | "blocked" | "expired".
    pub status: String,
    /// Remaining session time in seconds (0 for blocked/expired).
    pub time_left: i64,
    /// Whether this MAC appears to be locally-administered (randomised).
    pub is_randomized: bool,
    /// Epoch seconds when this entry was last updated.
    pub last_seen: u64,
}

impl SessionEntry {
    pub fn is_stale(&self, expiry_secs: u64) -> bool {
        let now = now_secs();
        now.saturating_sub(self.last_seen) > expiry_secs
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─── StateStore ──────────────────────────────────────────────────────────────

pub struct StateStore {
    state_file: String,
    state_dir:  String,
}

impl StateStore {
    pub fn new(state_file: impl Into<String>, state_dir: impl Into<String>) -> Self {
        Self {
            state_file: state_file.into(),
            state_dir:  state_dir.into(),
        }
    }

    /// Load state from disk.  Returns `Ok(None)` if the file does not exist yet.
    pub fn load(&self) -> anyhow::Result<Option<DesiredState>>
    where
        anyhow::Error: Send + Sync,
    {
        let path = Path::new(&self.state_file);
        if !path.exists() {
            return Ok(None);
        }
        let data = std::fs::read_to_string(path)?;
        let state: DesiredState = serde_json::from_str(&data)?;
        Ok(Some(state))
    }

    /// Atomically persist `state` to disk.
    pub fn save(&self, state: &DesiredState) -> anyhow::Result<()> {
        let json = serde_json::to_string_pretty(state)?;
        let json_bytes = json.as_bytes();

        let state_path = Path::new(&self.state_file);
        let dir_path   = Path::new(&self.state_dir);

        // Create the destination directory if it doesn't exist yet.
        std::fs::create_dir_all(dir_path)?;

        // Write to a temp file in the same directory with restrictive permissions.
        let tmp_path = state_path.with_extension("json.tmp");
        {
            #[cfg(unix)]
            let mut tmp = {
                use std::os::unix::fs::OpenOptionsExt;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&tmp_path)?
            };
            #[cfg(not(unix))]
            let mut tmp = std::fs::File::create(&tmp_path)?;

            tmp.write_all(json_bytes)?;
            tmp.flush()?;
            tmp.sync_all()?;   // fsync data + metadata
        }

        // Atomic rename: temp → final path.
        std::fs::rename(&tmp_path, state_path)?;

        // Best-effort fsync the directory so the new directory entry is durable.
        if let Ok(dir_file) = std::fs::File::open(dir_path) {
            let _ = dir_file.sync_all();
        }

        log::debug!("[state_store] persisted {} session(s)", state.sessions.len());
        Ok(())
    }

    /// Build a fresh empty state with version=1 and the current timestamp.
    pub fn empty() -> DesiredState {
        DesiredState {
            version:    1,
            updated_at: now_secs(),
            sessions:   HashMap::new(),
        }
    }
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_store() -> (TempDir, StateStore) {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("session-state.json");
        let store = StateStore::new(
            file.to_str().unwrap().to_string(),
            dir.path().to_str().unwrap().to_string(),
        );
        (dir, store)
    }

    #[test]
    fn roundtrip_empty_state() {
        let (_dir, store) = tmp_store();
        assert!(store.load().unwrap().is_none());
        let state = StateStore::empty();
        store.save(&state).unwrap();
        let loaded = store.load().unwrap().expect("should load after save");
        assert_eq!(loaded.version, 1);
        assert!(loaded.sessions.is_empty());
    }

    #[test]
    fn roundtrip_session_entry() {
        let (_dir, store) = tmp_store();
        let mut state = StateStore::empty();
        state.sessions.insert(
            "aa:bb:cc:dd:ee:ff".to_string(),
            SessionEntry {
                mac:          "aa:bb:cc:dd:ee:ff".to_string(),
                ip:           Some("192.168.1.10".to_string()),
                status:       "active".to_string(),
                time_left:    3600,
                is_randomized: false,
                last_seen:    now_secs(),
            },
        );
        store.save(&state).unwrap();
        let loaded = store.load().unwrap().unwrap();
        let entry = loaded.sessions.get("aa:bb:cc:dd:ee:ff").unwrap();
        assert_eq!(entry.status, "active");
        assert_eq!(entry.time_left, 3600);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file() {
        let (dir, store) = tmp_store();
        let state = StateStore::empty();
        store.save(&state).unwrap();
        let tmp_path = dir.path().join("session-state.json.tmp");
        assert!(!tmp_path.exists(), "temp file should be cleaned up after rename");
    }

    #[test]
    fn stale_mac_detection() {
        let entry = SessionEntry {
            mac:          "aa:bb:cc:dd:ee:ff".to_string(),
            ip:           None,
            status:       "blocked".to_string(),
            time_left:    0,
            is_randomized: true,
            last_seen:    now_secs().saturating_sub(400),
        };
        assert!(entry.is_stale(300), "400s old entry should be stale with 300s expiry");
        assert!(!entry.is_stale(500), "400s old entry should not be stale with 500s expiry");
    }
}
