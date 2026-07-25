//! Adversarial regression suite for the model-format security limits (#20).
//!
//! Each test constructs a hostile package in memory and asserts the reader
//! refuses it with a specific, stable [`LimitViolation`] code. These are
//! deliberately separate from the fixture suite: a checked-in file is a poor
//! home for multi-gigabyte expansions or wall-clock behaviour.

mod threemf_support;

use std::fs;
use std::io::Cursor;
use std::thread;
use std::time::Duration;

use model_core::limits::{
    CancellationToken, ParseGuard, ParseLimits, COMPRESSION_RATIO_FLOOR_BYTES, MAX_XML_DEPTH,
};
use model_core::scene;
use model_core::scene_status::SceneLoadStatus;
use model_core::threemf::{self, ThreeMfError};
use model_core::vendor;

use threemf_support::{
    model_document, package, production_package, triangle_object, zip_parts, Part,
    CONTENT_TYPES_PART, CONTENT_TYPES_XML, DEFAULT_MODEL_PART, RELATIONSHIPS_PART, RELS_XML,
};

fn benign_model() -> String {
    model_document(
        "millimeter",
        &triangle_object("1", "Decoy"),
        r#"    <item objectid="1"/>"#,
    )
}

/// A package that is valid apart from the extra parts handed in.
fn package_with(extra: Vec<Part>) -> Vec<u8> {
    package(&benign_model(), extra)
}

fn parse_error(data: &[u8]) -> ThreeMfError {
    threemf::parse_bytes(data).expect_err("hostile package must be rejected")
}

// --- decompression bombs ---------------------------------------------------

#[test]
fn rejects_a_high_ratio_entry_even_when_the_reader_never_opens_it() {
    // The bomb lives in a part no current code path reads. It must still fail
    // the package: otherwise it lies in wait for the next feature that does.
    let bomb = vec![0u8; 16 * 1024 * 1024];
    let data = package_with(vec![Part::bytes("Metadata/unused_blob.png", bomb)]);
    let error = parse_error(&data);
    assert_eq!(error.code(), "limit.compression_ratio", "{error}");
}

#[test]
fn rejects_a_bomb_in_the_model_part_itself() {
    // Highly repetitive but structurally valid XML padding, far past the
    // small-entry floor, at a ratio no legitimate export reaches.
    let padding = "<!-- ".to_string() + &"A".repeat(12 * 1024 * 1024) + " -->";
    let model = format!(
        "{}\n{padding}",
        model_document(
            "millimeter",
            &triangle_object("1", "Decoy"),
            r#"    <item objectid="1"/>"#
        )
    );
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "limit.compression_ratio", "{error}");
}

#[test]
fn small_highly_compressible_parts_stay_allowed() {
    // Real 3MF XML compresses extremely well. Entries under the floor must not
    // be judged on ratio at all, or ordinary files would be rejected.
    let filler_bytes = (COMPRESSION_RATIO_FLOOR_BYTES / 8) as usize;
    let filler = "<!-- ".to_string() + &"B".repeat(filler_bytes) + " -->";
    let model = format!("{}\n{filler}", benign_model());
    let mesh = threemf::parse_bytes(&package(&model, Vec::new()))
        .expect("a small, highly compressible package must still parse");
    assert_eq!(mesh.triangle_count(), 1);
}

#[test]
fn vendor_thumbnail_extraction_rejects_a_bomb() {
    let bomb = vec![0u8; 16 * 1024 * 1024];
    let data = package_with(vec![Part::bytes("Metadata/plate_1.png", bomb)]);
    let error = vendor::read_plate_thumbnails(&data)
        .expect_err("a bomb in a thumbnail part must be rejected");
    assert_eq!(error.code(), "limit.compression_ratio", "{error}");
}

// --- XML entity / DTD attacks ----------------------------------------------

#[test]
fn rejects_a_doctype_in_the_model_part() {
    let model = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE model [ <!ENTITY a \"aaaaaaaaaa\"> ]>\n{}",
        benign_model()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "limit.xml_doctype", "{error}");
}

