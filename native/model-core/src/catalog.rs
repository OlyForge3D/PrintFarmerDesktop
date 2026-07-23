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
/// A user-defined organizational label. `id` is the normalized (lowercased,
/// trimmed) name and doubles as a stable identity so the same label typed in
/// different cases collapses to one tag.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Tag {
    pub id: String,
    pub name: String,
}

/// Normalizes a raw tag name into `(id, display)`. Returns `None` when the
/// name is empty after trimming.
pub fn normalize_tag(name: &str) -> Option<Tag> {
    let display = name.trim();
    if display.is_empty() {
        return None;
    }
    Some(Tag {
        id: display.to_lowercase(),
        name: display.to_string(),
    })
}

/// A user-owned, many-to-many grouping of models. Unlike tags, collections
/// have opaque ids so two collections may share a display name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub shared_to_farm: bool,
    pub member_count: usize,
}

/// Generates a process-unique, sortable-ish collection id from the wall clock
/// plus a monotonic counter (so ids stay unique even within the same tick).
pub fn new_collection_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("col-{nanos:x}-{seq:x}")
}

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

    /// Every tag known to the catalog, sorted by display name. Default: none.
    fn all_tags(&self) -> Vec<Tag> {
        Vec::new()
    }

    /// Tags assigned to one model, sorted by display name. Default: none.
    fn tags_for_model(&self, _hash: &str) -> Vec<Tag> {
        Vec::new()
    }

    /// Assign a (possibly new) tag to a model, creating the tag if needed.
    /// Returns the normalized tag, or `None` if the name was blank. Default:
    /// no-op returning `None`.
    fn add_model_tag(&mut self, _hash: &str, _name: &str) -> Option<Tag> {
        None
    }

    /// Remove a tag assignment from a model. Default: no-op.
    fn remove_model_tag(&mut self, _hash: &str, _tag_id: &str) {}

    /// Every collection known to the catalog, sorted by display name. Default:
    /// none.
    fn all_collections(&self) -> Vec<Collection> {
        Vec::new()
    }

    /// Collections a model belongs to, sorted by display name. Default: none.
    fn collections_for_model(&self, _hash: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// Create a new collection with the given display name, returning it. `None`
    /// if the name is blank. Default: no-op returning `None`.
    fn create_collection(&mut self, _name: &str) -> Option<Collection> {
        None
    }

    /// Delete a collection and all of its memberships. Default: no-op.
    fn delete_collection(&mut self, _id: &str) {}

    /// Add a model to a collection. Returns `true` if both exist and the
    /// membership now holds. Default: `false`.
    fn add_model_to_collection(&mut self, _id: &str, _hash: &str) -> bool {
        false
    }

    /// Remove a model from a collection. Default: no-op.
    fn remove_model_from_collection(&mut self, _id: &str, _hash: &str) {}
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
    // missing. Only meaningful when traversal completed without cancellation or
    // filesystem errors; otherwise unseen paths may still exist.
    if !scan.cancelled && scan.skipped_errors == 0 {
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
    /// Tag id -> display name.
    tags: HashMap<String, String>,
    /// Content hash -> assigned tag ids.
    model_tags: HashMap<ContentHash, std::collections::BTreeSet<String>>,
    /// Collection id -> (display name, shared_to_farm).
    collections: HashMap<String, (String, bool)>,
    /// Collection id -> member content hashes.
    collection_members: HashMap<String, std::collections::BTreeSet<ContentHash>>,
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

    fn all_tags(&self) -> Vec<Tag> {
        let mut out: Vec<Tag> = self
            .tags
            .iter()
            .map(|(id, name)| Tag {
                id: id.clone(),
                name: name.clone(),
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    fn tags_for_model(&self, hash: &str) -> Vec<Tag> {
        let Some(ids) = self.model_tags.get(hash) else {
            return Vec::new();
        };
        let mut out: Vec<Tag> = ids
            .iter()
            .filter_map(|id| {
                self.tags.get(id).map(|name| Tag {
                    id: id.clone(),
                    name: name.clone(),
                })
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    fn add_model_tag(&mut self, hash: &str, name: &str) -> Option<Tag> {
        // Only tag models the catalog actually knows about.
        if !self.models.contains_key(hash) {
            return None;
        }
        let tag = normalize_tag(name)?;
        self.tags.insert(tag.id.clone(), tag.name.clone());
        self.model_tags
            .entry(hash.to_string())
            .or_default()
            .insert(tag.id.clone());
        Some(tag)
    }

    fn remove_model_tag(&mut self, hash: &str, tag_id: &str) {
        if let Some(ids) = self.model_tags.get_mut(hash) {
            ids.remove(tag_id);
            if ids.is_empty() {
                self.model_tags.remove(hash);
            }
        }
        // Prune the tag entirely if no model references it anymore.
        let still_used = self.model_tags.values().any(|ids| ids.contains(tag_id));
        if !still_used {
            self.tags.remove(tag_id);
        }
    }

    fn all_collections(&self) -> Vec<Collection> {
        let mut out: Vec<Collection> = self
            .collections
            .iter()
            .map(|(id, (name, shared))| Collection {
                id: id.clone(),
                name: name.clone(),
                shared_to_farm: *shared,
                member_count: self
                    .collection_members
                    .get(id)
                    .map_or(0, std::collections::BTreeSet::len),
            })
            .collect();
        out.sort_by_key(|c| c.name.to_lowercase());
        out
    }

    fn collections_for_model(&self, hash: &str) -> Vec<Collection> {
        let mut out: Vec<Collection> = self
            .collections
            .iter()
            .filter(|(id, _)| {
                self.collection_members
                    .get(*id)
                    .is_some_and(|members| members.contains(hash))
            })
            .map(|(id, (name, shared))| Collection {
                id: id.clone(),
                name: name.clone(),
                shared_to_farm: *shared,
                member_count: self
                    .collection_members
                    .get(id)
                    .map_or(0, std::collections::BTreeSet::len),
            })
            .collect();
        out.sort_by_key(|c| c.name.to_lowercase());
        out
    }

    fn create_collection(&mut self, name: &str) -> Option<Collection> {
        let display = name.trim();
        if display.is_empty() {
            return None;
        }
        let id = new_collection_id();
        self.collections
            .insert(id.clone(), (display.to_string(), false));
        Some(Collection {
            id,
            name: display.to_string(),
            shared_to_farm: false,
            member_count: 0,
        })
    }

    fn delete_collection(&mut self, id: &str) {
        self.collections.remove(id);
        self.collection_members.remove(id);
    }

    fn add_model_to_collection(&mut self, id: &str, hash: &str) -> bool {
        if !self.collections.contains_key(id) || !self.models.contains_key(hash) {
            return false;
        }
        self.collection_members
            .entry(id.to_string())
            .or_default()
            .insert(hash.to_string());
        true
    }

    fn remove_model_from_collection(&mut self, id: &str, hash: &str) {
        if let Some(members) = self.collection_members.get_mut(id) {
            members.remove(hash);
            if members.is_empty() {
                self.collection_members.remove(id);
            }
        }
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

    #[test]
    fn scan_with_traversal_errors_does_not_mark_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"bytes");

        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));

        let incomplete = ScanResult {
            skipped_errors: 1,
            ..Default::default()
        };
        let report = reconcile_root(&mut store, "r", &incomplete);
        assert_eq!(report.missing, 0);
        assert!(store.models()[0].locations[0].available);
    }

    fn one_model_store() -> (InMemoryCatalog, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("m.stl"), b"bytes");
        let mut store = InMemoryCatalog::new();
        reconcile_root(&mut store, "r", &scan(root));
        let hash = store.models()[0].hash.clone();
        (store, hash)
    }

    #[test]
    fn tags_are_normalized_deduped_and_assigned() {
        let (mut store, hash) = one_model_store();

        let tag = store.add_model_tag(&hash, "  Miniatures ").unwrap();
        assert_eq!(tag.id, "miniatures");
        assert_eq!(tag.name, "Miniatures");

        // Different casing collapses to the same tag id.
        store.add_model_tag(&hash, "MINIATURES");
        assert_eq!(store.tags_for_model(&hash).len(), 1);
        assert_eq!(store.all_tags().len(), 1);

        // Blank names are rejected.
        assert!(store.add_model_tag(&hash, "   ").is_none());
        // Unknown models cannot be tagged.
        assert!(store.add_model_tag("nope", "x").is_none());
    }

    #[test]
    fn removing_the_last_assignment_prunes_the_tag() {
        let (mut store, hash) = one_model_store();
        let tag = store.add_model_tag(&hash, "wip").unwrap();
        assert_eq!(store.all_tags().len(), 1);

        store.remove_model_tag(&hash, &tag.id);
        assert!(store.tags_for_model(&hash).is_empty());
        assert!(store.all_tags().is_empty());
    }

    #[test]
    fn collections_track_membership_and_counts() {
        let (mut store, hash) = one_model_store();

        assert!(store.create_collection("  ").is_none());
        let coll = store.create_collection(" Dragons ").unwrap();
        assert_eq!(coll.name, "Dragons");
        assert_eq!(coll.member_count, 0);

        assert!(store.add_model_to_collection(&coll.id, &hash));
        // Unknown collection or model cannot form a membership.
        assert!(!store.add_model_to_collection("nope", &hash));
        assert!(!store.add_model_to_collection(&coll.id, "nope"));

        let for_model = store.collections_for_model(&hash);
        assert_eq!(for_model.len(), 1);
        assert_eq!(for_model[0].member_count, 1);

        store.remove_model_from_collection(&coll.id, &hash);
        assert!(store.collections_for_model(&hash).is_empty());
        // The collection itself survives losing its last member.
        assert_eq!(store.all_collections().len(), 1);

        store.delete_collection(&coll.id);
        assert!(store.all_collections().is_empty());
    }
}
