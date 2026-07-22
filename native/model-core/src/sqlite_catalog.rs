//! Persistent SQLite-backed [`CatalogStore`].
//!
//! This is the authoritative on-disk catalog: logical models keyed by content
//! hash, their physical locations, and duplicate grouping, all in a WAL-mode
//! SQLite database using the schema in [`crate::schema`]. It is compiled only
//! when the `sqlite` feature is enabled, because the bundled SQLite driver
//! requires a C toolchain. The pure-Rust [`crate::catalog::InMemoryCatalog`]
//! mirrors the same semantics for toolchain-free development and is the
//! reference implementation these two stores are tested against.
//!
//! The [`CatalogStore`] trait is infallible by design (mirroring the in-memory
//! store), so genuine SQL faults on writes are treated as bugs and panic;
//! read paths degrade to empty results. A fallible store API is future work.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::catalog::{CatalogStore, LocationUpsert, LogicalModel, ModelLocation, StoredLocation};
use crate::model::{FileFingerprint, ModelFormat};
use crate::schema::{SCHEMA_V1, SCHEMA_VERSION};

/// A SQLite-backed catalog. Wraps one connection; use single-threaded per the
/// [`CatalogStore`] contract (reconciliation is sequential).
pub struct SqliteCatalog {
    conn: Connection,
}

impl SqliteCatalog {
    /// Open (or create) a catalog database at `path`, applying migrations.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// Open an ephemeral in-memory catalog, applying migrations. Used in tests.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        // WAL and FK enforcement are per-connection and must run outside a
        // transaction, so apply them before any migration.
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version < SCHEMA_VERSION {
            conn.execute_batch(SCHEMA_V1)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(Self { conn })
    }

    /// Record (or update the path of) a source root. The [`CatalogStore`] trait
    /// carries only a `root_id`, so [`Self::upsert_location`] auto-creates a
    /// placeholder root row; call this to store the real absolute path.
    pub fn ensure_root(&self, root_id: &str, path: &Path) {
        let now = now_ts();
        self.conn
            .execute(
                "INSERT INTO source_roots(id, path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at",
                params![root_id, path_to_str(path), now],
            )
            .expect("catalog write failed: ensure_root");
    }

    fn build_model(&self, hash: &str) -> Option<LogicalModel> {
        let (format, size): (String, i64) = self
            .conn
            .query_row(
                "SELECT format, size_bytes FROM models WHERE hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("catalog read failed: model")?;

        let mut stmt = self
            .conn
            .prepare(
                "SELECT root_id, path, root_relative, size_bytes, modified_unix_secs, available
                 FROM model_locations WHERE model_hash = ?1 ORDER BY path",
            )
            .expect("catalog read failed: locations prepare");
        let locations = stmt
            .query_map(params![hash], |row| {
                let size_bytes: i64 = row.get(3)?;
                let modified: Option<i64> = row.get(4)?;
                let available: i64 = row.get(5)?;
                let path: String = row.get(1)?;
                let root_relative: String = row.get(2)?;
                Ok(ModelLocation {
                    root_id: row.get(0)?,
                    path: PathBuf::from(path),
                    root_relative: PathBuf::from(root_relative),
                    fingerprint: FileFingerprint {
                        size: size_bytes as u64,
                        modified_unix_secs: modified,
                    },
                    available: available != 0,
                })
            })
            .expect("catalog read failed: locations query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("catalog read failed: locations collect");

        Some(LogicalModel {
            hash: hash.to_string(),
            format: format_from_db(&format),
            size: size as u64,
            locations,
        })
    }
}

impl CatalogStore for SqliteCatalog {
    fn get_location(&self, root_id: &str, path: &Path) -> Option<StoredLocation> {
        self.conn
            .query_row(
                "SELECT model_hash, size_bytes, modified_unix_secs, available
                 FROM model_locations WHERE root_id = ?1 AND path = ?2",
                params![root_id, path_to_str(path)],
                |row| {
                    let size_bytes: i64 = row.get(1)?;
                    let modified: Option<i64> = row.get(2)?;
                    let available: i64 = row.get(3)?;
                    Ok(StoredLocation {
                        hash: row.get(0)?,
                        fingerprint: FileFingerprint {
                            size: size_bytes as u64,
                            modified_unix_secs: modified,
                        },
                        available: available != 0,
                    })
                },
            )
            .optional()
            .expect("catalog read failed: get_location")
    }

    fn upsert_location(&mut self, upsert: LocationUpsert) {
        let now = now_ts();
        let prev_hash = self
            .get_location(&upsert.root_id, &upsert.path)
            .map(|s| s.hash);

        // Ensure the referenced root and model rows exist so the foreign keys
        // hold. A location's root may not have been registered with its real
        // path yet; seed a placeholder that ensure_root can later correct.
        self.conn
            .execute(
                "INSERT OR IGNORE INTO source_roots(id, path, created_at, updated_at)
                 VALUES (?1, ?1, ?2, ?2)",
                params![upsert.root_id, now],
            )
            .expect("catalog write failed: seed root");
        self.conn
            .execute(
                "INSERT OR IGNORE INTO models(hash, format, size_bytes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![
                    upsert.hash,
                    format_to_db(upsert.format),
                    upsert.size as i64,
                    now
                ],
            )
            .expect("catalog write failed: insert model");

        self.conn
            .execute(
                "INSERT INTO model_locations(
                     root_id, path, root_relative, model_hash,
                     size_bytes, modified_unix_secs, available, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
                 ON CONFLICT(root_id, path) DO UPDATE SET
                     root_relative = excluded.root_relative,
                     model_hash = excluded.model_hash,
                     size_bytes = excluded.size_bytes,
                     modified_unix_secs = excluded.modified_unix_secs,
                     available = 1,
                     last_seen_at = excluded.last_seen_at",
                params![
                    upsert.root_id,
                    path_to_str(&upsert.path),
                    path_to_str(&upsert.root_relative),
                    upsert.hash,
                    upsert.fingerprint.size as i64,
                    upsert.fingerprint.modified_unix_secs,
                    now,
                ],
            )
            .expect("catalog write failed: upsert location");

        // If the location moved to a different model, drop the old model when it
        // has no remaining locations, matching the in-memory store's behavior.
        if let Some(prev) = prev_hash {
            if prev != upsert.hash {
                self.conn
                    .execute(
                        "DELETE FROM models WHERE hash = ?1
                         AND NOT EXISTS (SELECT 1 FROM model_locations WHERE model_hash = ?1)",
                        params![prev],
                    )
                    .expect("catalog write failed: prune orphan model");
            }
        }
    }

    fn set_available(&mut self, root_id: &str, path: &Path, available: bool) {
        self.conn
            .execute(
                "UPDATE model_locations SET available = ?3 WHERE root_id = ?1 AND path = ?2",
                params![root_id, path_to_str(path), i64::from(available)],
            )
            .expect("catalog write failed: set_available");
    }

    fn paths_for_root(&self, root_id: &str) -> Vec<PathBuf> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM model_locations WHERE root_id = ?1")
            .expect("catalog read failed: paths_for_root prepare");
        stmt.query_map(params![root_id], |row| {
            let path: String = row.get(0)?;
            Ok(PathBuf::from(path))
        })
        .expect("catalog read failed: paths_for_root query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("catalog read failed: paths_for_root collect")
    }

    fn model(&self, hash: &str) -> Option<LogicalModel> {
        self.build_model(hash)
    }

    fn models(&self) -> Vec<LogicalModel> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash FROM models ORDER BY hash")
            .expect("catalog read failed: models prepare");
        let hashes: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("catalog read failed: models query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("catalog read failed: models collect");
        hashes
            .into_iter()
            .filter_map(|h| self.build_model(&h))
            .collect()
    }
}

/// Whole seconds since the Unix epoch, as text, for `*_at` columns.
fn now_ts() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn path_to_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Persisted form of a format, matching the enum's camelCase serde names.
fn format_to_db(format: ModelFormat) -> &'static str {
    match format {
        ModelFormat::Stl => "stl",
        ModelFormat::ThreeMf => "threeMf",
    }
}

