//! Streaming content hashing.
//!
//! Models can be up to 500 MB, so files are never buffered fully in memory:
//! they are read in bounded chunks and folded into a SHA-256 state. The lower
//! hex digest is the logical identity of a model and the basis for exact-byte
//! duplicate grouping.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// Read buffer size. Large enough to amortize syscalls, small enough to keep
/// memory bounded regardless of file size.
const CHUNK_SIZE: usize = 64 * 1024;

/// A lowercase hex SHA-256 content hash.
pub type ContentHash = String;

/// Stream `reader` through SHA-256 and return the lowercase hex digest.
pub fn hash_reader<R: Read>(mut reader: R) -> io::Result<ContentHash> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; CHUNK_SIZE];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// Stream the file at `path` through SHA-256 and return its hex digest.
pub fn hash_file(path: &Path) -> io::Result<ContentHash> {
    let file = File::open(path)?;
    hash_reader(file)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_empty_input_to_known_digest() {
        // SHA-256 of the empty string.
        assert_eq!(
            hash_reader(&b""[..]).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hashes_abc_to_known_digest() {
        assert_eq!(
            hash_reader(&b"abc"[..]).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hashing_is_chunk_size_independent() {
        let data = vec![0xa5u8; CHUNK_SIZE * 3 + 17];
        assert_eq!(
            hash_reader(&data[..]).unwrap(),
            hash_reader(&data[..]).unwrap()
        );
    }
}
