//! Shared security limits for the model-format pipeline.
//!
//! Every parser in this crate reads attacker-controlled bytes: a `.3mf` is a
//! ZIP of XML, and both containers have well-known amplification attacks. This
//! module centralises the budgets so the 3MF reader, the vendor-metadata reader
//! and any future container parser enforce the *same* ceilings and report the
//! same actionable diagnostics.
//!
//! Three guards live here:
//!
//! * [`ParseGuard`] — wall-clock deadline, cooperative cancellation, total
//!   decompressed-byte budget and per-entry compression-ratio check.
//! * [`XmlGuard`] — nesting depth, event budget and an outright refusal to
//!   process a document type declaration (blocking XXE and "billion laughs"
//!   entity expansion at the door rather than relying on the XML reader's
//!   entity policy).
//! * [`CancellationToken`] — a clonable flag a caller can trip to abort an
//!   in-flight parse.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use quick_xml::events::Event;
use thiserror::Error;

/// Maximum XML element nesting depth accepted in any package part. The 3MF core
/// spec never nests beyond a handful of levels; anything deeper is either
/// corrupt or an attempt to exhaust the reader.
pub const MAX_XML_DEPTH: usize = 64;

/// Maximum number of XML events processed for a single package part. Bounds the
/// work a maximally-sized part can cause even when every element is empty.
///
/// Sized from the real fixture corpus rather than a single synthetic grid
/// (#165, following up on #127 / PR #154). Bisecting the actual budget every
/// well-formed fixture under `native/model-core/tests/fixtures/threemf/`
/// needs to parse — via `smallest_event_budget_that_parses`, the same helper
/// `threemf_security.rs` uses for its own tests — and dividing each part's
/// model-XML byte length by that budget gives:
///
/// | fixture              | model part bytes | events  | bytes/event |
/// | --------------------- | ----------------: | -------: | ------------: |
/// | `unit_inch.3mf`        |              1,293 |       76 |        17.01 |
/// | `transform_chain.3mf`  |              1,533 |       88 |        17.42 |
/// | `multi_plate.3mf`      |              2,366 |      134 |        17.66 |
/// | `multi_part.3mf`       |              3,394 |      192 |        17.68 |
/// | `color_material.3mf`   |              2,282 |      126 |        18.11 |
/// | `large_grid.3mf`       |          4,305,044 |  174,118 |        24.72 |
/// | 361×361 stress grid (`a_realistically_large_model_is_accepted_within_the_default_budget`) | 20,418,403 | 779,072 | 26.21 |
///
/// The worst (densest) case is `unit_inch.3mf` at ~17.01 bytes/event — small,
/// mostly-metadata packages are denser than large geometry-dominated ones,
/// because vertex/triangle elements carry more bytes per event than the
/// wrapper and header elements around them. Extrapolated to the 512 MiB
/// `MAX_MODEL_XML_BYTES` ceiling (`threemf::MAX_MODEL_XML_BYTES`), a
/// legitimate document built entirely out of the densest observed material
/// would need `536,870,912 / 17.01 ≈ 31,556,218` events — this repo's actual
/// worst-case legitimate figure, in place of the ~20.5M a single synthetic
/// grid implied.
///
/// 50,000,000 keeps roughly 58% headroom over that worst case (a margin
/// comparable to the ~56% the same reasoning would give against the older
/// 20.5M estimate), while being small enough that a hostile document
/// reaching it — `<a/>x`, the densest construct quick-xml emits, at 2.5
/// bytes/event — is only ~119 MiB, letting
/// `the_shipped_budget_rejects_and_admits_at_the_exact_line` in
/// `threemf_security.rs` drive the real, shipped value end-to-end instead of
/// a reduced stand-in. See `docs/security/THREAT_MODEL.md` T2.1 for the full
/// writeup, including the caveat that this fixture corpus is hand-authored
/// rather than a survey of actual vendor slicer output.
pub const MAX_XML_EVENTS: u64 = 50_000_000;

