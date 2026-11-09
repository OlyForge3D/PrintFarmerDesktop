//! Recursive, cancellable folder scanning.
//!
//! A scan walks a source root in place and yields the model files it finds
//! (STL/3MF/OBJ/STEP) together with a cheap fingerprint. It never opens or hashes file
//! contents (ZIP central directories only); hashing is a separate, more expensive step driven by
//! reconciliation. Unreadable entries are skipped rather than aborting the
//! whole scan, because network and removable roots routinely surface transient
//! errors.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::model::{FileFingerprint, ModelFormat};

pub const MAX_SCAN_ISSUES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanIssueReason {
    CloudOnly,
    PermissionDenied,
    Unreadable,
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanEntryKind {
    File,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub path: String,
    pub kind: ScanEntryKind,
    pub reason: ScanIssueReason,
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntryCounts {
    pub cloud_only: usize,
    pub permission_denied: usize,
    pub unreadable: usize,
    pub too_large: usize,
}

/// A model file discovered during a scan, described without reading its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFile {
    /// Absolute filesystem path or ZIP member locator.
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
    pub cloud_files: Vec<PathBuf>,
    pub cloud_directories: Vec<PathBuf>,
    /// Paths that could not be inspected; preserve existing locations beneath them.
    pub failed_paths: Vec<PathBuf>,
    pub skipped_entries: SkippedEntryCounts,
    pub scan_issues: Vec<ScanIssue>,
    pub scan_issues_truncated: bool,
    /// A systemic failure that prevents scanning safely without downloads.
    pub failure: Option<String>,
    /// Expected policy skips, not filesystem failures or incomplete traversal.
    pub archive_warnings: Vec<String>,
}

impl ScanResult {
    pub(crate) fn issue(
        &mut self,
        path: &Path,
        kind: ScanEntryKind,
        reason: ScanIssueReason,
        detail: String,
    ) {
        match reason {
            ScanIssueReason::CloudOnly => self.skipped_entries.cloud_only += 1,
            ScanIssueReason::PermissionDenied => self.skipped_entries.permission_denied += 1,
            ScanIssueReason::Unreadable => self.skipped_entries.unreadable += 1,
            ScanIssueReason::TooLarge => self.skipped_entries.too_large += 1,
        }
        if self.scan_issues.len() < MAX_SCAN_ISSUES {
            self.scan_issues.push(ScanIssue {
                path: path.to_string_lossy().into_owned(),
                kind,
                reason,
                detail,
                size_bytes: None,
                limit_bytes: None,
            });
        } else {
            self.scan_issues_truncated = true;
        }
    }

    pub(crate) fn cloud_skip(&mut self, path: &Path, directory: bool) {
        let paths = if directory {
            &mut self.cloud_directories
        } else {
            &mut self.cloud_files
        };
        if paths.iter().any(|existing| existing == path) {
            return;
        }
        paths.push(path.to_path_buf());
        self.issue(
            path,
            if directory {
                ScanEntryKind::Folder
            } else {
                ScanEntryKind::File
            },
            ScanIssueReason::CloudOnly,
            "Content is stored in the cloud and is not available locally.".into(),
        );
    }

    fn entry_error(&mut self, path: &Path, directory: bool, error: &std::io::Error) {
        eprintln!("failed to inspect {}: {error}", path.display());
        self.skipped_errors += 1;
        self.failed_paths.push(path.to_path_buf());
        self.issue(
            path,
            if directory {
                ScanEntryKind::Folder
            } else {
                ScanEntryKind::File
            },
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                ScanIssueReason::PermissionDenied
            } else {
                ScanIssueReason::Unreadable
            },
            error.to_string(),
        );
    }
}

/// Recursively scan `root` for model files. `cancel` is polled between entries
/// so long scans of large trees can be stopped promptly.
pub fn scan_root(root: &Path, cancel: &AtomicBool) -> ScanResult {
    let mut result = ScanResult::default();
    let protected = crate::file_availability::without_materialization(|| {
        result = scan_root_with_metadata(root, cancel, |path| {
            let metadata = std::fs::symlink_metadata(path)?;
            let cloud_only = crate::file_availability::is_cloud_only(&metadata);
            Ok((metadata, cloud_only))
        });
        Ok(())
    });
    if let Err(error) = protected {
        eprintln!(
            "failed to scan {} without downloading files: {error}",
            root.display()
        );
        result.skipped_errors += 1;
        result.failure = Some(error.to_string());
        result.failed_paths.push(root.to_path_buf());
    }
    result
}

