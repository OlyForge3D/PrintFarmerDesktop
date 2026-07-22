//! Live filesystem watching for source roots.
//!
//! Raw OS notifications are noisy: a single save can fire several create,
//! modify, and metadata events, and editors touch sibling temp files. This
//! module turns that stream into *debounced batches of affected model paths* —
//! the exact unit of work [`crate::catalog::reconcile_root`] consumes — so the
//! catalog stays live without re-walking the whole tree on every keystroke.
//!
//! The path-classification and coalescing logic is kept pure and unit-tested;
//! [`RootWatcher`] is the thin layer that wires the pure-Rust `notify` crate to
//! it. No C toolchain is involved, so the watcher ships and is verified locally.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};

use crate::model::ModelFormat;

/// True when a path names a supported model file (decided by extension).
pub fn is_model_path(path: &Path) -> bool {
    ModelFormat::from_path(path).is_some()
}

/// The model-file paths touched by a single filesystem event. Pure read
/// (`Access`) events carry no change and are ignored, as are non-model paths
/// such as a sibling `.txt` or an editor's swap file, so the catalog only ever
/// reconciles files it actually tracks.
pub fn model_paths_from_event(event: &Event) -> Vec<PathBuf> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter(|p| is_model_path(p))
        .cloned()
        .collect()
}

/// Coalesce a burst of events into a sorted, de-duplicated set of affected
/// model paths. Sorting gives callers (and tests) a deterministic order.
pub fn coalesce_events<'a, I>(events: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = &'a Event>,
{
    let mut set: BTreeSet<PathBuf> = BTreeSet::new();
    for event in events {
        set.extend(model_paths_from_event(event));
    }
    set.into_iter().collect()
}

/// A recursive filesystem watcher over one source root.
///
/// Events are buffered on an internal channel; [`RootWatcher::next_batch`]
/// blocks for the first model-affecting change and then keeps draining until
/// the tree goes quiet, returning one coalesced batch of paths to reconcile.
pub struct RootWatcher {
    // Dropping the watcher stops the OS subscription, so it is owned here even
    // though it is not read after construction.
    _watcher: notify::RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
    quiet_period: Duration,
}

impl RootWatcher {
    /// Start watching `root` recursively. `quiet_period` is how long the tree
    /// must be silent before an in-flight burst is considered complete.
    pub fn new(root: &Path, quiet_period: Duration) -> notify::Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res| {
            // If the receiver has been dropped the batch loop is gone; discard.
            let _ = tx.send(res);
        })?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            events: rx,
            quiet_period,
        })
    }

    /// Block until a model-affecting change arrives, then drain the burst until
    /// the tree is quiet for `quiet_period`, returning the coalesced batch of
    /// affected model paths. Returns `None` if `overall_timeout` elapses with no
    /// relevant activity, or if the watcher's channel disconnects.
    pub fn next_batch(&self, overall_timeout: Duration) -> Option<Vec<PathBuf>> {
        let deadline = Instant::now() + overall_timeout;
        let mut events: Vec<Event> = Vec::new();

        // Phase 1: wait for the first event that touches a tracked model file.
        loop {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            match self.events.recv_timeout(remaining) {
                Ok(Ok(event)) => {
                    if !model_paths_from_event(&event).is_empty() {
                        events.push(event);
                        break;
                    }
                }
                Ok(Err(_)) => continue, // transient watcher error; keep waiting
                Err(RecvTimeoutError::Timeout) => return None,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }

        // Phase 2: drain the burst until the tree falls silent.
        loop {
            match self.events.recv_timeout(self.quiet_period) {
                Ok(Ok(event)) => events.push(event),
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        }

        let batch = coalesce_events(events.iter());
        (!batch.is_empty()).then_some(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind};
    use std::fs;

    fn event(kind: EventKind, paths: &[&str]) -> Event {
        let mut ev = Event::new(kind);
        for p in paths {
            ev = ev.add_path(PathBuf::from(p));
        }
        ev
    }

    #[test]
    fn model_paths_filters_non_model_files() {
        let ev = event(
            EventKind::Create(CreateKind::Any),
            &["/root/a.stl", "/root/notes.txt", "/root/b.3mf"],
        );
        let mut paths = model_paths_from_event(&ev);
        paths.sort();
        assert_eq!(
            paths,
            vec![PathBuf::from("/root/a.stl"), PathBuf::from("/root/b.3mf")]
        );
    }

    #[test]
    fn access_events_are_ignored() {
        let ev = event(EventKind::Access(AccessKind::Any), &["/root/a.stl"]);
        assert!(model_paths_from_event(&ev).is_empty());
    }

    #[test]
    fn coalesce_deduplicates_and_sorts_model_paths() {
        let events = [
            event(EventKind::Modify(ModifyKind::Any), &["/root/b.stl"]),
            event(EventKind::Create(CreateKind::Any), &["/root/a.stl"]),
            event(EventKind::Modify(ModifyKind::Any), &["/root/b.stl"]),
            event(EventKind::Access(AccessKind::Any), &["/root/a.stl"]),
            event(EventKind::Modify(ModifyKind::Any), &["/root/ignore.txt"]),
        ];
        assert_eq!(
            coalesce_events(events.iter()),
            vec![PathBuf::from("/root/a.stl"), PathBuf::from("/root/b.stl")]
        );
    }

    #[test]
    fn coalesce_of_only_irrelevant_events_is_empty() {
        let events = [
            event(EventKind::Access(AccessKind::Any), &["/root/a.stl"]),
            event(EventKind::Create(CreateKind::Any), &["/root/readme.md"]),
        ];
        assert!(coalesce_events(events.iter()).is_empty());
    }

    #[test]
    fn next_batch_times_out_when_nothing_changes() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = RootWatcher::new(dir.path(), Duration::from_millis(50)).unwrap();
        assert!(watcher.next_batch(Duration::from_millis(150)).is_none());
    }

    #[test]
    fn next_batch_reports_a_created_model_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let watcher = RootWatcher::new(root, Duration::from_millis(200)).unwrap();

        let target = root.join("new.stl");
        // Some platforms need a moment to arm the subscription; nudge the tree a
        // few times so at least one create/modify event is delivered.
        for _ in 0..5 {
            fs::write(&target, b"solid").unwrap();
            if let Some(batch) = watcher.next_batch(Duration::from_secs(2)) {
                assert!(batch.iter().any(|p| p.ends_with("new.stl")));
                return;
            }
        }
        panic!("watcher never reported the created model file");
    }
}