/// Maximum accepted `uncompressed / compressed` ratio for one archive entry.
/// DEFLATE tops out near 1032:1 on real data, so a ratio above this can only be
/// a decompression bomb. Entries smaller than
/// [`COMPRESSION_RATIO_FLOOR_BYTES`] are exempt because tiny, highly repetitive
/// XML legitimately compresses very well.
pub const MAX_COMPRESSION_RATIO: u64 = 300;

/// Entries expanding to at most this many bytes skip the ratio check.
pub const COMPRESSION_RATIO_FLOOR_BYTES: u64 = 4 * 1024 * 1024;

/// Total bytes a single package may decompress across all of its parts.
pub const MAX_TOTAL_DECOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Default wall-clock ceiling for one parse. Generous enough that a legitimate
/// multi-hundred-megabyte package finishes, tight enough that a pathological
/// one cannot pin a sidecar worker indefinitely.
pub const DEFAULT_PARSE_TIMEOUT: Duration = Duration::from_secs(120);

/// How many guard checks happen between two `Instant::now()` calls. Reading the
/// clock on every vertex would dominate parse time, so the deadline is sampled.
const DEADLINE_SAMPLE_INTERVAL: u64 = 4096;

/// A security budget was exhausted. Distinct from "malformed": the document may
/// be perfectly well-formed and still be hostile.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LimitViolation {
    #[error("parsing exceeded the {limit_ms} ms time budget (stopped after {elapsed_ms} ms)")]
    Timeout { elapsed_ms: u64, limit_ms: u64 },
    #[error("parsing was cancelled by the caller")]
    Cancelled,
    #[error(
        "package part '{part}' expands {ratio}x (from {compressed_bytes} to {uncompressed_bytes} bytes), exceeding the maximum decompression ratio of {limit}x"
    )]
    CompressionRatio {
        part: String,
        ratio: u64,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
        limit: u64,
    },
    #[error("package declares a total expansion of more than the maximum of {limit} bytes")]
    DeclaredTotalDecompressedBytes { limit: u64 },
    #[error("package decompressed more than the maximum of {limit} bytes while being read")]
    TotalDecompressedBytes { limit: u64 },
    #[error("XML nesting reached depth {depth}, exceeding the maximum of {limit}")]
    XmlDepth { depth: usize, limit: usize },
    #[error("XML part produced more than the maximum of {limit} parser events")]
    XmlEvents { limit: u64 },
    #[error(
        "XML document type declarations are rejected because they enable entity-expansion and external-entity attacks"
    )]
    XmlDoctype,
}

impl LimitViolation {
    /// A stable machine-readable code so the Electron layer can branch on the
    /// failure without string-matching the human-readable message.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Timeout { .. } => "limit.timeout",
            Self::Cancelled => "limit.cancelled",
            Self::CompressionRatio { .. } => "limit.compression_ratio",
            Self::DeclaredTotalDecompressedBytes { .. } => "limit.declared_decompressed_bytes",
            Self::TotalDecompressedBytes { .. } => "limit.total_decompressed_bytes",
            Self::XmlDepth { .. } => "limit.xml_depth",
            Self::XmlEvents { .. } => "limit.xml_events",
            Self::XmlDoctype => "limit.xml_doctype",
        }
    }
}

/// A clonable cooperative-cancellation flag. Every clone observes the same
/// underlying state, so a supervisor can hand one copy to a parse running on a
/// worker thread and trip it from elsewhere.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request cancellation. Idempotent.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Tunable per-parse security budget. [`ParseLimits::default`] is what the
/// ordinary entry points use; tests and callers with tighter requirements can
/// shrink any dimension.
#[derive(Debug, Clone)]
pub struct ParseLimits {
    /// Wall-clock ceiling, or `None` to disable the deadline.
    pub timeout: Option<Duration>,
    /// Cooperative cancellation flag, or `None` when the parse cannot be
    /// cancelled.
    pub cancellation: Option<CancellationToken>,
    pub max_total_decompressed_bytes: u64,
    pub max_compression_ratio: u64,
    pub compression_ratio_floor_bytes: u64,
    pub max_xml_depth: usize,
    pub max_xml_events: u64,
}

