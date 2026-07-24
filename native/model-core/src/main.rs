//! Entry point for the PrintFarmer Desktop sidecar binary.
//!
//! Default behavior is to serve the newline-delimited JSON-RPC protocol
//! ([`model_core::serve`]) over stdin/stdout, which is how the Electron main
//! process drives it. `--handshake`/`--version` prints the protocol and sidecar
//! versions on one line and exits, for a cheap liveness/compatibility probe.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use model_core::Handshake;

/// Parse `--catalog-db <path>` (or `--catalog-db=<path>`) from the argument
/// list, if present. Selects the persistent SQLite catalog for the serve loop.
fn parse_catalog_db(args: &[String]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(rest) = arg.strip_prefix("--catalog-db=") {
            return Some(PathBuf::from(rest));
        }
        if arg == "--catalog-db" {
            return iter.next().map(PathBuf::from);
        }
    }
    None
}

fn parse_target_profiles_dir(args: &[String]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(rest) = arg.strip_prefix("--target-profiles-dir=") {
            return Some(PathBuf::from(rest));
        }
        if arg == "--target-profiles-dir" {
            return iter.next().map(PathBuf::from);
        }
    }
    None
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.iter().any(|a| a == "--handshake" || a == "--version") {
        let handshake = Handshake::current();
        println!(
            "{{\"protocolVersion\":{},\"sidecarVersion\":\"{}\"}}",
            handshake.protocol_version, handshake.sidecar_version
        );
        return ExitCode::SUCCESS;
    }

    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!(
            "model-core {} (rpc protocol v{})",
            model_core::sidecar_version(),
            model_core::RPC_PROTOCOL_VERSION
        );
        eprintln!("usage: model-core [--serve | --handshake | --help] [--catalog-db <path>] [--target-profiles-dir <path>]");
        eprintln!("  with no arguments, serves JSON-RPC over stdin/stdout");
        eprintln!("  --catalog-db <path>  persist the model catalog at <path> (requires sqlite)");
        eprintln!("  --target-profiles-dir <path>  enable native U1 retarget methods");
        return ExitCode::SUCCESS;
    }

    // Default (and explicit `--serve`): run the framed RPC loop until stdin
    // closes. A transport I/O error is reported and exits non-zero so the main
    // process supervisor can restart the sidecar.
    let db_path = parse_catalog_db(&args);
    let target_profiles_dir = parse_target_profiles_dir(&args);
    match model_core::serve::run_stdio_with_retarget(db_path, target_profiles_dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("model-core: sidecar transport error: {e}");
            ExitCode::FAILURE
        }
    }
}