pub(crate) fn scan_root_with_metadata(
    root: &Path,
    cancel: &AtomicBool,
    mut metadata_for: impl FnMut(&Path) -> std::io::Result<(std::fs::Metadata, bool)>,
) -> ScanResult {
    let mut result = ScanResult::default();
    let mut entries = WalkDir::new(root).follow_links(false).into_iter();

    while let Some(entry) = entries.next() {
        if cancel.load(Ordering::Relaxed) {
            result.cancelled = true;
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(error) => {
                if error
                    .io_error()
                    .is_some_and(crate::file_availability::is_cloud_error)
                {
                    if let Some(path) = error.path() {
                        result.cloud_skip(path, true);
                    } else {
                        result.entry_error(root, true, &std::io::Error::other(error.to_string()));
                    }
                } else {
                    let path = error.path().unwrap_or(root);
                    match error.io_error() {
                        Some(io_error) => result.entry_error(path, true, io_error),
                        None => result.entry_error(
                            path,
                            true,
                            &std::io::Error::other(error.to_string()),
                        ),
                    }
                }
                continue;
            }
        };

        let directory = entry.file_type().is_dir();
        if !directory && !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let format = ModelFormat::from_path(path);
        if !directory && format.is_none() && !crate::archive::is_zip(path) {
            continue;
        }

        let metadata = match metadata_for(path) {
            Ok((_, true)) => {
                if directory {
                    entries.skip_current_dir();
                }
                result.cloud_skip(path, directory);
                continue;
            }
            Ok((metadata, false)) => metadata,
            Err(error) => {
                if directory {
                    entries.skip_current_dir();
                }
                if crate::file_availability::is_cloud_error(&error) {
                    result.cloud_skip(path, directory);
                } else {
                    result.entry_error(path, directory, &error);
                }
                continue;
            }
        };
        if directory {
            continue;
        }

        let root_relative = path
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| path.to_path_buf());

        if crate::archive::is_zip(path) {
            if let Some(warning) = crate::archive::size_warning(path, metadata.len()) {
                eprintln!("{warning}");
                result.failed_paths.push(path.to_path_buf());
                let index = result.scan_issues.len();
                result.issue(
                    path,
                    ScanEntryKind::File,
                    ScanIssueReason::TooLarge,
                    warning.clone(),
                );
                if let Some(issue) = result.scan_issues.get_mut(index) {
                    issue.size_bytes = Some(metadata.len());
                    issue.limit_bytes = Some(crate::archive::MAX_ARCHIVE_BYTES);
                }
                if result.archive_warnings.len() < MAX_SCAN_ISSUES {
                    result.archive_warnings.push(warning);
                }
                continue;
            }
            match crate::archive::discover(path, &root_relative, &metadata, cancel) {
                Ok(files) => result.files.extend(files),
                Err(error) => {
                    if crate::file_availability::is_cloud_error(&error) {
                        result.cloud_skip(path, false);
                        continue;
                    }
                    result.entry_error(path, false, &error);
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        result.cancelled = true;
                        break;
                    }
                }
            }
            continue;
        }
        result.files.push(DiscoveredFile {
            path: path.to_path_buf(),
            root_relative,
            format: format.expect("model format checked above"),
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
        write(&root.join("nested/c.step"), b"step");
        write(&root.join("nested/readme.txt"), b"ignore me");
        write(&root.join("c.STL"), b"upper ext");

        let result = scan_root(root, &AtomicBool::new(false));

        let mut names: Vec<String> = result
            .files
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.stl", "b.3mf", "c.STL", "c.step"]);
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

    #[test]
    fn mixed_cloud_models_and_archives_are_skipped_before_content_reads() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["local.stl", "cloud.stl", "cloud.zip", "empty.obj"] {
            write(&dir.path().join(name), b"");
        }
        let result = scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
            let cloud = path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cloud");
            Ok((fs::symlink_metadata(path)?, cloud))
        });
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.cloud_files.len(), 2);
        // The invalid ZIP would fail if discovery tried to open its contents.
        assert_eq!(result.skipped_errors, 0);
    }

    #[test]
    fn cloud_directories_are_not_descended_into() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("cloud/hidden.stl"), b"hidden");
        write(&dir.path().join("local.stl"), b"local");
        let result = scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
            assert_ne!(path.file_name().unwrap(), "hidden.stl");
            Ok((fs::symlink_metadata(path)?, path.ends_with("cloud")))
        });
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.cloud_directories, vec![dir.path().join("cloud")]);
    }

    #[test]
    fn individual_metadata_failure_does_not_hide_local_files() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("denied.stl"), b"denied");
        write(&dir.path().join("local.stl"), b"local");
        let result = scan_root_with_metadata(dir.path(), &AtomicBool::new(false), |path| {
            if path.ends_with("denied.stl") {
                return Err(std::io::ErrorKind::PermissionDenied.into());
            }
            Ok((fs::symlink_metadata(path)?, false))
        });
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.skipped_errors, 1);
        assert_eq!(result.skipped_entries.permission_denied, 1);
        assert!(result.cloud_files.is_empty());
    }

    #[test]
    fn details_are_bounded_but_counts_and_failed_path_protection_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut result = ScanResult::default();
        for index in 0..MAX_SCAN_ISSUES + 3 {
            result.entry_error(
                &dir.path().join(format!("folder-{index}")),
                true,
                &std::io::ErrorKind::PermissionDenied.into(),
            );
        }
        assert_eq!(result.scan_issues.len(), MAX_SCAN_ISSUES);
        assert!(result.scan_issues_truncated);
        assert_eq!(
            result.skipped_entries.permission_denied,
            MAX_SCAN_ISSUES + 3
        );
        assert_eq!(result.failed_paths.len(), MAX_SCAN_ISSUES + 3);
    }
}
