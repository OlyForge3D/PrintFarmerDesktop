//! Seekable ZIP model sources. Catalog paths are locators, never filesystem paths.

use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::hash::{hash_reader, ContentHash};
use crate::limits::ParseGuard;
use crate::model::{FileFingerprint, ModelFormat};
use crate::scan::DiscoveredFile;

pub const MARKER: &str = "::zip::";
pub const MAX_ARCHIVE_ENTRIES: usize = 100_000;
pub const MAX_MEMBER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_INDEXED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

pub fn requires_content_revalidation(path: &Path) -> bool {
    cfg!(not(unix)) && member_source(path).is_ok_and(|source| source.is_some())
}

fn change_revision(metadata: &Metadata) -> Option<(i64, i64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.ctime(), metadata.ctime_nsec()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

pub fn is_zip(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberSource {
    pub archive: PathBuf,
    pub index: usize,
    pub name: String,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 2048
        && !name.contains(['\\', '\0', ':'])
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

pub fn member_source(path: &Path) -> io::Result<Option<MemberSource>> {
    let components: Vec<_> = path.components().collect();
    let Some(marker) = components
        .iter()
        .position(|part| part.as_os_str() == MARKER)
    else {
        return Ok(None);
    };
    let archive: PathBuf = components[..marker].iter().collect();
    if !is_zip(&archive) {
        return Err(invalid("ZIP member locator must name a .zip archive"));
    }
    let index = components
        .get(marker + 1)
        .and_then(|part| part.as_os_str().to_str())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| invalid("invalid ZIP member index"))?;
    let name = components
        .get(marker + 2..)
        .ok_or_else(|| invalid("missing ZIP member name"))?
        .iter()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or_else(|| invalid("invalid ZIP member name"))
        })
        .collect::<io::Result<Vec<_>>>()?
        .join("/");
    if !valid_name(&name) {
        return Err(invalid("unsafe ZIP member name"));
    }
    Ok(Some(MemberSource {
        archive,
        index,
        name,
    }))
}

pub fn locator(archive: &Path, index: usize, name: &str) -> PathBuf {
    archive.join(MARKER).join(index.to_string()).join(name)
}

struct ArchiveFile {
    file: File,
    directory_reading: Arc<AtomicBool>,
    remaining: u64,
}

impl Read for ArchiveFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let limited = self.directory_reading.load(Ordering::Relaxed);
        if limited && self.remaining == 0 {
            return Err(invalid("ZIP directory reads exceeded the memory budget"));
        }
        let cap = if limited {
            buffer.len().min(self.remaining as usize)
        } else {
            buffer.len()
        };
        let read = self.file.read(&mut buffer[..cap])?;
        if limited {
            self.remaining -= read as u64;
        }
        Ok(read)
    }
}

impl std::io::Seek for ArchiveFile {
    fn seek(&mut self, position: std::io::SeekFrom) -> io::Result<u64> {
        std::io::Seek::seek(&mut self.file, position)
    }
}

fn open_archive(path: &Path) -> io::Result<zip::ZipArchive<ArchiveFile>> {
    let file = File::open(path)?;
    // The ZIP library bounds neither central-directory allocation nor entry
    // count before parsing. Check the EOCD (including ZIP64) first.
    let (entries, directory_bytes) = directory_bounds(&file)?;
    if entries > MAX_ARCHIVE_ENTRIES as u64 || directory_bytes > MAX_CENTRAL_DIRECTORY_BYTES {
        return Err(invalid("ZIP central directory exceeds indexing limits"));
    }
    let directory_reading = Arc::new(AtomicBool::new(true));
    let reader = ArchiveFile {
        file,
        directory_reading: directory_reading.clone(),
        remaining: MAX_CENTRAL_DIRECTORY_BYTES + 65_557,
    };
    let archive = zip::ZipArchive::new(reader).map_err(invalid_zip)?;
    directory_reading.store(false, Ordering::Relaxed);
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(invalid("ZIP entry count exceeds indexing limit"));
    }
    Ok(archive)
}

fn invalid_zip(error: zip::result::ZipError) -> io::Error {
    invalid(format!("ZIP source error: {error}"))
}