#[test]
fn rejects_a_doctype_in_the_content_types_part() {
    // `[Content_Types].xml` is parsed for Production Extension packages, so the
    // DTD ban has to cover it too, not just the model part.
    let hostile_content_types = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE Types [ <!ENTITY x SYSTEM \"file:///etc/passwd\"> ]>\n{}",
        CONTENT_TYPES_XML
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let data = production_package(
        PRODUCTION_ROOT_MODEL,
        &[("3D/Objects/body.model", PRODUCTION_BODY_MODEL)],
        &hostile_content_types,
    );
    let error = parse_error(&data);
    assert_eq!(error.code(), "limit.xml_doctype", "{error}");
}

#[test]
fn rejects_a_doctype_in_an_external_model_part() {
    let hostile_body = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE model [ <!ENTITY x \"y\"> ]>\n{}",
        PRODUCTION_BODY_MODEL
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let data = production_package(
        PRODUCTION_ROOT_MODEL,
        &[("3D/Objects/body.model", &hostile_body)],
        CONTENT_TYPES_XML,
    );
    let error = parse_error(&data);
    assert_eq!(error.code(), "limit.xml_doctype", "{error}");
}

#[test]
fn the_benign_production_package_still_parses() {
    // Anchors the two tests above: without the injected DTD the same package
    // is accepted, so they are proving the DTD ban and nothing else.
    let data = production_package(
        PRODUCTION_ROOT_MODEL,
        &[("3D/Objects/body.model", PRODUCTION_BODY_MODEL)],
        CONTENT_TYPES_XML,
    );
    let mesh = threemf::parse_bytes(&data).expect("benign production package must parse");
    assert_eq!(mesh.triangle_count(), 1);
}

const PRODUCTION_ROOT_MODEL: &str = r#"<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="2" type="model" name="Assembly">
      <components>
        <component p:path="/3D/Objects/body.model" objectid="1"/>
      </components>
    </object>
  </resources>
  <build><item objectid="2"/></build>
</model>"#;

const PRODUCTION_BODY_MODEL: &str = r#"<?xml version="1.0"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model" name="Body">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh>
    </object>
  </resources>
  <build/>
</model>"#;

#[test]
fn rejects_a_doctype_in_the_relationships_part() {
    let hostile = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE Relationships [ <!ENTITY x \"y\"> ]>\n{}",
        RELS_XML.lines().skip(1).collect::<Vec<_>>().join("\n")
    );
    let data = zip_parts(&[
        Part::text(CONTENT_TYPES_PART, CONTENT_TYPES_XML),
        Part::text(RELATIONSHIPS_PART, &hostile),
        Part::text(DEFAULT_MODEL_PART, &benign_model()),
    ]);
    let error = parse_error(&data);
    assert_eq!(error.code(), "limit.xml_doctype", "{error}");
}

#[test]
fn rejects_a_doctype_in_a_vendor_config_part() {
    let hostile = r#"<?xml version="1.0"?>
<!DOCTYPE config [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>
<config><plate><metadata key="index" value="1"/></plate></config>"#;
    let data = package_with(vec![Part::text("Metadata/slice_info.config", hostile)]);
    let error = vendor::extract_bytes(&data).expect_err("a DTD in vendor config must be rejected");
    assert_eq!(error.code(), "limit.xml_doctype", "{error}");
}

// --- XML structure attacks -------------------------------------------------

#[test]
fn rejects_xml_nested_past_the_depth_limit() {
    let depth = MAX_XML_DEPTH + 8;
    let mut model = String::from(
        "<?xml version=\"1.0\"?>\n<model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>",
    );
    model.push_str(&"<wrap>".repeat(depth));
    model.push_str(&"</wrap>".repeat(depth));
    model.push_str("</resources><build/></model>");
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "limit.xml_depth", "{error}");
}

#[test]
fn accepts_xml_nested_just_below_the_depth_limit() {
    // Guards against an off-by-one that would reject legitimate documents.
    let depth = MAX_XML_DEPTH - 4;
    let mut model = String::from(
        "<?xml version=\"1.0\"?>\n<model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>",
    );
    model.push_str(&"<wrap>".repeat(depth));
    model.push_str(&"</wrap>".repeat(depth));
    model.push_str("</resources><build/></model>");
    let mesh = threemf::parse_bytes(&package(&model, Vec::new()))
        .expect("nesting below the limit must parse");
    assert_eq!(mesh.triangle_count(), 0);
}

#[test]
fn self_closing_elements_do_not_accumulate_depth() {
    // A million sibling empty elements are shallow, not deep; counting them as
    // nesting would reject large but legitimate meshes.
    let mut vertices = String::new();
    for i in 0..2000 {
        vertices.push_str(&format!("<vertex x=\"{i}\" y=\"0\" z=\"0\"/>"));
    }
    let mut triangles = String::new();
    for i in 0..1998 {
        triangles.push_str(&format!(
            "<triangle v1=\"{i}\" v2=\"{}\" v3=\"{}\"/>",
            i + 1,
            i + 2
        ));
    }
    let resources = format!(
        "<object id=\"1\" type=\"model\"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object>"
    );
    let model = model_document("millimeter", &resources, r#"<item objectid="1"/>"#);
    let mesh =
        threemf::parse_bytes(&package(&model, Vec::new())).expect("wide documents must parse");
    assert_eq!(mesh.vertex_count(), 2000);
    assert_eq!(mesh.triangle_count(), 1998);
}

// --- attacker-controlled numerics ------------------------------------------

#[test]
fn rejects_non_finite_vertex_coordinates() {
    // The corpus is deliberately built from a *property* — "parses successfully
    // and is non-finite" — rather than from spellings. A longer blocklist is
    // still a blocklist: the entries below carry no `inf`/`nan` substring, and
    // `3.5e38` additionally defeats a "reject anything with a big exponent"
    // heuristic, because it sits just past f32::MAX (~3.4028e38) and looks
    // entirely unremarkable.
    for poison in [
        "NaN",
        "inf",
        "-inf",
        "Infinity",
        "-Infinity",
        "1e999",
        "-1e999",
        "1E+400",
        "1e39",
        "-1e39",
        "3.5e38",
        "340282400000000000000000000000000000000000",
    ] {
        let resources = format!(
            r#"<object id="1" type="model"><mesh><vertices>
                 <vertex x="0" y="0" z="0"/>
                 <vertex x="{poison}" y="0" z="0"/>
                 <vertex x="0" y="1" z="0"/>
               </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#
        );
        let model = model_document("millimeter", &resources, r#"<item objectid="1"/>"#);
        let error = parse_error(&package(&model, Vec::new()));
        assert_eq!(
            error.code(),
            "non_finite_number",
            "'{poison}' must be rejected, got {error}"
        );
    }

    // The other direction, which is what keeps the loop above honest: the
    // largest finite f32 must still parse. Without this, a guard that rejected
    // every coordinate with a large exponent — or simply rejected everything —
    // would satisfy every assertion above while making legitimate large models
    // unopenable. `3.4e38` is finite and `3.5e38` is not, so the pair pins the
    // boundary from both sides.
    let resources = r#"<object id="1" type="model"><mesh><vertices>
                 <vertex x="0" y="0" z="0"/>
                 <vertex x="3.4e38" y="0" z="0"/>
                 <vertex x="0" y="1" z="0"/>
               </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>"#;
    let model = model_document("millimeter", resources, r#"<item objectid="1"/>"#);
    threemf::parse_bytes(&package(&model, Vec::new()))
        .expect("the largest finite f32 is not an attack and must still parse");
}

#[test]
fn rejects_non_finite_transform_components() {
    let resources = triangle_object("1", "Decoy");
    let model = model_document(
        "millimeter",
        &resources,
        r#"<item objectid="1" transform="1 0 0 0 1 0 0 0 1 NaN 0 0"/>"#,
    );
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "non_finite_number", "{error}");
}

#[test]
fn rejects_a_transform_that_would_produce_non_finite_vertices() {
    // Every component is finite, but the product overflows f32 at expansion
    // time. Catching it only at parse time would let infinities into bounds.
    let resources = format!(
        r#"<object id="1" type="model"><mesh><vertices>
             <vertex x="1e38" y="1e38" z="1e38"/>
             <vertex x="2e38" y="0" z="0"/>
             <vertex x="0" y="1" z="0"/>
           </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
{}"#,
        ""
    );
    let model = model_document(
        "millimeter",
        &resources,
        r#"<item objectid="1" transform="1e30 0 0 0 1 0 0 0 1 0 0 0"/>"#,
    );
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "non_finite_number", "{error}");
}

#[test]
fn rejects_out_of_range_triangle_indices() {
    let resources = r#"<object id="1" type="model"><mesh><vertices>
         <vertex x="0" y="0" z="0"/>
         <vertex x="1" y="0" z="0"/>
         <vertex x="0" y="1" z="0"/>
       </vertices><triangles><triangle v1="0" v2="1" v3="4294967295"/></triangles></mesh></object>"#;
    let model = model_document("millimeter", resources, r#"<item objectid="1"/>"#);
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "malformed", "{error}");
}

#[test]
fn rejects_triangle_indices_that_overflow_u32() {
    let resources = r#"<object id="1" type="model"><mesh><vertices>
         <vertex x="0" y="0" z="0"/>
         <vertex x="1" y="0" z="0"/>
         <vertex x="0" y="1" z="0"/>
       </vertices><triangles><triangle v1="0" v2="1" v3="99999999999999999999"/></triangles></mesh></object>"#;
    let model = model_document("millimeter", resources, r#"<item objectid="1"/>"#);
    let error = parse_error(&package(&model, Vec::new()));
    assert_eq!(error.code(), "malformed", "{error}");
}

// --- archive-shape attacks -------------------------------------------------

#[test]
fn rejects_entries_that_escape_the_package_root() {
    for hostile_name in [
        "../evil.txt",
        "3D/../../evil.txt",
        "/absolute.txt",
        "3D\\windows.txt",
        "./sneaky.txt",
    ] {
        let data = zip_parts(&[
            Part::text(CONTENT_TYPES_PART, CONTENT_TYPES_XML),
            Part::text(RELATIONSHIPS_PART, RELS_XML),
            Part::text(DEFAULT_MODEL_PART, &benign_model()),
            Part::text(hostile_name, "owned"),
        ]);
        let error = parse_error(&data);
        assert_eq!(
            error.code(),
            "malformed",
            "'{hostile_name}' must be rejected, got {error}"
        );
    }
}

#[test]
fn rejects_relationship_targets_that_escape_the_package_root() {
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/../../../../etc/passwd" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#;
    let data = zip_parts(&[
        Part::text(CONTENT_TYPES_PART, CONTENT_TYPES_XML),
        Part::text(RELATIONSHIPS_PART, rels),
        Part::text(DEFAULT_MODEL_PART, &benign_model()),
    ]);
    let error = parse_error(&data);
    assert!(
        matches!(error.code(), "malformed" | "missing_model_part"),
        "traversal in a relationship target must not resolve: {error}"
    );
}

// --- timeout and cancellation ----------------------------------------------

#[test]
fn an_expired_deadline_stops_parsing() {
    let data = package(&benign_model(), Vec::new());
    let limits = ParseLimits::default().with_timeout(Duration::from_nanos(1));
    thread::sleep(Duration::from_millis(2));
    let error = threemf::parse_bytes_with_limits(&data, limits)
        .expect_err("an expired deadline must stop the parse");
    assert_eq!(error.code(), "limit.timeout", "{error}");
}

#[test]
fn a_generous_deadline_lets_parsing_finish() {
    let data = package(&benign_model(), Vec::new());
    let limits = ParseLimits::default().with_timeout(Duration::from_secs(60));
    let mesh = threemf::parse_bytes_with_limits(&data, limits).expect("must parse in time");
    assert_eq!(mesh.triangle_count(), 1);
}

#[test]
fn a_tripped_cancellation_token_stops_parsing() {
    let data = package(&benign_model(), Vec::new());
    let token = CancellationToken::new();
    token.cancel();
    let limits = ParseLimits::default().with_cancellation(token);
    let error = threemf::parse_bytes_with_limits(&data, limits)
        .expect_err("a cancelled parse must not return a scene");
    assert_eq!(error.code(), "limit.cancelled", "{error}");
}

#[test]
fn cancellation_from_another_thread_is_observed() {
    let token = CancellationToken::new();
    let observer = token.clone();
    let handle = thread::spawn(move || {
        let mut guard = ParseGuard::new(ParseLimits::default().with_cancellation(observer));
        loop {
            guard.check_now()?;
            thread::sleep(Duration::from_millis(1));
        }
        #[allow(unreachable_code)]
        Ok::<(), model_core::limits::LimitViolation>(())
    });
    thread::sleep(Duration::from_millis(10));
    token.cancel();
    let outcome = handle.join().expect("worker thread panicked");
    assert_eq!(
        outcome
            .expect_err("worker must observe cancellation")
            .code(),
        "limit.cancelled"
    );
}

// --- budget accounting -----------------------------------------------------

#[test]
fn total_decompressed_budget_is_enforced_across_entries() {
    // Each entry is individually within its ratio allowance; together they blow
    // the aggregate budget. Tests the accumulator, not the per-entry check.
    let mut guard = ParseGuard::new(ParseLimits {
        max_total_decompressed_bytes: 1_000,
        ..ParseLimits::default().without_timeout()
    });
    guard.charge_decompressed(600).expect("first charge fits");
    let error = guard
        .charge_decompressed(600)
        .expect_err("the aggregate budget must be enforced");
    assert_eq!(error.code(), "limit.total_decompressed_bytes", "{error}");
}

#[test]
fn the_declared_preflight_and_the_running_accumulator_report_different_codes() {
    // Pinned as a property rather than left implied by two tests that each
    // assert their own string. "This archive honestly declares more than we
    // permit" and "this entry lied about its size" are different events - the
    // second is a far stronger hostility signal - and the caller has to be able
    // to tell them apart. Two separate equality assertions would survive
    // someone merging the codes back together, because whoever did it would
    // update both; asserting that they *differ* does not.
    let mut guard = ParseGuard::new(ParseLimits {
        max_total_decompressed_bytes: 1_000,
        ..ParseLimits::default().without_timeout()
    });
    let declared = guard
        .check_declared_archive_total(2_000)
        .expect_err("a declared total over budget must be rejected");
    let charged = guard
        .charge_decompressed(2_000)
        .expect_err("an actual total over budget must be rejected");
    assert_ne!(
        declared.code(),
        charged.code(),
        "the preflight and the accumulator must stay distinguishable"
    );
}
// --- diagnostics -----------------------------------------------------------

#[test]
fn a_hostile_package_stays_distinguishable_from_a_broken_one_at_the_scene_layer() {
    // Corruption diagnostics are only useful if they survive the wrapping the
    // RPC layer does. A zip bomb must not degrade into a generic "3mf parse
    // error" that the Electron side cannot tell apart from a truncated file.
    let dir = tempfile::tempdir().expect("tempdir");
    let hostile = dir.path().join("bomb.3mf");
    let broken = dir.path().join("broken.3mf");
    fs::write(
        &hostile,
        package_with(vec![Part::bytes(
            "Metadata/unused_blob.png",
            vec![0u8; 16 * 1024 * 1024],
        )]),
    )
    .expect("write hostile package");
    fs::write(&broken, b"not a zip at all").expect("write broken package");

    let hostile_code = scene::load_scene(&hostile)
        .expect_err("a zip bomb must be rejected")
        .code();
    let broken_code = scene::load_scene(&broken)
        .expect_err("a non-package must be rejected")
        .code();

    assert_eq!(hostile_code, "threemf.limit.compression_ratio");
    assert_eq!(broken_code, "threemf.malformed");
    assert_ne!(hostile_code, broken_code);
}

// --- ZIP64 trailer ---------------------------------------------------------

fn read_u32_at(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().expect("four bytes"))
}

/// Rebuild `data`'s trailer as a ZIP64 package declaring `total_entries`
/// entries. With the honest count this is a valid ZIP64 archive; with an
/// inflated one it is the classic "declare four billion entries and let the
/// reader preallocate for them" attack, which a 16-bit EOCD cannot express.
fn with_zip64_trailer(data: &[u8], total_entries: u64) -> Vec<u8> {
    const EOCD_SIZE: usize = 22;
    let eocd = data.len() - EOCD_SIZE;
    assert_eq!(
        &data[eocd..eocd + 4],
        b"PK\x05\x06",
        "fixture builder must emit a comment-less EOCD"
    );
    let central_size = u64::from(read_u32_at(data, eocd + 12));
    let central_offset = u64::from(read_u32_at(data, eocd + 16));
    let central_end = usize::try_from(central_offset + central_size).expect("central end");

    let mut out = data[..central_end].to_vec();
    let zip64_eocd = central_end as u64;

    // ZIP64 end-of-central-directory record: 56 bytes, whose size field
    // excludes its own 12-byte prefix.
    out.extend_from_slice(b"PK\x06\x06");
    out.extend_from_slice(&44u64.to_le_bytes());
    out.extend_from_slice(&45u16.to_le_bytes());
    out.extend_from_slice(&45u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&total_entries.to_le_bytes());
    out.extend_from_slice(&total_entries.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());

    // ZIP64 locator.
    out.extend_from_slice(b"PK\x06\x07");
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&zip64_eocd.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());

    // EOCD carrying the sentinels that hand parsing to the ZIP64 record.
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&u16::MAX.to_le_bytes());
    out.extend_from_slice(&u16::MAX.to_le_bytes());
    out.extend_from_slice(&u32::MAX.to_le_bytes());
    out.extend_from_slice(&u32::MAX.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[test]
fn an_honest_zip64_package_still_parses() {
    // The entry-count ceiling must reject hostile declarations without
    // blanket-rejecting ZIP64, which large legitimate packages rely on.
    let base = package_with(Vec::new());
    let entries = u64::from(read_u32_at(&base, base.len() - 22 + 10) & 0xFFFF);
    let zip64 = with_zip64_trailer(&base, entries);
    let mesh = threemf::parse_bytes(&zip64).expect("a valid ZIP64 package must parse");
    assert!(!mesh.vertices.is_empty(), "ZIP64 package lost its geometry");
}

#[test]
fn rejects_a_zip64_trailer_declaring_an_impossible_entry_count() {
    // Only ZIP64 can express a count past 65535, so this is the only route to
    // the entry ceiling. Reaching the assertion at all proves the reader
    // refused before sizing a collection from the attacker's number.
    let base = package_with(Vec::new());
    for declared in [1u64 << 40, u64::MAX] {
        let error = parse_error(&with_zip64_trailer(&base, declared));
        assert_eq!(
            error.code(),
            "too_large",
            "declared {declared} entries: {error}"
        );
    }
}

// --- vendor entry points share the archive preflight ------------------------

/// Every public reader must apply the same archive-wide limits. A vendor entry
/// point that opens the ZIP itself is a second door into the package with none
/// of them, so each door gets the same hostile package.
#[test]
fn every_vendor_entry_point_rejects_a_bomb_the_scene_path_rejects() {
    // Deliberately NOT a .png: the thumbnail collector only ratio-checked image
    // parts, so an attacker just renames the bomb and walks through.
    let data = package_with(vec![Part::bytes(
        "Metadata/payload.bin",
        vec![0u8; 16 * 1024 * 1024],
    )]);

    assert_eq!(
        threemf::parse_bytes(&data)
            .expect_err("scene path must reject the bomb")
            .code(),
        "limit.compression_ratio"
    );

    type Door<'a> = (&'a str, Box<dyn Fn() -> Result<(), ThreeMfError> + 'a>);
    let doors: Vec<Door<'_>> = vec![
        (
            "extract_bytes",
            Box::new(|| vendor::extract_bytes(&data).map(|_| ())),
        ),
        (
            "read_plate_thumbnails",
            Box::new(|| vendor::read_plate_thumbnails(&data).map(|_| ())),
        ),
        (
            "read_part_bytes",
            Box::new(|| vendor::read_part_bytes(&data, "Metadata/payload.bin").map(|_| ())),
        ),
        (
            "is_vendor_project",
            Box::new(|| vendor::is_vendor_project(&data).map(|_| ())),
        ),
    ];
    for (name, call) in doors {
        let error = call().expect_err(&format!("{name} must reject the bomb too"));
        assert_eq!(
            error.code(),
            "limit.compression_ratio",
            "{name} let the bomb through: {error}"
        );
    }
}

#[test]
fn vendor_entry_points_still_accept_a_benign_project() {
    // The preflight must not turn into a blanket rejection of real projects.
    let data = package_with(vec![Part::text(
        "Metadata/slice_info.config",
        "<?xml version=\"1.0\"?><config/>",
    )]);
    vendor::extract_bytes(&data).expect("a benign vendor project must still parse");
    assert!(vendor::is_vendor_project(&data).expect("vendor detection must still work"));
    assert!(vendor::read_plate_thumbnails(&data)
        .expect("thumbnail extraction must still work")
        .is_empty());
}

#[test]
fn rejects_an_archive_whose_declared_expansion_blows_the_budget_in_aggregate() {
    // End-to-end companion to the unit-level accumulator test: every entry sits
    // under the ratio floor, so only aggregate accounting can catch this.
    //
    // This trips the *declared* preflight, not the running accumulator: the
    // preflight sums every entry while the accumulator counts only overflow
    // beyond a declaration, so for an honest archive the preflight always wins.
    // The accumulator's own path is covered by
    // `an_entry_that_lies_about_its_size_is_charged_what_it_actually_produced`,
    // and the two now report distinct codes so each test names its own control.
    let limits = ParseLimits {
        max_total_decompressed_bytes: 4 * 1024 * 1024,
        ..ParseLimits::default().without_timeout()
    };
    let filler = "x".repeat(1024 * 1024);
    let parts: Vec<Part> = (0..8)
        .map(|i| Part::text(&format!("Metadata/pad_{i}.txt"), &filler))
        .collect();
    let data = package_with(parts);
    let error = threemf::parse_bytes_with_limits(&data, limits)
        .expect_err("the aggregate declared expansion must be rejected");
    assert_eq!(error.code(), "limit.declared_decompressed_bytes", "{error}");
}

/// Rewrite the declared uncompressed size of `part`, in both the central
/// directory and the local header, leaving the compressed stream untouched.
///
/// Models the case the declared-size preflight cannot catch: an archive that
/// under-declares what it will produce. Declared sizes are attacker-controlled,
/// so a package can promise a kilobyte and deliver megabytes.
fn forge_declared_size(data: &[u8], part: &str, declared: u32) -> Vec<u8> {
    let mut out = data.to_vec();
    let name = part.as_bytes();
    let mut patched = false;
    for i in 0..out.len().saturating_sub(46) {
        if &out[i..i + 4] != b"PK\x01\x02" {
            continue;
        }
        let name_len = u16::from_le_bytes([out[i + 28], out[i + 29]]) as usize;
        if out.get(i + 46..i + 46 + name_len) != Some(name) {
            continue;
        }
        let local_offset =
            u32::from_le_bytes([out[i + 42], out[i + 43], out[i + 44], out[i + 45]]) as usize;
        out[i + 24..i + 28].copy_from_slice(&declared.to_le_bytes());
        out[local_offset + 22..local_offset + 26].copy_from_slice(&declared.to_le_bytes());
        patched = true;
    }
    assert!(patched, "forged fixture must actually contain {part}");
    out
}

#[test]
fn an_entry_that_lies_about_its_size_is_charged_what_it_actually_produced() {
    // The declared-size preflight is only as honest as the archive. This entry
    // declares a kilobyte and delivers megabytes, so the preflight waves it
    // through and only the running accumulator can catch it.
    let mut vertices = String::new();
    for i in 0..48_000 {
        vertices.push_str(&format!(
            "          <vertex x=\"{i}.5\" y=\"0\" z=\"0\"/>\n"
        ));
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
{vertices}        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>"#
    );
    let honest = package(&model, Vec::new());
    let declared = 1024;
    let forged = forge_declared_size(&honest, "3D/3dmodel.model", declared);

    let limits = ParseLimits {
        max_total_decompressed_bytes: 1024 * 1024,
        ..ParseLimits::default().without_timeout()
    };
    // The lie is what makes this reachable: honestly declared, the preflight
    // would reject it before a byte was read.
    assert!(
        model.len() as u64 > limits.max_total_decompressed_bytes,
        "the entry must actually produce more than the whole budget"
    );
    // And this is why the rejection below can only come from the accumulator:
    // the declared total the preflight sees is orders of magnitude under the
    // budget, so the preflight necessarily passes.
    assert!(
        u64::from(declared) * 64 < limits.max_total_decompressed_bytes,
        "the forged declaration must leave the preflight no reason to object"
    );
    let error = threemf::parse_bytes_with_limits(&forged, limits.clone())
        .expect_err("an under-declared entry must still be caught while it is read");
    // The accumulator's own code, not one shared with the preflight. This is
    // the direct assertion; the twin below is the independent one.
    assert_eq!(error.code(), "limit.total_decompressed_bytes", "{error}");

    // Second, independent line of evidence, held deliberately alongside the
    // code assertion rather than replaced by it. The code proves which control
    // fired *given* the codes stay distinct; the twin proves it even if they
    // are ever merged back. Each covers the other's failure mode.
    //
    // This twin declares *exactly* what the rejected package declares - the
    // preflight sums declared sizes and reads nothing else, so the two archives
    // are indistinguishable from where it stands. They differ only in what they
    // actually deliver. So if the twin parses under the same budget that
    // rejected the other, the rejection cannot have come from the preflight: no
    // control that sees only declarations can separate these two inputs.
    let small = package(
        &model_document(
            "millimeter",
            &triangle_object("1", "Honest"),
            r#"<item objectid="1"/>"#,
        ),
        Vec::new(),
    );
    let twin = forge_declared_size(&small, "3D/3dmodel.model", declared);
    assert_eq!(
        declared_total(&twin),
        declared_total(&forged),
        "the twins must be indistinguishable to a control that only reads declared sizes"
    );
    threemf::parse_bytes_with_limits(&twin, limits.clone())
        .expect("an identical declared profile must pass, isolating the accumulator");

    // And the same package parses when the budget genuinely accommodates it,
    // so the guard is charging real overflow rather than rejecting any lie.
    threemf::parse_bytes_with_limits(
        &forged,
        ParseLimits {
            max_total_decompressed_bytes: 64 * 1024 * 1024,
            ..limits
        },
    )
    .expect("a generous budget must still accept the same package");
}

/// Sum of every entry's *declared* uncompressed size — precisely the view of an
/// archive that the declared-size preflight gets, and nothing more.
fn declared_total(data: &[u8]) -> u64 {
    let mut archive = zip::ZipArchive::new(Cursor::new(data)).expect("archive opens");
    (0..archive.len())
        .map(|i| archive.by_index(i).expect("entry").size())
        .sum()
}

// --- ratio cap boundary -----------------------------------------------------

#[test]
fn ratio_cap_rejects_a_fractional_overshoot() {
    // Integer division truncates: 4_194_305 / 13_935 is 300.99, which computes
    // as 300 and slips past a 300:1 cap. Cross-multiplication catches it.
    let guard = ParseGuard::new(ParseLimits::default().without_timeout());
    let limit = ParseLimits::default().max_compression_ratio;
    // Hicks's exact case: one byte past the ratio floor, at 300.99:1.
    let compressed = 13_935u64;
    let just_over = COMPRESSION_RATIO_FLOOR_BYTES + 1;
    assert!(
        just_over > limit * compressed,
        "the fixture numbers must actually exceed the cap"
    );
    assert_eq!(
        just_over / compressed,
        limit,
        "and must truncate to exactly the cap, which is what used to let them pass"
    );

    let error = guard
        .check_ratio("part", compressed, just_over)
        .expect_err("a fractional overshoot must still be rejected");
    assert_eq!(error.code(), "limit.compression_ratio", "{error}");
    assert!(
        error.to_string().contains(&format!("{}x", limit + 1)),
        "the reported ratio must not read as within the cap it failed: {error}"
    );

    // Exactly at the cap still passes, above the floor so the check applies.
    let compressed = 20_000u64;
    guard
        .check_ratio("part", compressed, limit * compressed)
        .expect("exactly at the cap must pass");
}

#[test]
fn ratio_cap_allowance_cannot_overflow_into_a_false_rejection() {
    let guard = ParseGuard::new(ParseLimits::default().without_timeout());
    // limit * compressed overflows u64, so no real payload can exceed it.
    guard
        .check_ratio("part", u64::MAX / 2, u64::MAX)
        .expect("an overflowing allowance must not reject");
}

// --- appearance resources are attacker-controlled too -----------------------

fn model_with_resources(resources: &str, object_attrs: &str, triangle_attrs: &str) -> Vec<u8> {
    let model = format!(
        r##"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
{resources}
    <object id="1" type="model"{object_attrs}>
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"{triangle_attrs}/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>"##
    );
    package(&model, Vec::new())
}

#[test]
fn a_dangling_appearance_reference_costs_a_colour_not_the_model() {
    // An exporter that names a resource it never wrote must not brick the file.
    let data = model_with_resources("", r#" pid="999" pindex="7""#, r#" pid="999" p1="3""#);
    let mesh = threemf::parse_bytes(&data).expect("geometry must survive a dangling reference");
    assert_eq!(mesh.triangle_count(), 1);
    assert_eq!(mesh.objects[0].material.base_color, None);
}

#[test]
fn an_out_of_range_appearance_index_does_not_panic() {
    // `pindex` is an unchecked attacker-controlled index into a Vec.
    let resources =
        r##"    <basematerials id="10"><base name="PLA" displaycolor="#FF0000"/></basematerials>"##;
    let data = model_with_resources(resources, r#" pid="10" pindex="4294967295""#, "");
    let mesh = threemf::parse_bytes(&data).expect("an out-of-range index must not be fatal");
    assert_eq!(mesh.objects[0].material.base_color, None);
}

#[test]
fn an_unreadable_colour_value_leaves_the_appearance_absent() {
    // Renamed from `malformed_colour_values_are_ignored_rather_than_fatal`,
    // whose assertion contradicted its own message: it said "fall back rather
    // than poison the scene" while pinning `Some([0, 0, 0])`. Black *is* a
    // poisoned colour. It is a real value that renders confidently and is
    // indistinguishable from a material that is genuinely black, so the viewer
    // cannot tell it was invented. Absent is the only answer that stays honest.
    for value in ["", "#", "not-a-colour", "#GGGGGG", "#12345", "#1234567890"] {
        let resources = format!(
            r##"    <basematerials id="10"><base name="X" displaycolor="{value}"/></basematerials>"##
        );
        let data = model_with_resources(&resources, r#" pid="10" pindex="0""#, "");
        let mesh = threemf::parse_bytes(&data)
            .unwrap_or_else(|e| panic!("colour {value:?} must not be fatal: {e}"));
        assert_eq!(
            mesh.objects[0].material.base_color, None,
            "colour {value:?} must leave the appearance absent, never invent one"
        );
        // Geometry is untouched: this costs a colour, not the model.
        assert_eq!(mesh.triangle_count(), 1, "colour {value:?}");
        // And it is not silent either - the third option the old name did not
        // admit exists.
        assert_eq!(
            mesh.status,
            SceneLoadStatus::Partial,
            "colour {value:?} must degrade the load status"
        );
        assert!(
            !mesh.status_messages.is_empty(),
            "colour {value:?} must surface a diagnostic"
        );
    }

    // The control: a readable colour in the same markup still resolves, so the
    // assertions above cannot be passing because nothing ever resolves.
    let resources =
        r##"    <basematerials id="10"><base name="X" displaycolor="#112233"/></basematerials>"##;
    let data = model_with_resources(resources, r#" pid="10" pindex="0""#, "");
    let mesh = threemf::parse_bytes(&data).expect("a readable colour must parse");
    assert_eq!(
        mesh.objects[0].material.base_color,
        Some([0x11, 0x22, 0x33])
    );
    assert_eq!(mesh.status, SceneLoadStatus::Complete);
    assert!(mesh.status_messages.is_empty());
}

#[test]
fn an_unreadable_appearance_reference_clears_the_appearance_and_is_reported() {
    // Renamed from `a_malformed_appearance_index_is_reported_not_silently_dropped`.
    // That name encoded a false dichotomy - *fatal* or *silently dropped* - and
    // the correct answer is the third option it did not admit exists: clear the
    // appearance, keep the geometry, and say so. A name that forecloses the
    // right answer actively resists the right fix, which is why the fatal path
    // survived review this long.
    //
    // Aborting the whole parse was never buying safety, because the sibling
    // path for a *dangling* reference already resolved to nothing without
    // complaint. It was an availability bug wearing a security hat, and an
    // attacker-triggerable one: a single junk attribute anywhere in a part
    // denied display of everything in it.
    let resources =
        r##"    <basematerials id="10"><base name="X" displaycolor="#112233"/></basematerials>"##;
    for (object_attrs, triangle_attrs, what) in [
        (r#" pid="not-a-number""#, "", "object pid"),
        (r#" pid="10" pindex="not-a-number""#, "", "object pindex"),
        ("", r#" pid="not-a-number" p1="0""#, "triangle pid"),
        ("", r#" pid="10" p1="not-a-number""#, "triangle p1"),
    ] {
        let data = model_with_resources(resources, object_attrs, triangle_attrs);
        let mesh = threemf::parse_bytes(&data)
            .unwrap_or_else(|e| panic!("an unreadable {what} must not be fatal: {e}"));
        assert_eq!(mesh.triangle_count(), 1, "{what}: geometry must survive");
        assert_eq!(
            mesh.objects[0].material.base_color, None,
            "{what}: the appearance must be cleared, not guessed"
        );
        assert_eq!(
            mesh.objects[0].material.face_colors, None,
            "{what}: no face may be given an invented colour"
        );
        assert_eq!(
            mesh.status,
            SceneLoadStatus::Partial,
            "{what}: the load status must record the degradation"
        );
        assert!(
            !mesh.status_messages.is_empty(),
            "{what}: the corruption must be surfaced, not swallowed"
        );
    }
}

#[test]
fn an_unreadable_pindex_does_not_fall_back_to_entry_zero() {
    // The specific mis-attribution an "ignore it and carry on" fix invites.
    // An *absent* `pindex` legitimately means entry 0, so the lazy reading of
    // "treat unreadable as absent" would paint the object in entry 0's colour -
    // a real material belonging to something else, applied confidently.
    let resources = r##"    <basematerials id="10">
      <base name="First" displaycolor="#112233"/>
      <base name="Second" displaycolor="#445566"/>
    </basematerials>"##;

    // Absent: entry 0, per the spec.
    let data = model_with_resources(resources, r#" pid="10""#, "");
    let mesh = threemf::parse_bytes(&data).expect("an absent pindex is legal");
    assert_eq!(
        mesh.objects[0].material.base_color,
        Some([0x11, 0x22, 0x33]),
        "an absent pindex must still mean entry 0"
    );

    // Unreadable: nothing. The two must not collapse onto the same behaviour.
    let data = model_with_resources(resources, r#" pid="10" pindex="?""#, "");
    let mesh = threemf::parse_bytes(&data).expect("an unreadable pindex must not be fatal");
    assert_eq!(
        mesh.objects[0].material.base_color, None,
        "an unreadable pindex must clear the reference, not resolve to entry 0"
    );
}

#[test]
fn appearance_leniency_does_not_extend_to_geometry() {
    // The hazard in any "be more lenient" change is the leniency leaking. A
    // colour we cannot read costs a colour; a coordinate or vertex index we
    // cannot read means we do not know the shape, and a guess there puts wrong
    // triangles on a print plate. These must stay fatal, and this test exists
    // to fail loudly if the cosmetic path is ever widened to reach them.
    // Every fixture below carries four real vertices, and each junk attribute is
    // positioned so that a leniently-defaulted 0 would still be *in range* and
    // still form a non-degenerate triangle. That is load-bearing: the first
    // version of this test had a single vertex and `v2="1" v3="2"`, so a
    // defaulted `v1` produced `[0,1,2]` and the downstream out-of-range vertex
    // check rejected it. The test passed while the leniency it exists to detect
    // had already leaked — a different control was firing. Mutation-verified:
    // routing `v1` through the cosmetic parser now fails this test.
    const VERTICES: &str = r#"<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>"#;
    let geometry_attacks = [
        (
            "vertex x",
            format!(r#"<vertex x="junk" y="0" z="0"/>{VERTICES}"#),
            r#"<triangle v1="1" v2="2" v3="3"/>"#.to_string(),
            r#"<vertex x="0" y="0" z="0"/>"#,
        ),
        (
            "triangle v1",
            VERTICES.to_string(),
            r#"<triangle v1="junk" v2="1" v3="2"/>"#.to_string(),
            r#"<triangle v1="3" v2="1" v3="2"/>"#,
        ),
        (
            "triangle v3",
            VERTICES.to_string(),
            r#"<triangle v1="1" v2="2" v3="junk"/>"#.to_string(),
            r#"<triangle v1="1" v2="2" v3="3"/>"#,
        ),
    ];
    for (label, vertices, triangles, repaired) in geometry_attacks {
        let build = |vertices: &str, triangles: &str| {
            let model = format!(
                r##"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>{vertices}</vertices>
        <triangles>{triangles}</triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>"##
            );
            package(&model, Vec::new())
        };

        assert_eq!(
            parse_error(&build(&vertices, &triangles)).code(),
            "malformed",
            "{label}: malformed geometry must stay fatal"
        );

        // The control that pins *why* it was rejected. Replace only the junk
        // with the value leniency would have invented, leaving the document
        // otherwise byte-identical: it must parse. So the rejection above is
        // attributable to the unreadable attribute and nothing downstream.
        let (fixed_vertices, fixed_triangles) = if label == "vertex x" {
            (
                vertices.replacen(r#"<vertex x="junk" y="0" z="0"/>"#, repaired, 1),
                triangles.clone(),
            )
        } else {
            (vertices.clone(), repaired.to_string())
        };
        threemf::parse_bytes(&build(&fixed_vertices, &fixed_triangles)).unwrap_or_else(|e| {
            panic!("{label}: the repaired document must parse, or the fixture proves nothing: {e}")
        });
    }

    // The mirror image, so this test proves a *boundary* rather than just
    // "some things are fatal": the identical junk in a cosmetic attribute is
    // survivable in the very same document shape.
    let data = model_with_resources("", r#" pid="junk""#, "");
    threemf::parse_bytes(&data).expect("the same junk in a cosmetic attribute must not be fatal");
}

#[test]
fn alpha_is_accepted_and_discarded() {
    let resources =
        r##"    <basematerials id="10"><base name="X" displaycolor="#0A141EFF"/></basematerials>"##;
    let data = model_with_resources(resources, r#" pid="10" pindex="0""#, "");
    let mesh = threemf::parse_bytes(&data).expect("8-digit colours are legal");
    assert_eq!(mesh.objects[0].material.base_color, Some([10, 20, 30]));
}

#[test]
fn rejects_an_unbounded_appearance_entry_count() {
    // Covers the *entry* dimension only — see
    // `rejects_an_unbounded_appearance_group_count` for the other axis. The
    // original name said "appearance table", which read as covering both and
    // is how the group dimension stayed uncapped behind a passing test.
    //
    // Each entry carries an owned name, so an unbounded table is cheap
    // memory amplification from a small compressed payload. Colours are
    // distinct so the archive does not compress well enough to trip the
    // ratio guard first — this must fail on the appearance cap itself.
    let entries = model_core::threemf::MAX_APPEARANCE_ENTRIES + 1;
    let mut resources = String::with_capacity(entries * 32 + 64);
    resources.push_str("    <m:colorgroup xmlns:m=\"http://schemas.microsoft.com/3dmanufacturing/material/2015/02\" id=\"11\">\n");
    for index in 0..entries {
        resources.push_str(&format!(
            "      <m:color color=\"#{:06X}\"/>\n",
            index % 0x00FF_FFFF
        ));
    }
    resources.push_str("    </m:colorgroup>");
    // The mirror of the isolating property below: one group, so the group cap
    // cannot be what rejects this.
    assert_eq!(resources.matches("<m:colorgroup").count(), 1);
    let data = model_with_resources(&resources, "", "");
    assert_eq!(parse_error(&data).code(), "too_large");
}

/// `count` appearance groups carrying no `<base>`/`<color>` children at all.
///
/// The absence of entries is the whole point. Both appearance caps surface as
/// `too_large`, so an assertion on the code cannot say which one fired — the
/// same ambiguity the declared-size preflight and the decompression accumulator
/// have. An input that charges the entry budget exactly zero times can only be
/// rejected by the group cap, which makes the isolation structural rather than
/// a claim in a comment.
fn empty_appearance_groups(count: usize) -> String {
    let mut resources = String::with_capacity(count * 40 + 64);
    for index in 0..count {
        resources.push_str("    <colorgroup id=\"");
        resources.push_str(&(index + 100).to_string());
        // Terminated rather than self-closing: this is the shape that actually
        // reaches the insert and retains a map entry, so the fixture is the
        // real amplification primitive and not just a counter exercise.
        resources.push_str("\"></colorgroup>\n");
    }
    assert!(
        !resources.contains("<color ") && !resources.contains("<base "),
        "the isolating property is that this charges the entry budget zero times"
    );
    resources
}

#[test]
fn rejects_an_unbounded_appearance_group_count() {
    // Capping entries does not cap groups. An empty group charges nothing
    // against MAX_APPEARANCE_ENTRIES while still costing a retained map entry,
    // so until this cap existed the group dimension was bounded only by the
    // XML size caps — three orders of magnitude looser than the stated
    // aggregate memory ceiling.
    let resources = empty_appearance_groups(model_core::threemf::MAX_APPEARANCE_GROUPS + 1);
    let data = model_with_resources(&resources, "", "");
    let error = parse_error(&data);
    assert_eq!(error.code(), "too_large", "{error}");
}

#[test]
fn the_documented_maximum_appearance_group_count_still_parses() {
    // The other side of the boundary, at the documented maximum rather than a
    // convenient number: a cap that degrades into blanket rejection is an
    // availability bug wearing a security hat.
    let resources = empty_appearance_groups(model_core::threemf::MAX_APPEARANCE_GROUPS);
    let data = model_with_resources(&resources, "", "");
    let mesh = threemf::parse_bytes(&data).expect("the documented maximum must still parse");
    assert_eq!(mesh.triangle_count(), 1);
}

#[test]
fn rejects_an_oversized_material_name() {
    let name = "A".repeat(64 * 1024);
    let resources = format!(
        r##"    <basematerials id="10"><base name="{name}" displaycolor="#FFFFFF"/></basematerials>"##
    );
    let data = model_with_resources(&resources, r#" pid="10" pindex="0""#, "");
    assert_eq!(parse_error(&data).code(), "too_large");
}

#[test]
fn an_out_of_range_per_triangle_index_does_not_mis_index() {
    // The case that matters most: the resource group is real and non-empty, so
    // a per-face index is genuinely used to index it. An out-of-range `p1` must
    // yield no colour — never a panic, and never the wrong entry silently.
    let resources = r##"    <m:colorgroup xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" id="11">
      <m:color color="#112233"/>
      <m:color color="#445566"/>
    </m:colorgroup>"##;
    for index in ["2", "99", "4294967295"] {
        let attrs = format!(r#" pid="11" p1="{index}""#);
        let data = model_with_resources(resources, "", &attrs);
        let mesh = threemf::parse_bytes(&data)
            .unwrap_or_else(|e| panic!("p1={index} must not be fatal: {e}"));
        // Asserted outright rather than under `if let Some(face)`. The old
        // conditional made the whole check vacuous the moment the colours were
        // absent, which is exactly the case it most needed to pin.
        assert_eq!(
            mesh.objects[0].material.face_colors, None,
            "p1={index} must leave the face colours absent"
        );
        assert_eq!(
            mesh.triangle_count(),
            1,
            "p1={index}: geometry must survive"
        );
        assert_eq!(
            mesh.status,
            SceneLoadStatus::Partial,
            "p1={index} must be reported, not swallowed"
        );
    }

    // The case this test claimed to cover and did not. With no object-level
    // material the fallback had nothing to fall back *to*, so a failed lookup
    // landed on black and the assertions above passed for the wrong reason.
    // Give the object a real material and the old `.or(base_color)` path
    // silently paints the face in it — a neighbour's colour, indistinguishable
    // from a deliberate one. A test aimed at the right risk still only measures
    // the axis you thought to vary.
    for index in ["2", "99", "4294967295"] {
        let attrs = format!(r#" pid="11" p1="{index}""#);
        let data = model_with_resources(resources, r#" pid="11" pindex="0""#, &attrs);
        let mesh = threemf::parse_bytes(&data)
            .unwrap_or_else(|e| panic!("p1={index} with a base material must not be fatal: {e}"));
        assert_eq!(
            mesh.objects[0].material.base_color,
            Some([0x11, 0x22, 0x33]),
            "p1={index}: the object's own valid material must be unaffected"
        );
        assert_eq!(
            mesh.objects[0].material.face_colors, None,
            "p1={index} must not inherit the object's colour to cover a failed lookup"
        );
    }

    // ...and the same markup with an in-range index still resolves, so the
    // assertions above are not passing merely because nothing is ever resolved.
    let data = model_with_resources(resources, "", r#" pid="11" p1="1""#);
    let mesh = threemf::parse_bytes(&data).expect("an in-range index must resolve");
    let face = mesh.objects[0]
        .material
        .face_colors
        .as_ref()
        .expect("an in-range per-face index must produce face colours");
    assert_eq!(face[0], [0x44, 0x55, 0x66]);
    assert_eq!(
        mesh.status,
        SceneLoadStatus::Complete,
        "a clean resolve must not be reported as degraded"
    );
}

// --- the availability half of the limits ------------------------------------

/// A ceiling that degrades into blanket rejection of large legitimate models is
/// an availability bug wearing a security hat. Generated rather than checked in
/// so the repository stays sane, and sized well past the checked-in fixture.
#[test]
fn a_realistically_large_model_is_accepted_within_the_default_budget() {
    const N: usize = 360;
    let mut vertices = String::with_capacity((N + 1) * (N + 1) * 48);
    for row in 0..=N {
        for col in 0..=N {
            vertices.push_str(&format!(
                "          <vertex x=\"{}.5\" y=\"{}.25\" z=\"0\"/>\n",
                col, row
            ));
        }
    }
    let mut triangles = String::with_capacity(N * N * 104);
    for row in 0..N {
        for col in 0..N {
            let a = row * (N + 1) + col;
            let (b, c, d) = (a + 1, a + N + 1, a + N + 2);
            triangles.push_str(&format!(
                "          <triangle v1=\"{a}\" v2=\"{b}\" v3=\"{d}\"/>\n          <triangle v1=\"{a}\" v2=\"{d}\" v3=\"{c}\"/>\n"
            ));
        }
    }
    let model = format!(
        r##"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" name="Stress grid" type="model">
      <mesh>
        <vertices>
{vertices}        </vertices>
        <triangles>
{triangles}        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>"##
    );
    assert!(
        model.len() as u64 > 4 * COMPRESSION_RATIO_FLOOR_BYTES,
        "the stress model must clear the ratio floor by a wide margin, got {} bytes",
        model.len()
    );

    let data = package(&model, Vec::new());
    let mesh = threemf::parse_bytes(&data)
        .expect("a large but entirely legitimate model must not be rejected");
    assert_eq!(mesh.vertex_count(), (N + 1) * (N + 1));
    assert_eq!(mesh.triangle_count(), N * N * 2);
}