impl Default for ParseLimits {
    fn default() -> Self {
        Self {
            timeout: Some(DEFAULT_PARSE_TIMEOUT),
            cancellation: None,
            max_total_decompressed_bytes: MAX_TOTAL_DECOMPRESSED_BYTES,
            max_compression_ratio: MAX_COMPRESSION_RATIO,
            compression_ratio_floor_bytes: COMPRESSION_RATIO_FLOOR_BYTES,
            max_xml_depth: MAX_XML_DEPTH,
            max_xml_events: MAX_XML_EVENTS,
        }
    }
}

impl ParseLimits {
    /// Limits with the wall-clock deadline removed. Useful for deterministic
    /// tests that must not depend on machine speed.
    pub fn without_timeout(mut self) -> Self {
        self.timeout = None;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn with_cancellation(mut self, token: CancellationToken) -> Self {
        self.cancellation = Some(token);
        self
    }
}

/// Runtime state for one parse: elapsed time, decompressed bytes and the
/// cancellation flag.
#[derive(Debug)]
pub struct ParseGuard {
    limits: ParseLimits,
    started: Instant,
    checks: u64,
    decompressed_bytes: u64,
}

impl Default for ParseGuard {
    fn default() -> Self {
        Self::new(ParseLimits::default())
    }
}

impl ParseGuard {
    pub fn new(limits: ParseLimits) -> Self {
        Self {
            limits,
            started: Instant::now(),
            checks: 0,
            decompressed_bytes: 0,
        }
    }

    pub fn limits(&self) -> &ParseLimits {
        &self.limits
    }

    /// Bytes decompressed so far by this parse.
    pub fn decompressed_bytes(&self) -> u64 {
        self.decompressed_bytes
    }

    /// Sampled deadline and cancellation check for hot loops. Cheap enough to
    /// call once per vertex: the clock is only read every
    /// [`DEADLINE_SAMPLE_INTERVAL`] calls.
    pub fn checkpoint(&mut self) -> Result<(), LimitViolation> {
        self.checks = self.checks.wrapping_add(1);
        if !self.checks.is_multiple_of(DEADLINE_SAMPLE_INTERVAL) {
            return Ok(());
        }
        self.check_now()
    }

    /// Unsampled deadline and cancellation check, for coarse call sites such as
    /// "about to read another archive entry".
    pub fn check_now(&mut self) -> Result<(), LimitViolation> {
        if self
            .limits
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(LimitViolation::Cancelled);
        }
        if let Some(timeout) = self.limits.timeout {
            let elapsed = self.started.elapsed();
            if elapsed > timeout {
                return Err(LimitViolation::Timeout {
                    elapsed_ms: elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
                    limit_ms: timeout.as_millis().min(u128::from(u64::MAX)) as u64,
                });
            }
        }
        Ok(())
    }

    /// Reject an archive entry whose declared expansion ratio can only be a
    /// decompression bomb, then charge its bytes against the package-wide
    /// budget.
    pub fn charge_entry(
        &mut self,
        part: &str,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), LimitViolation> {
        self.check_ratio(part, compressed_bytes, uncompressed_bytes)?;
        self.charge_decompressed(uncompressed_bytes)
    }