fn directory_bounds(mut file: &File) -> io::Result<(u64, u64)> {
    use std::io::{Seek, SeekFrom};
    let length = file.metadata()?.len();
    let tail_size = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_size as i64)))?;
    let mut tail = vec![0; tail_size];
    file.read_exact(&mut tail)?;
    let offset = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&offset| {
            tail[offset..offset + 4] == *b"PK\x05\x06"
                && offset + 22 + u16::from_le_bytes([tail[offset + 20], tail[offset + 21]]) as usize
                    == tail.len()
        })
        .ok_or_else(|| invalid("ZIP end-of-directory record is missing"))?;
    let u16_at = |start| u16::from_le_bytes(tail[start..start + 2].try_into().unwrap());
    let u32_at = |start| u32::from_le_bytes(tail[start..start + 4].try_into().unwrap());
    if u16_at(offset + 4) != 0 || u16_at(offset + 6) != 0 {
        return Err(invalid("multi-disk ZIP archives are unsupported"));
    }
    let entries = u16_at(offset + 10);
    let bytes = u32_at(offset + 12);
    if entries != u16::MAX && bytes != u32::MAX {
        return Ok((entries as u64, bytes as u64));
    }
    let eocd_position = length - tail_size as u64 + offset as u64;
    if eocd_position < 20 {
        return Err(invalid("ZIP64 locator is missing"));
    }
    file.seek(SeekFrom::Start(eocd_position - 20))?;
    let mut locator = [0; 20];
    file.read_exact(&mut locator)?;
    if locator[..4] != *b"PK\x06\x07"
        || locator[4..8] != [0; 4]
        || locator[16..20] != 1u32.to_le_bytes()
    {
        return Err(invalid("invalid or multi-disk ZIP64 locator"));
    }
    file.seek(SeekFrom::Start(u64::from_le_bytes(
        locator[8..16].try_into().unwrap(),
    )))?;
    let mut record = [0; 56];
    file.read_exact(&mut record)?;
    if record[..4] != *b"PK\x06\x06" || record[16..24] != [0; 8] {
        return Err(invalid("invalid ZIP64 directory"));
    }
    Ok((
        u64::from_le_bytes(record[32..40].try_into().unwrap()),
        u64::from_le_bytes(record[40..48].try_into().unwrap()),
    ))
}

fn validate_entry(entry: &zip::read::ZipFile<'_>, guard: &ParseGuard) -> io::Result<()> {
    if entry.encrypted() || entry.is_symlink() || !valid_name(entry.name()) {
        return Err(invalid("encrypted, symlink or unsafe ZIP model member"));
    }
    if entry.size() > MAX_MEMBER_BYTES {
        return Err(invalid("ZIP model member exceeds the 512 MiB limit"));
    }
    guard
        .check_ratio(entry.name(), entry.compressed_size(), entry.size())
        .map_err(|error| invalid(error.to_string()))
}

pub fn discover(
    path: &Path,
    relative: &Path,
    metadata: &Metadata,
    cancel: &AtomicBool,
) -> io::Result<Vec<DiscoveredFile>> {
    let mut archive = open_archive(path)?;
    let guard = ParseGuard::default();
    let mut total = 0u64;
    let mut files = Vec::new();
    let modified = metadata.modified().ok();
    for index in 0..archive.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "ZIP scan cancelled",
            ));
        }
        let entry = archive.by_index_raw(index).map_err(invalid_zip)?;
        let Some(format) = ModelFormat::from_path(Path::new(entry.name())) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        validate_entry(&entry, &guard)?;
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| invalid("ZIP expansion overflow"))?;
        if total > MAX_INDEXED_BYTES {
            return Err(invalid(
                "ZIP model members exceed the 8 GiB indexing budget",
            ));
        }
        let mut fingerprint = FileFingerprint::new(entry.size(), modified);
        fingerprint.source_revision = Some(format!(
            "{}:{:?}:{:?}:{}:{}:{}",
            metadata.len(),
            modified
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_nanos()),
            change_revision(metadata),
            entry.crc32(),
            entry.compressed_size(),
            entry.header_start()
        ));
        let member_path = locator(path, index, entry.name());
        if member_path.as_os_str().len() > 4096 {
            return Err(invalid("ZIP member locator exceeds the desktop path limit"));
        }
        files.push(DiscoveredFile {
            path: member_path,
            root_relative: relative.join(entry.name()),
            format,
            fingerprint,
        });
    }
    Ok(files)
}

