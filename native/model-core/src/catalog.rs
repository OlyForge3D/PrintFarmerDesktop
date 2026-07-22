//! The local model catalog: logical model identity, physical locations, a
//! storage-agnostic [`CatalogStore`] trait, an in-memory implementation, and
//! the reconciliation that turns a filesystem scan into catalog updates.
//!
//! A *logical model* is identified by its SHA-256 content hash. The same bytes
//! appearing under several names, folders, or roots collapse into one logical
//! model with multiple *locations* — this is the exact-byte duplicate grouping.
//!
//! The trait boundary lets a SQLite-backed store (compiled where a C toolchain
//! is available) and the in-memory store used in tests share identical
//! reconciliation logic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::hash::{hash_file, ContentHash};
use crate::model::{FileFingerprint, ModelFormat};
use crate::scan::ScanResult;

/// Stable identifier for a source root (a user-selected folder).
pub type RootId = String;

/// A physical file backing a logical model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelLocation {
    pub root_id: RootId,
    pub path: PathBuf,
    pub root_relative: PathBuf,
    pub fingerprint: FileFingerprint,
    /// Whether the file was present at the last reconciliation.
    pub available: bool,
}

/// A logical model plus every physical location that carries its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogicalModel {
    pub hash: ContentHash,
    pub format: ModelFormat,
    pub size: u64,
    pub locations: Vec<ModelLocation>,
}

impl LogicalModel {
    /// A model is a duplicate group when more than one physical file resolves
    /// to the same content hash.
    pub fn is_duplicate_group(&self) -> bool {
        self.locations.len() > 1
    }
}

/// What the store already knows about a path at a given root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLocation {
    pub hash: ContentHash,
    pub fingerprint: FileFingerprint,
    pub available: bool,
}

/// Everything needed to record (or refresh) a location under its model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationUpsert {
    pub hash: ContentHash,
    pub format: ModelFormat,
    pub size: u64,
    pub root_id: RootId,
    pub path: PathBuf,
    pub root_relative: PathBuf,
    pub fingerprint: FileFingerprint,
}

/// Storage abstraction for the catalog. Implementations must keep logical model
/// identity and physical locations consistent: a location belongs to exactly
/// one model at a time (its current content hash).
pub trait CatalogStore {
    /// Look up what is currently recorded for a path under a root.
    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation>;

    /// Insert or replace a location, attaching it to `upsert.hash`'s model and
    /// detaching it from any previous model. Marks the location available.
    fn upsert_location(&mut self, upsert: LocationUpsert);

    /// Set the availability flag for a known location.
    fn set_available(&mut self, root_id: &str, path: &Path, available: bool);

    /// Absolute paths of all locations currently recorded under a root.
    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf>;

    /// Fetch a single logical model by content hash.
    fn model(&self, hash: &str) -> Option<LogicalModel>;

    /// All logical models known to the catalog.
    fn models(&self) -> Vec<LogicalModel>;

    /// Logical models with more than one physical location.
    fn duplicate_groups(&self) -> Vec<LogicalModel> {
        self.models()
            .into_iter()
            .filter(LogicalModel::is_duplicate_group)
            .collect()
    }
}

/// Summary of a reconciliation pass over one root.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Newly cataloged locations.
    pub added: usize,
    /// Locations whose bytes changed (re-hashed to a new content hash).
    pub changed: usize,
    /// Locations seen again with an unchanged fingerprint (not re-hashed).
    pub unchanged: usize,
    /// Previously known locations no longer present under the root.
    pub missing: usize,
    /// Files that could not be hashed (IO/permission errors).
    pub hash_errors: usize,
}

/// Reconcile a root's scan against the store, hashing only new or changed
/// files. Locations that disappeared are marked unavailable rather than
/// deleted, so a reconnecting drive restores them without a re-hash.
pub fn reconcile_root<S: CatalogStore + ?Sized>(
    store: &mut S,
    root_id: &str,
    scan: &ScanResult,
) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let mut seen: Vec<PathBuf> = Vec::with_capacity(scan.files.len());

    for file in &scan.files {
        seen.push(file.path.clone());
        let existing = store.get_location(root_id, &file.path);

        let unchanged = existing
            .as_ref()
            .is_some_and(|e| e.fingerprint == file.fingerprint && e.available);
        if unchanged {
            report.unchanged += 1;
            continue;
        }

        let hash = match hash_file(&file.path) {
            Ok(h) => h,
            Err(_) => {
                report.hash_errors += 1;
                continue;
            }
        };

        match &existing {
            Some(prev) if prev.hash == hash => report.unchanged += 1,
            Some(_) => report.changed += 1,
            None => report.added += 1,
        }

        store.upsert_location(LocationUpsert {
            hash,
            format: file.format,
            size: file.fingerprint.size,
            root_id: root_id.to_string(),
            path: file.path.clone(),
            root_relative: file.root_relative.clone(),
            fingerprint: file.fingerprint.clone(),
        });
    }

    // Anything previously known under this root but not seen this pass is now
    // missing. Only meaningful for a completed (non-cancelled) scan.
    if !scan.cancelled {
        let seen_set: std::collections::HashSet<&PathBuf> = seen.iter().collect();
        for known in store.paths_for_root(root_id) {
            if !seen_set.contains(&known) {
                store.set_available(root_id, &known, false);
                report.missing += 1;
            }
        }
    }

    report
}

// --- In-memory implementation --------------------------------------------

#[derive(Debug, Clone)]
struct LocationRecord {
    root_relative: PathBuf,
    fingerprint: FileFingerprint,
    available: bool,
}

