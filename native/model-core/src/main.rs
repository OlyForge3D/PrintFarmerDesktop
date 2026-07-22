//! Entry point for the PrintFarmer Desktop sidecar binary.
//!
//! For now it supports a `--handshake` flag that prints the protocol and
//! sidecar versions as a single JSON-ish line. The framed RPC loop over stdio
//! will be added alongside the catalog engine.

use std::env;

use model_core::Handshake;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.iter().any(|a| a == "--handshake" || a == "--version") {
        let handshake = Handshake::current();
        println!(
            "{{\"protocolVersion\":{},\"sidecarVersion\":\"{}\"}}",
            handshake.protocol_version, handshake.sidecar_version
        );
        return;
    }

    eprintln!(
        "model-core {} (rpc protocol v{}) — no RPC transport wired yet",
        model_core::sidecar_version(),
        model_core::RPC_PROTOCOL_VERSION
    );
    eprintln!("usage: model-core --handshake");
}