struct BoundedMember<'a> {
    entry: zip::read::ZipFile<'a>,
    guard: ParseGuard,
    bytes: u64,
}

impl Read for BoundedMember<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        self.guard
            .check_now()
            .map_err(|error| invalid(error.to_string()))?;
        let cap = buffer.len().min(64 * 1024);
        let count = self.entry.read(&mut buffer[..cap])?;
        self.bytes += count as u64;
        if self.bytes > MAX_MEMBER_BYTES || self.bytes > self.entry.size() {
            return Err(invalid("ZIP member exceeded its declared or allowed size"));
        }
        if count == 0 && self.bytes != self.entry.size() {
            return Err(invalid("ZIP member size differs from its directory record"));
        }
        self.guard
            .charge_decompressed(count as u64)
            .map_err(|error| invalid(error.to_string()))?;
        Ok(count)
    }
}

fn read_member<T>(
    source: &MemberSource,
    operation: impl FnOnce(BoundedMember<'_>) -> io::Result<T>,
) -> io::Result<T> {
    let mut archive = open_archive(&source.archive)?;
    let entry = archive.by_index(source.index).map_err(invalid_zip)?;
    if entry.name() != source.name {
        return Err(invalid("ZIP member changed; rescan the source folder"));
    }
    let guard = ParseGuard::default();
    validate_entry(&entry, &guard)?;
    operation(BoundedMember {
        entry,
        guard,
        bytes: 0,
    })
}

pub fn hash_source(path: &Path) -> io::Result<ContentHash> {
    match member_source(path)? {
        Some(source) => read_member(&source, |reader| hash_reader(reader)),
        None => crate::hash::hash_file(path),
    }
}

/// Reuse each seekable directory during reconciliation, rather than reparsing
/// a potentially large central directory once per member.
pub fn hash_sources(paths: &[PathBuf]) -> Vec<(PathBuf, io::Result<ContentHash>)> {
    let mut archives = std::collections::BTreeMap::<PathBuf, Vec<(PathBuf, MemberSource)>>::new();
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        match member_source(path) {
            Ok(Some(source)) => archives
                .entry(source.archive.clone())
                .or_default()
                .push((path.clone(), source)),
            Ok(None) => results.push((path.clone(), crate::hash::hash_file(path))),
            Err(error) => results.push((path.clone(), Err(error))),
        }
    }
    for (path, members) in archives {
        let mut archive = match open_archive(&path) {
            Ok(archive) => archive,
            Err(error) => {
                for (path, _) in members {
                    results.push((path, Err(invalid(error.to_string()))));
                }
                continue;
            }
        };
        for (path, source) in members {
            let result = (|| {
                let entry = archive.by_index(source.index).map_err(invalid_zip)?;
                if entry.name() != source.name {
                    return Err(invalid("ZIP member changed; rescan the source folder"));
                }
                let guard = ParseGuard::default();
                validate_entry(&entry, &guard)?;
                hash_reader(BoundedMember {
                    entry,
                    guard,
                    bytes: 0,
                })
            })();
            results.push((path, result));
        }
    }
    results
}

/// Materialize only a requested member. The owning TempDir removes it on all
/// return paths, including parser failures.
pub struct ResolvedSource {
    path: PathBuf,
    _temporary: Option<tempfile::TempDir>,
}