    /// Ratio check only, for callers that charge bytes as they stream.
    pub fn check_ratio(
        &self,
        part: &str,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
    ) -> Result<(), LimitViolation> {
        if uncompressed_bytes <= self.limits.compression_ratio_floor_bytes {
            return Ok(());
        }
        // A zero-length compressed payload that claims a non-trivial expansion
        // is infinitely amplified; treat it as maximally suspicious.
        let divisor = compressed_bytes.max(1);
        // Compare by cross-multiplication rather than dividing: an integer
        // quotient truncates, so a 300.99:1 expansion would compute as 300 and
        // slip past a 300:1 cap. If the allowance itself overflows u64 then no
        // real payload can exceed it.
        let exceeded = match self.limits.max_compression_ratio.checked_mul(divisor) {
            Some(allowed) => uncompressed_bytes > allowed,
            None => false,
        };
        if exceeded {
            return Err(LimitViolation::CompressionRatio {
                part: part.to_string(),
                // Round up so the reported ratio never reads as within the cap
                // it just failed.
                ratio: uncompressed_bytes.div_ceil(divisor),
                compressed_bytes,
                uncompressed_bytes,
                limit: self.limits.max_compression_ratio,
            });
        }
        Ok(())
    }

    /// Reject a package whose central directory *claims* a total expansion past
    /// the budget, before any entry is opened. Distinct from
    /// [`Self::charge_decompressed`], which tracks bytes actually produced:
    /// this catches an archive assembled from many entries that each sit under
    /// the ratio floor but together promise far more than we will ever allow.
    ///
    /// Reports a *different* code from the accumulator on purpose. "This archive
    /// honestly declares more than we permit" and "this entry lied about its
    /// size" are different events — the second is a far stronger hostility
    /// signal — and a shared code leaves the caller unable to tell them apart.
    /// It also leaves a test unable to say which control it reached.
    pub fn check_declared_archive_total(&self, declared_bytes: u64) -> Result<(), LimitViolation> {
        if declared_bytes > self.limits.max_total_decompressed_bytes {
            return Err(LimitViolation::DeclaredTotalDecompressedBytes {
                limit: self.limits.max_total_decompressed_bytes,
            });
        }
        Ok(())
    }

    /// Charge bytes against the package-wide decompression budget.
    ///
    /// Reached only when an entry produces more than it declared, because
    /// [`Self::check_declared_archive_total`] has already rejected anything an
    /// honest archive admits to.
    pub fn charge_decompressed(&mut self, bytes: u64) -> Result<(), LimitViolation> {
        let total = self.decompressed_bytes.saturating_add(bytes);
        if total > self.limits.max_total_decompressed_bytes {
            return Err(LimitViolation::TotalDecompressedBytes {
                limit: self.limits.max_total_decompressed_bytes,
            });
        }
        self.decompressed_bytes = total;
        Ok(())
    }

    /// A fresh [`XmlGuard`] bound to this parse's XML budgets.
    pub fn xml_guard(&self) -> XmlGuard {
        XmlGuard::new(self.limits.max_xml_depth, self.limits.max_xml_events)
    }
}

/// Per-document XML budget: nesting depth, event count and DTD refusal.
///
/// [`XmlGuard::observe`] must be called for every event a reader yields,
/// *before* the event is interpreted, so a hostile document is rejected before
/// its contents are acted on.
#[derive(Debug)]
pub struct XmlGuard {
    depth: usize,
    max_depth: usize,
    events: u64,
    max_events: u64,
}

impl XmlGuard {
    pub fn new(max_depth: usize, max_events: u64) -> Self {
        Self {
            depth: 0,
            max_depth,
            events: 0,
            max_events,
        }
    }

    /// Current element nesting depth (`0` outside the root element).
    pub fn depth(&self) -> usize {
        self.depth
    }