#[derive(Debug, Clone)]
struct ModelRecord {
    format: ModelFormat,
    size: u64,
    locations: HashMap<(RootId, PathBuf), LocationRecord>,
}

/// A non-persistent [`CatalogStore`] used for tests and as the reference
/// implementation of catalog semantics.
#[derive(Debug, Default)]
pub struct InMemoryCatalog {
    models: HashMap<ContentHash, ModelRecord>,
    /// Maps a physical location to the content hash it currently belongs to.
    index: HashMap<(RootId, PathBuf), ContentHash>,
}

impl InMemoryCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    fn build_model(&self, hash: &str, record: &ModelRecord) -> LogicalModel {
        let mut locations: Vec<ModelLocation> = record
            .locations
            .iter()
            .map(|((root_id, path), loc)| ModelLocation {
                root_id: root_id.clone(),
                path: path.clone(),
                root_relative: loc.root_relative.clone(),
                fingerprint: loc.fingerprint.clone(),
                available: loc.available,
            })
            .collect();
        locations.sort_by(|a, b| a.path.cmp(&b.path));
        LogicalModel {
            hash: hash.to_string(),
            format: record.format,
            size: record.size,
            locations,
        }
    }
}

impl CatalogStore for InMemoryCatalog {
    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation> {
        let key = (root_id.to_string(), path.to_path_buf());
        let hash = self.index.get(&key)?;
        let record = self.models.get(hash)?;
        let loc = record.locations.get(&key)?;
        Some(StoredLocation {
            hash: hash.clone(),
            fingerprint: loc.fingerprint.clone(),
            available: loc.available,
        })
    }

    fn upsert_location(&mut self, upsert: LocationUpsert) {
        let key = (upsert.root_id.clone(), upsert.path.clone());

        // Detach from any previous model if the hash changed.
        if let Some(prev_hash) = self.index.get(&key) {
            if prev_hash != &upsert.hash {
                if let Some(prev) = self.models.get_mut(prev_hash) {
                    prev.locations.remove(&key);
                    if prev.locations.is_empty() {
                        self.models.remove(prev_hash);
                    }
                }
            }
        }

        let record = self
            .models
            .entry(upsert.hash.clone())
            .or_insert_with(|| ModelRecord {
                format: upsert.format,
                size: upsert.size,
                locations: HashMap::new(),
            });
        record.locations.insert(
            key.clone(),
            LocationRecord {
                root_relative: upsert.root_relative,
                fingerprint: upsert.fingerprint,
                available: true,
            },
        );
        self.index.insert(key, upsert.hash);
    }

    fn set_available(&mut self, root_id: &str, path: &Path, available: bool) {
        let key = (root_id.to_string(), path.to_path_buf());
        if let Some(hash) = self.index.get(&key) {
            if let Some(record) = self.models.get_mut(hash) {
                if let Some(loc) = record.locations.get_mut(&key) {
                    loc.available = available;
                }
            }
        }
    }

    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf> {
        self.index
            .keys()
            .filter(|(r, _)| r == root_id)
            .map(|(_, p)| p.clone())
            .collect()
    }

    fn model(&self, hash: &str) -> Option<LogicalModel> {
        self.models.get(hash).map(|r| self.build_model(hash, r))
    }

    fn models(&self) -> Vec<LogicalModel> {
        let mut out: Vec<LogicalModel> = self
            .models
            .iter()
            .map(|(hash, record)| self.build_model(hash, record))
            .collect();
        out.sort_by(|a, b| a.hash.cmp(&b.hash));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_root;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn scan(root: &Path) -> ScanResult {
        scan_root(root, &AtomicBool::new(false))
    }

    #[test]
    fn identical_bytes_across_paths_form_one_duplicate_group() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"same-bytes");
        write(&root.join("nested/copy.stl"), b"same-bytes");
        write(&root.join("other.stl"), b"different");

        let mut store = InMemoryCatalog::new();
        let report = reconcile_root(&mut store, "root1", &scan(root));

        assert_eq!(report.added, 3);
        assert_eq!(store.models().len(), 2);

        let dupes = store.duplicate_groups();
        assert_eq!(dupes.len(), 1);
        assert_eq!(dupes[0].locations.len(), 2);
    }

    #[test]
    fn unchanged_files_are_not_rehashed_on_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"hello");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.unchanged, 1);
        assert_eq!(report.added, 0);
        assert_eq!(report.changed, 0);
    }

    #[test]
    fn changed_content_moves_the_location_to_a_new_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("a.stl");
        write(&file, b"v1");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        let first_hash = store.models()[0].hash.clone();

        // Rewrite with different bytes; fingerprint (size) changes.
        write(&file, b"v2-longer");
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.changed, 1);
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert_ne!(models[0].hash, first_hash);
        assert_eq!(models[0].locations.len(), 1);
    }

    #[test]
    fn removed_files_are_marked_missing_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("gone.stl");
        write(&file, b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        fs::remove_file(&file).unwrap();
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.missing, 1);
        // The model still exists, but its location is unavailable.
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert!(!models[0].locations[0].available);
    }

    #[test]
    fn reappearing_file_becomes_available_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let file = root.join("m.stl");
        write(&file, b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        fs::remove_file(&file).unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        write(&file, b"bytes");
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.added + report.unchanged + report.changed, 1);
        assert!(store.models()[0].locations[0].available);
    }

    #[test]
    fn cancelled_scan_does_not_mark_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        let cancelled = ScanResult {
            cancelled: true,
            ..Default::default()
        };
        let report = reconcile_root(&mut store, "r", &cancelled);
        assert_eq!(report.missing, 0);
        assert!(store.models()[0].locations[0].available);
    }
}
