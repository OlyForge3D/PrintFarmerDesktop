//! Recursive, cancellable folder scanning.
//!
//! A scan walks a source root in place and yields the model files it finds
//! (STL/3MF) together with a cheap fingerprint. It never opens or hashes file
//! contents; hashing is a separate, more expensive step driven by
//! reconciliation. Unreadable entries are skipped rather than aborting the
//! whole scan, because network and removable roots routinely surface transient
//! errors.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::model::{FileFingerprint, ModelFormat};

/// A model file discovered during a scan, described without reading its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFile {
    /// Absolute path to the file on disk.
    pub path: PathBuf,
    /// Path relative to the scanned root, used as a stable display key.
    pub root_relative: PathBuf,
    pub format: ModelFormat,
    pub fingerprint: FileFingerprint,
}

/// Outcome of a scan. `cancelled` is set when the caller aborted early, in
/// which case `files` holds whatever was found before cancellation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanResult {
    pub files: Vec<DiscoveredFile>,
    pub cancelled: bool,
    /// Count of entries that could not be read (permission/IO errors).
    pub skipped_errors: usize,
}

/// Recursively scan `root` for model files. `cancel` is polled between entries
/// so long scans of large trees can be stopped promptly.
pub fn scan_root(root: &Path, cancel: &AtomicBool) -> ScanResult {
    let mut result = ScanResult::default();

    for entry in WalkDir::new(root).follow_links(false) {
        if cancel.load(Ordering::Relaxed) {
            result.cancelled = true;
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                result.skipped_errors += 1;
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let Some(format) = ModelFormat::from_path(path) else {
            continue;
        };

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                result.skipped_errors += 1;
                continue;
            }
        };

        let root_relative = path
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| path.to_path_buf());

        result.files.push(DiscoveredFile {
            path: path.to_path_buf(),
            root_relative,
            format,
            fingerprint: FileFingerprint::from_metadata(&metadata),
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn finds_model_files_and_ignores_others() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"solid");
        write(&root.join("nested/b.3mf"), b"zip");
        write(&root.join("nested/readme.txt"), b"ignore me");
        write(&root.join("c.STL"), b"upper ext");

        let result = scan_root(root, &AtomicBool::new(false));

        let mut names: Vec<String> = result
            .files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.stl", "b.3mf", "c.STL"]);
        assert!(!result.cancelled);
    }

    #[test]
    fn root_relative_paths_are_relative_to_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("sub/deep/model.stl"), b"x");

        let result = scan_root(root, &AtomicBool::new(false));
        assert_eq!(result.files.len(), 1);
        assert_eq!(
            result.files[0].root_relative,
            Path::new("sub").join("deep").join("model.stl")
        );
    }

    #[test]
    fn cancellation_stops_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.stl"), b"x");

        let result = scan_root(root, &AtomicBool::new(true));
        assert!(result.cancelled);
        assert!(result.files.is_empty());
    }
}
