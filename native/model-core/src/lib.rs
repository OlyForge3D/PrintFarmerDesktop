//! Core library for the PrintFarmer Desktop sidecar.
//!
//! This process owns the on-disk catalog (SQLite/WAL), folder scanning and
//! watching, streaming SHA-256 hashing, and STL/3MF parsing. It communicates
//! with the Electron main process over a framed, versioned RPC protocol on a
//! private transport. Only the version/handshake surface exists so far.

pub mod cache;
pub mod catalog;
pub mod geometry;
pub mod hash;
pub mod limits;
pub mod model;
pub mod obj;
pub mod retarget;
pub mod rpc;
pub mod scan;
pub mod scene;
pub mod scene_status;
pub mod schema;
pub mod serve;
pub mod smart_import;
#[cfg(feature = "sqlite")]
pub mod sqlite_catalog;
#[cfg(feature = "step")]
pub mod step;
pub mod stl;
pub mod sync;
pub mod threemf;
#[cfg(feature = "lib3mf")]
mod threemf_lib3mf;
pub mod thumbnail;
pub mod vendor;
pub mod watch;

/// Version of the RPC protocol spoken by this sidecar. Bumped on any
/// breaking change to the framing or message envelope.
pub const RPC_PROTOCOL_VERSION: u32 = 1;

/// Semantic version of the sidecar binary, sourced from Cargo at build time.
pub fn sidecar_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A minimal handshake payload the main process can use to confirm the sidecar
/// launched and speaks a compatible protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub protocol_version: u32,
    pub sidecar_version: &'static str,
}

impl Handshake {
    pub fn current() -> Self {
        Self {
            protocol_version: RPC_PROTOCOL_VERSION,
            sidecar_version: sidecar_version(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_reports_current_protocol() {
        let handshake = Handshake::current();
        assert_eq!(handshake.protocol_version, RPC_PROTOCOL_VERSION);
        assert!(!handshake.sidecar_version.is_empty());
    }

    #[test]
    fn version_matches_cargo() {
        assert_eq!(sidecar_version(), env!("CARGO_PKG_VERSION"));
    }
}
