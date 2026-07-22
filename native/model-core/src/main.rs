//! Entry point for the PrintFarmer Desktop sidecar binary.
//!
//! Default behavior is to serve the newline-delimited JSON-RPC protocol
//! ([`model_core::serve`]) over stdin/stdout, which is how the Electron main
//! process drives it. `--handshake`/`--version` prints the protocol and sidecar
//! versions on one line and exits, for a cheap liveness/compatibility probe.

use std::env;
use std::process::ExitCode;

use model_core::Handshake;

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
        eprintln!("usage: model-core [--serve | --handshake | --help]");
        eprintln!("  with no arguments, serves JSON-RPC over stdin/stdout");
        return ExitCode::SUCCESS;
    }

    // Default (and explicit `--serve`): run the framed RPC loop until stdin
    // closes. A transport I/O error is reported and exits non-zero so the main
    // process supervisor can restart the sidecar.
    match model_core::serve::run_stdio() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("model-core: sidecar transport error: {e}");
            ExitCode::FAILURE
        }
    }
}