fn format_from_db(value: &str) -> ModelFormat {
    match value {
        "threeMf" => ModelFormat::ThreeMf,
        _ => ModelFormat::Stl,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::reconcile_root;
    use crate::scan::scan_root;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn scan(root: &Path) -> crate::scan::ScanResult {
        scan_root(root, &AtomicBool::new(false))
    }

    #[test]
    fn migration_sets_the_schema_version() {
        let store = SqliteCatalog::open_in_memory().unwrap();
        let version: u32 = store
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn opening_twice_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("catalog.db");
        {
            let mut store = SqliteCatalog::open(&db).unwrap();
            store.upsert_location(LocationUpsert {
                hash: "h".into(),
                format: ModelFormat::Stl,
                size: 3,
                root_id: "r".into(),
                path: PathBuf::from("/root/a.stl"),
                root_relative: PathBuf::from("a.stl"),
                fingerprint: FileFingerprint {
                    size: 3,
                    modified_unix_secs: Some(1),
                },
            });
        }
        // Reopening the same file must find the migration already applied and
        // the previously written model intact.
        let store = SqliteCatalog::open(&db).unwrap();
        assert_eq!(store.models().len(), 1);
        assert_eq!(store.model("h").unwrap().locations.len(), 1);
    }

    #[test]
    fn identical_bytes_across_paths_form_one_duplicate_group() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"same-bytes");
        write(&root.join("nested/copy.stl"), b"same-bytes");
        write(&root.join("other.stl"), b"different");

        let mut store = SqliteCatalog::open_in_memory().unwrap();
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

        let mut store = SqliteCatalog::open_in_memory().unwrap();
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

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));
        let first_hash = store.models()[0].hash.clone();

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

        let mut store = SqliteCatalog::open_in_memory().unwrap();
        reconcile_root(&mut store, "r", &scan(root));

        fs::remove_file(&file).unwrap();
        let report = reconcile_root(&mut store, "r", &scan(root));

        assert_eq!(report.missing, 1);
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert!(!models[0].locations[0].available);
    }

    #[test]
    fn ensure_root_stores_the_absolute_path() {
        let store = SqliteCatalog::open_in_memory().unwrap();
        store.ensure_root("r", Path::new("/models/root"));
        let path: String = store
            .conn
            .query_row("SELECT path FROM source_roots WHERE id = 'r'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(path, "/models/root");
    }
}