impl ResolvedSource {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn resolve(path: &Path) -> io::Result<ResolvedSource> {
    let Some(source) = member_source(path)? else {
        return Ok(ResolvedSource {
            path: path.to_owned(),
            _temporary: None,
        });
    };
    let format = ModelFormat::from_path(Path::new(&source.name))
        .ok_or_else(|| invalid("unsupported ZIP model member"))?;
    let temporary = tempfile::tempdir()?;
    let target = temporary
        .path()
        .join(format!("model.{}", format.extension()));
    let mut output = File::create(&target)?;
    read_member(&source, |mut reader| io::copy(&mut reader, &mut output))?;
    output.flush()?;
    drop(output);
    Ok(ResolvedSource {
        path: target,
        _temporary: Some(temporary),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{reconcile_root, CatalogStore, InMemoryCatalog};
    use crate::scan::scan_root;
    use zip::write::SimpleFileOptions;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn reconcile(store: &mut dyn CatalogStore, root: &Path) -> crate::catalog::ReconcileReport {
        reconcile_root(store, "root", &scan_root(root, &AtomicBool::new(false)))
    }

    #[test]
    fn archived_and_extracted_twins_share_identity_and_unchanged_members_are_not_rehashed() {
        let root = tempfile::tempdir().unwrap();
        write_zip(
            &root.path().join("parts.zip"),
            &[
                ("nested/part.STL", b"same"),
                ("ignored.txt", b"not a model"),
            ],
        );
        std::fs::write(root.path().join("part.stl"), b"same").unwrap();
        let mut store = InMemoryCatalog::new();
        assert_eq!(reconcile(&mut store, root.path()).added, 2);
        let models = store.models();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].hash, hash_reader(&b"same"[..]).unwrap());
        assert_eq!(models[0].size, 4);
        assert_eq!(models[0].locations.len(), 2);
        assert!(models[0].is_duplicate_group());
        let scan = scan_root(root.path(), &AtomicBool::new(false));
        assert_eq!(
            crate::catalog::hash_changed_files(&store, "root", &scan)
                .0
                .len(),
            usize::from(!cfg!(unix))
        );
        assert_eq!(reconcile(&mut store, root.path()).unchanged, 2);
    }

    #[test]
    fn member_changes_reordering_and_archive_removal_reconcile() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("parts.zip");
        write_zip(&archive, &[("a.stl", b"old"), ("b.obj", b"other")]);
        let mut store = InMemoryCatalog::new();
        reconcile(&mut store, root.path());
        // Same length, within the same timestamp second: member CRC and archive
        // nanosecond revision still invalidate the cheap fingerprint.
        write_zip(&archive, &[("a.stl", b"new"), ("b.obj", b"other")]);
        assert_eq!(reconcile(&mut store, root.path()).changed, 1);
        write_zip(&archive, &[("b.obj", b"other")]);
        let report = reconcile(&mut store, root.path());
        assert_eq!(report.added, 1);
        assert_eq!(report.missing, 2);
        assert!(hash_source(&locator(&archive, 0, "a.stl")).is_err());
        std::fs::remove_file(&archive).unwrap();
        reconcile(&mut store, root.path());
        assert!(store
            .models()
            .iter()
            .all(|model| model.locations.iter().all(|location| !location.available)));
    }

    #[test]
    fn reads_only_the_directory_and_requested_model_not_unrelated_payloads() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("big.zip");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file(
                "unrelated.bin",
                SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .large_file(true),
            )
            .unwrap();
        let chunk = [7; 64 * 1024];
        for _ in 0..512 {
            writer.write_all(&chunk).unwrap();
        }
        writer
            .start_file(
                "model.stl",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        for _ in 0..4 {
            writer.write_all(&chunk).unwrap();
        }
        writer.finish().unwrap();
        let archive = open_archive(&path).unwrap();
        let remaining = archive.into_inner().remaining;
        assert!(MAX_CENTRAL_DIRECTORY_BYTES + 65_557 - remaining < 1024 * 1024);
        let scan = scan_root(root.path(), &AtomicBool::new(false));
        assert_eq!(scan.files.len(), 1);
        assert_eq!(
            hash_source(&scan.files[0].path).unwrap(),
            hash_reader(chunk.repeat(4).as_slice()).unwrap()
        );
        read_member(
            &member_source(&scan.files[0].path).unwrap().unwrap(),
            |mut reader| {
                let mut request = vec![0; 1024 * 1024];
                assert_eq!(reader.read(&mut [])?, 0);
                assert_eq!(reader.read(&mut request)?, 64 * 1024);
                Ok(())
            },
        )
        .unwrap();
    }

