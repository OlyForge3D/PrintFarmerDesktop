//! Core domain types for the local model catalog.

use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Supported model file formats. Duplicate detection and parsing branch on
/// this. Determined purely from the file extension during scanning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelFormat {
    Stl,
    ThreeMf,
    Obj,
}

impl ModelFormat {
    /// Infer the format from a path's extension, case-insensitively. Returns
    /// `None` for files that are not recognized model files.
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "stl" => Some(Self::Stl),
            "3mf" => Some(Self::ThreeMf),
            "obj" => Some(Self::Obj),
            _ => None,
        }
    }

    /// Canonical lowercase extension for this format (without a dot).
    pub fn extension(self) -> &'static str {
        match self {
            Self::Stl => "stl",
            Self::ThreeMf => "3mf",
            Self::Obj => "obj",
        }
    }
}

/// A cheap identity fingerprint used to decide whether a file needs to be
/// re-hashed. Two files with the same size and modification time are assumed
/// unchanged; anything else is streamed through SHA-256 again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub size: u64,
    /// Modification time as whole seconds since the Unix epoch, when the
    /// platform reports one. Sub-second precision is intentionally dropped so
    /// fingerprints stay stable across filesystems with coarse timestamps.
    pub modified_unix_secs: Option<i64>,
}

impl FileFingerprint {
    pub fn new(size: u64, modified: Option<SystemTime>) -> Self {
        let modified_unix_secs = modified.and_then(|t| {
            t.duration_since(SystemTime::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
        });
        Self {
            size,
            modified_unix_secs,
        }
    }

    /// From standard filesystem metadata.
    pub fn from_metadata(meta: &std::fs::Metadata) -> Self {
        Self::new(meta.len(), meta.modified().ok())
    }
}