    /// Account for one parser event, rejecting DTDs, over-deep nesting and
    /// runaway event counts.
    pub fn observe(&mut self, event: &Event<'_>) -> Result<(), LimitViolation> {
        self.events = self.events.saturating_add(1);
        if self.events > self.max_events {
            return Err(LimitViolation::XmlEvents {
                limit: self.max_events,
            });
        }
        match event {
            // A DOCTYPE is the entry point for both external-entity (XXE) and
            // entity-expansion ("billion laughs") attacks. 3MF has no
            // legitimate use for one, so refuse the document outright instead
            // of trusting the reader's entity-resolution policy.
            Event::DocType(_) => Err(LimitViolation::XmlDoctype),
            Event::Start(_) => {
                self.depth = self.depth.saturating_add(1);
                if self.depth > self.max_depth {
                    return Err(LimitViolation::XmlDepth {
                        depth: self.depth,
                        limit: self.max_depth,
                    });
                }
                Ok(())
            }
            Event::Empty(_) => {
                // A self-closing element still occupies one level while it is
                // being read.
                let depth = self.depth.saturating_add(1);
                if depth > self.max_depth {
                    return Err(LimitViolation::XmlDepth {
                        depth,
                        limit: self.max_depth,
                    });
                }
                Ok(())
            }
            Event::End(_) => {
                self.depth = self.depth.saturating_sub(1);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use quick_xml::events::{BytesEnd, BytesStart, BytesText};

    fn start(name: &str) -> Event<'static> {
        Event::Start(BytesStart::new(name.to_string()))
    }

    fn end(name: &str) -> Event<'static> {
        Event::End(BytesEnd::new(name.to_string()))
    }

    #[test]
    fn cancellation_token_is_shared_across_clones() {
        let token = CancellationToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
    }

    #[test]
    fn guard_reports_cancellation_immediately() {
        let token = CancellationToken::new();
        let mut guard = ParseGuard::new(ParseLimits::default().with_cancellation(token.clone()));
        assert_eq!(guard.check_now(), Ok(()));
        token.cancel();
        assert_eq!(guard.check_now(), Err(LimitViolation::Cancelled));
    }

    #[test]
    fn guard_reports_timeout_once_the_deadline_passes() {
        let mut guard =
            ParseGuard::new(ParseLimits::default().with_timeout(Duration::from_millis(0)));
        std::thread::sleep(Duration::from_millis(2));
        let error = guard.check_now().expect_err("deadline should have expired");
        assert!(matches!(error, LimitViolation::Timeout { limit_ms: 0, .. }));
        assert_eq!(error.code(), "limit.timeout");
    }

    #[test]
    fn disabled_timeout_never_expires() {
        let mut guard = ParseGuard::new(ParseLimits::default().without_timeout());
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(guard.check_now(), Ok(()));
    }

    #[test]
    fn checkpoint_samples_the_clock_but_still_fires() {
        let mut guard =
            ParseGuard::new(ParseLimits::default().with_timeout(Duration::from_millis(0)));
        std::thread::sleep(Duration::from_millis(2));
        let mut fired = false;
        for _ in 0..(DEADLINE_SAMPLE_INTERVAL + 1) {
            if guard.checkpoint().is_err() {
                fired = true;
                break;
            }
        }
        assert!(
            fired,
            "sampled checkpoint must eventually observe the deadline"
        );
    }

    #[test]
    fn small_entries_are_exempt_from_the_ratio_check() {
        let guard = ParseGuard::default();
        assert_eq!(
            guard.check_ratio("tiny", 1, COMPRESSION_RATIO_FLOOR_BYTES),
            Ok(())
        );
    }

    #[test]
    fn oversized_expansion_ratio_is_rejected() {
        let guard = ParseGuard::default();
        let uncompressed = COMPRESSION_RATIO_FLOOR_BYTES * 4;
        let compressed = uncompressed / (MAX_COMPRESSION_RATIO * 2);
        let error = guard
            .check_ratio("3D/3dmodel.model", compressed, uncompressed)
            .expect_err("zip bomb ratio must be rejected");
        assert_eq!(error.code(), "limit.compression_ratio");
        assert!(error.to_string().contains("3D/3dmodel.model"));
    }

    #[test]
    fn zero_length_compressed_entry_is_treated_as_maximally_amplified() {
        let guard = ParseGuard::default();
        assert!(guard
            .check_ratio("bomb", 0, COMPRESSION_RATIO_FLOOR_BYTES * 2)
            .is_err());
    }

    #[test]
    fn total_decompressed_budget_is_cumulative() {
        let limits = ParseLimits {
            max_total_decompressed_bytes: 10,
            ..ParseLimits::default()
        };
        let mut guard = ParseGuard::new(limits);
        assert_eq!(guard.charge_decompressed(6), Ok(()));
        assert_eq!(guard.decompressed_bytes(), 6);
        assert_eq!(
            guard.charge_decompressed(5),
            Err(LimitViolation::TotalDecompressedBytes { limit: 10 })
        );
        assert_eq!(
            guard.decompressed_bytes(),
            6,
            "rejected charge must not accrue"
        );
    }

    #[test]
    fn xml_guard_rejects_doctype() {
        let mut guard = XmlGuard::new(MAX_XML_DEPTH, MAX_XML_EVENTS);
        let event = Event::DocType(BytesText::new("root [<!ENTITY a \"aaa\">]"));
        assert_eq!(guard.observe(&event), Err(LimitViolation::XmlDoctype));
    }

    #[test]
    fn xml_guard_rejects_over_deep_nesting() {
        let mut guard = XmlGuard::new(3, MAX_XML_EVENTS);
        for _ in 0..3 {
            assert_eq!(guard.observe(&start("a")), Ok(()));
        }
        assert_eq!(
            guard.observe(&start("a")),
            Err(LimitViolation::XmlDepth { depth: 4, limit: 3 })
        );
    }

    #[test]
    fn xml_guard_unwinds_depth_on_end_events() {
        let mut guard = XmlGuard::new(2, MAX_XML_EVENTS);
        assert_eq!(guard.observe(&start("a")), Ok(()));
        assert_eq!(guard.observe(&start("b")), Ok(()));
        assert_eq!(guard.observe(&end("b")), Ok(()));
        assert_eq!(guard.depth(), 1);
        assert_eq!(guard.observe(&start("c")), Ok(()));
    }

    #[test]
    fn xml_guard_counts_empty_elements_against_depth_without_descending() {
        let mut guard = XmlGuard::new(1, MAX_XML_EVENTS);
        assert_eq!(
            guard.observe(&Event::Empty(BytesStart::new("only"))),
            Ok(())
        );
        assert_eq!(guard.depth(), 0);
        assert_eq!(guard.observe(&start("root")), Ok(()));
        assert!(guard
            .observe(&Event::Empty(BytesStart::new("too-deep")))
            .is_err());
    }

    #[test]
    fn xml_guard_enforces_an_event_budget() {
        let mut guard = XmlGuard::new(MAX_XML_DEPTH, 2);
        assert_eq!(guard.observe(&start("a")), Ok(()));
        assert_eq!(guard.observe(&end("a")), Ok(()));
        assert_eq!(
            guard.observe(&start("b")),
            Err(LimitViolation::XmlEvents { limit: 2 })
        );
    }

    #[test]
    fn violation_codes_are_distinct() {
        let violations = [
            LimitViolation::Timeout {
                elapsed_ms: 1,
                limit_ms: 0,
            },
            LimitViolation::Cancelled,
            LimitViolation::CompressionRatio {
                part: "p".to_string(),
                ratio: 1,
                compressed_bytes: 1,
                uncompressed_bytes: 1,
                limit: 1,
            },
            LimitViolation::DeclaredTotalDecompressedBytes { limit: 1 },
            LimitViolation::TotalDecompressedBytes { limit: 1 },
            LimitViolation::XmlDepth { depth: 1, limit: 1 },
            LimitViolation::XmlEvents { limit: 1 },
            LimitViolation::XmlDoctype,
        ];
        let mut codes: Vec<&str> = violations.iter().map(LimitViolation::code).collect();
        codes.sort_unstable();
        let unique = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), unique);
    }
}