    #[test]
    fn resolves_preview_and_3mf_metadata_and_cleans_requested_member() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("models.zip");
        let obj = b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
        let fixture = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/threemf/multi_plate.3mf"),
        )
        .unwrap();
        write_zip(&archive, &[("part.obj", obj), ("project.3mf", &fixture)]);
        let member = locator(&archive, 0, "part.obj");
        let scene = crate::rpc::load_scene_dto(&member).unwrap();
        assert_eq!(scene.indices.len(), 3);
        assert!(crate::rpc::render_thumbnail_dto(&member, Some(32)).is_ok());
        let threemf = locator(&archive, 1, "project.3mf");
        assert!(crate::rpc::extract_vendor_metadata_dto(&threemf).is_ok());
        assert!(crate::rpc::extract_vendor_plate_thumbnails_dto(&threemf).is_ok());
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).files.len(),
            2,
            "3MF is one member, not its internal resources"
        );
        let resolved = resolve(&member).unwrap();
        let materialized = resolved.path().to_owned();
        assert!(materialized.exists());
        drop(resolved);
        assert!(!materialized.exists());
        assert!(archive.exists());
    }

    #[test]
    fn corrupt_unsafe_bomb_and_oversized_archives_are_explicit_errors() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("bad.zip");
        std::fs::write(&archive, b"not a zip").unwrap();
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).skipped_errors,
            1
        );
        write_zip(&archive, &[("../escape.stl", b"bad")]);
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).skipped_errors,
            1
        );
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file(
                "bomb.stl",
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        for _ in 0..80 {
            writer.write_all(&[0; 64 * 1024]).unwrap();
        }
        writer.finish().unwrap();
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).skipped_errors,
            1
        );
        assert!(hash_source(&locator(&archive, 0, "bomb.stl"))
            .unwrap_err()
            .to_string()
            .contains("ratio"));
        write_zip(&archive, &[("large.stl", b"x")]);
        let mut bytes = std::fs::read(&archive).unwrap();
        let central = bytes
            .windows(4)
            .position(|bytes| bytes == b"PK\x01\x02")
            .unwrap();
        bytes[central + 24..central + 28]
            .copy_from_slice(&((MAX_MEMBER_BYTES + 1) as u32).to_le_bytes());
        std::fs::write(&archive, bytes).unwrap();
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).skipped_errors,
            1
        );
        assert!(member_source(Path::new("a.zip/::zip::")).is_err());
    }

    #[test]
    fn excessive_directory_count_and_size_rejected_before_zip_allocation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("limits.zip");
        write_zip(&path, &[("part.stl", b"data")]);
        let original = std::fs::read(&path).unwrap();
        let mut bytes = original.clone();
        let end = bytes.len() - 22;
        bytes[end + 12..end + 16]
            .copy_from_slice(&((MAX_CENTRAL_DIRECTORY_BYTES + 1) as u32).to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        assert!(open_archive(&path)
            .err()
            .unwrap()
            .to_string()
            .contains("directory"));
        std::fs::write(&path, original).unwrap();
        assert!(open_archive(&path).is_ok());
    }

    #[test]
    fn encrypted_members_and_corrupt_payloads_do_not_get_model_identities() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bad.zip");
        write_zip(&path, &[("a.stl", b"model")]);
        let original = std::fs::read(&path).unwrap();
        let central = original
            .windows(4)
            .position(|bytes| bytes == b"PK\x01\x02")
            .unwrap();
        let mut encrypted = original.clone();
        encrypted[6] |= 1;
        encrypted[central + 8] |= 1;
        std::fs::write(&path, encrypted).unwrap();
        assert!(hash_source(&locator(&path, 0, "a.stl")).is_err());
        assert_eq!(
            scan_root(root.path(), &AtomicBool::new(false)).skipped_errors,
            1
        );
        let mut corrupt = original.clone();
        // Stored entry bytes begin after the 30-byte header and member name.
        corrupt[30 + "a.stl".len()] ^= 0xff;
        std::fs::write(&path, corrupt).unwrap();
        assert!(hash_source(&locator(&path, 0, "a.stl")).is_err());
        std::fs::write(&path, original).unwrap();
        assert!(hash_source(&locator(&path, 0, "a.stl")).is_ok());
    }

    #[test]
    fn zip64_entry_count_limit_is_checked_at_the_exact_boundary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("count.zip");
        write_zip(&path, &[("a.stl", b"model")]);
        let original = std::fs::read(&path).unwrap();
        for count in [MAX_ARCHIVE_ENTRIES as u64, MAX_ARCHIVE_ENTRIES as u64 + 1] {
            let end = original.len() - 22;
            let mut bytes = original[..end].to_vec();
            let mut record = [0u8; 56];
            record[..4].copy_from_slice(b"PK\x06\x06");
            record[4..12].copy_from_slice(&44u64.to_le_bytes());
            record[24..32].copy_from_slice(&count.to_le_bytes());
            record[32..40].copy_from_slice(&count.to_le_bytes());
            record[40..48].copy_from_slice(&60u64.to_le_bytes());
            bytes.extend_from_slice(&record);
            let mut locator = [0u8; 20];
            locator[..4].copy_from_slice(b"PK\x06\x07");
            locator[8..16].copy_from_slice(&(end as u64).to_le_bytes());
            locator[16..20].copy_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&locator);
            let mut eocd = original[end..].to_vec();
            eocd[8..12].copy_from_slice(&[0xff; 4]);
            bytes.extend_from_slice(&eocd);
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(
                directory_bounds(&File::open(&path).unwrap()).unwrap().0,
                count
            );
            if count > MAX_ARCHIVE_ENTRIES as u64 {
                assert!(open_archive(&path)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("indexing limits"));
            }
        }
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn restored_mtime_and_crc_collision_do_not_preserve_stale_identity() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("parts.zip");
        let a = [
            0x42, 0x5a, 0xb9, 0xe9, 0xe0, 0xaa, 0x22, 0x13, 0xb4, 0xc3, 0xe1, 0x92,
        ];
        let b = [
            0xbe, 0x55, 0x21, 0x4e, 0xb3, 0x9d, 0xda, 0x07, 0x61, 0x89, 0x7c, 0xc1,
        ];
        assert_eq!(a.len(), b.len());
        assert_ne!(
            hash_reader(a.as_slice()).unwrap(),
            hash_reader(b.as_slice()).unwrap()
        );
        write_zip(&archive, &[("a.stl", &a)]);
        std::fs::write(root.path().join("a.stl"), a).unwrap();
        let before = archive.metadata().unwrap();
        let mtime = before.modified().unwrap();
        let mut first = open_archive(&archive).unwrap();
        let entry = first.by_index_raw(0).unwrap();
        let directory = (
            entry.crc32(),
            entry.size(),
            entry.compressed_size(),
            entry.header_start(),
        );
        drop(entry);
        drop(first);
        let db = root.path().join("catalog.sqlite");
        {
            let mut store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
            reconcile(&mut store, root.path());
            assert_eq!(store.models().len(), 1);
        }
        std::thread::sleep(std::time::Duration::from_millis(1100));
        write_zip(&archive, &[("a.stl", &b)]);
        File::options()
            .write(true)
            .open(&archive)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        let after = archive.metadata().unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(mtime, after.modified().unwrap());
        if cfg!(unix) {
            assert_ne!(change_revision(&before), change_revision(&after));
        }
        let mut second = open_archive(&archive).unwrap();
        let entry = second.by_index_raw(0).unwrap();
        assert_eq!(
            directory,
            (
                entry.crc32(),
                entry.size(),
                entry.compressed_size(),
                entry.header_start()
            )
        );
        drop(entry);
        let mut store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
        assert_eq!(reconcile(&mut store, root.path()).changed, 1);
        assert_eq!(store.models().len(), 2);
        let scan = scan_root(root.path(), &AtomicBool::new(false));
        assert_eq!(
            crate::catalog::hash_changed_files(&store, "root", &scan)
                .0
                .len(),
            usize::from(!cfg!(unix))
        );
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn sqlite_member_fingerprints_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("catalog.sqlite");
        write_zip(&root.path().join("parts.zip"), &[("a.stl", b"same")]);
        std::fs::write(root.path().join("a.stl"), b"same").unwrap();
        {
            let mut store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
            assert_eq!(reconcile(&mut store, root.path()).added, 2);
        }
        let mut store = crate::sqlite_catalog::SqliteCatalog::open(&db).unwrap();
        let scan = scan_root(root.path(), &AtomicBool::new(false));
        assert_eq!(
            crate::catalog::hash_changed_files(&store, "root", &scan)
                .0
                .len(),
            usize::from(!cfg!(unix))
        );
        assert_eq!(reconcile(&mut store, root.path()).unchanged, 2);
        assert_eq!(store.models()[0].locations.len(), 2);
    }
}
