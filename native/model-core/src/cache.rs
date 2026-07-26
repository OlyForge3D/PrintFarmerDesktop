//! Cache versioning for derived model artifacts.
//!
//! Scenes and thumbnails are expensive to produce, so the desktop app caches
//! them keyed by content hash. A content hash alone is not a safe cache key:
//! the *same* bytes can normalize to a different scene after a parser change,
//! and a stale cached scene is exactly how a security fix silently fails to
//! take effect. Every derived artifact is therefore keyed by content hash *and*
//! a recipe string produced here.
//!
//! Three inputs make up a recipe:
//!
//! * [`crate::scene::SCENE_DTO_VERSION`] — the shape of the serialized scene.
//! * [`PARSER_SEMANTICS_VERSION`] — bumped whenever parsing or normalization
//!   changes the *values* in an otherwise identically-shaped DTO, including
//!   when a security limit starts rejecting input that used to be accepted.
//! * [`crate::thumbnail`] render inputs, for thumbnail recipes.

use crate::scene::SCENE_DTO_VERSION;
use sha2::{Digest, Sha256};

/// Bumped whenever the parsers or the scene normalizer change the values they
/// produce for unchanged input bytes.
///
/// History:
/// * `1` — initial pipeline (STL/3MF/OBJ/STEP).
/// * `2` — issue #20 security hardening: non-finite coordinates, DTD-bearing
///   XML, over-deep XML and decompression bombs are now rejected, so packages
///   that previously produced a (poisoned) scene now fail to parse.
pub const PARSER_SEMANTICS_VERSION: u32 = 2;

/// Bumped whenever the thumbnail renderer changes the pixels it produces for an
/// unchanged scene.
///
/// Distinct from [`PARSER_SEMANTICS_VERSION`] because the two move
/// independently: a camera, projection, lighting or rasterization change alters
/// every cached thumbnail while leaving scene DTOs untouched. Without this a
/// renderer change silently reuses stale pixels forever.
///
/// History:
/// * `1` — initial deterministic orthographic renderer.
pub const THUMBNAIL_RENDERER_VERSION: u32 = 1;

/// Recipe for a cached scene DTO.
pub fn scene_cache_recipe() -> String {
    scene_recipe_for(SCENE_DTO_VERSION, PARSER_SEMANTICS_VERSION)
}

fn scene_recipe_for(scene_dto_version: u32, parser_semantics_version: u32) -> String {
    format!("scene/v{scene_dto_version}.{parser_semantics_version}")
}

/// Recipe for a cached thumbnail rendered at `size` pixels square.
pub fn thumbnail_cache_recipe(size: u32) -> String {
    format!(
        "{}/thumb-v{THUMBNAIL_RENDERER_VERSION}-{size}",
        scene_cache_recipe()
    )
}

/// Full cache key for a derived artifact belonging to `model_hash`.
///
/// Both fields are length-prefixed and hashed rather than interpolated.
/// `format!("{recipe}/{model_hash}")` is unambiguous only while neither field
/// can contain the separator — a precondition nothing enforces. The moment a
/// recipe grows a `/`-bearing component, `("a/b", "c")` and `("a", "b/c")`
/// collapse to the same key, and two different artifacts silently share a cache
/// entry. Length-prefixing removes the precondition instead of documenting it.
///
/// Electron owns the persisted scene cache and mirrors this algorithm. This
/// sidecar helper is the executable specification used to keep both processes'
/// keys byte-for-byte aligned.
pub fn cache_key(model_hash: &str, recipe: &str) -> String {
    let mut hasher = Sha256::new();
    for field in [recipe, model_hash] {
        hasher.update((field.len() as u64).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_recipe_encodes_both_versions() {
        assert_eq!(
            scene_cache_recipe(),
            scene_recipe_for(SCENE_DTO_VERSION, PARSER_SEMANTICS_VERSION)
        );
    }

    #[test]
    fn a_version_bump_invalidates_every_derived_artifact() {
        // The whole point of the recipe: bumping either version must change the
        // key, or a cache written by the pre-hardening parser survives an
        // upgrade and the security fix never takes effect.
        let current = scene_recipe_for(SCENE_DTO_VERSION, PARSER_SEMANTICS_VERSION);
        assert_ne!(
            current,
            scene_recipe_for(SCENE_DTO_VERSION, PARSER_SEMANTICS_VERSION + 1)
        );
        assert_ne!(
            current,
            scene_recipe_for(SCENE_DTO_VERSION + 1, PARSER_SEMANTICS_VERSION)
        );
        assert_ne!(
            scene_recipe_for(1, 2),
            scene_recipe_for(2, 1),
            "the two version fields must not be conflatable"
        );
    }

    #[test]
    fn thumbnail_recipes_differ_per_size() {
        assert_ne!(thumbnail_cache_recipe(256), thumbnail_cache_recipe(512));
        assert!(thumbnail_cache_recipe(512).starts_with(&scene_cache_recipe()));
    }

    #[test]
    fn thumbnail_recipes_carry_the_renderer_version() {
        // A renderer change alters every cached thumbnail while leaving scene
        // DTOs untouched, so the scene recipe alone cannot invalidate them.
        assert!(
            thumbnail_cache_recipe(256).contains(&format!("v{THUMBNAIL_RENDERER_VERSION}")),
            "thumbnail recipes must encode the renderer semantics version"
        );
        assert_ne!(
            format!("thumb-v{THUMBNAIL_RENDERER_VERSION}-256"),
            format!("thumb-v{}-256", THUMBNAIL_RENDERER_VERSION + 1),
            "bumping the renderer version must change the recipe"
        );
        // Size and renderer version must not be conflatable.
        assert_ne!(thumbnail_cache_recipe(1), thumbnail_cache_recipe(11));
    }

    #[test]
    fn cache_key_is_namespaced_by_recipe() {
        let hash = "a".repeat(64);
        let key = cache_key(&hash, &scene_cache_recipe());
        // The key is a digest now, so it no longer contains its inputs
        // literally. The property that matters is unchanged: both inputs are
        // incorporated, and it is deterministic.
        assert_eq!(key, cache_key(&hash, &scene_cache_recipe()));
        assert_ne!(key, cache_key(&"b".repeat(64), &scene_cache_recipe()));
        assert_ne!(key, cache_key(&hash, &thumbnail_cache_recipe(512)));
    }

    #[test]
    fn cache_key_matches_the_electron_consumer_test_vector() {
        // Keep the Electron main-process persistence key byte-for-byte aligned
        // with the sidecar helper even though the process boundary prevents a
        // direct function call.
        assert_eq!(
            cache_key(&"a".repeat(64), "scene/v2.2"),
            "f4ef1c31ccf37c2e0cf75281448694835e8fe0d30473f6be361e15369c8c9672"
        );
    }

    #[test]
    fn no_two_distinct_recipe_and_hash_pairs_share_a_key() {
        let ((recipe_a, hash_a), (recipe_b, hash_b)) = (("ab", "c"), ("a", "bc"));
        assert_eq!(format!("{recipe_a}{hash_a}"), format!("{recipe_b}{hash_b}"));
        assert_ne!(
            cache_key(hash_a, recipe_a),
            cache_key(hash_b, recipe_b),
            "length-prefixing must distinguish fields even without a separator"
        );

        // The old key was `format!("{recipe}/{model_hash}")`, which is only
        // unambiguous while neither field can contain the separator. Nothing
        // enforced that, so a recipe that ever grew a `/`-bearing component
        // would silently serve one artifact's pixels for another's key.
        let colliding = [
            (("a/b", "c"), ("a", "b/c")),
            (("scene/v1.2", "ab/cd"), ("scene/v1.2/ab", "cd")),
            (("p/q/r", "s"), ("p", "q/r/s")),
        ];
        for ((recipe_a, hash_a), (recipe_b, hash_b)) in colliding {
            assert_eq!(
                format!("{recipe_a}/{hash_a}"),
                format!("{recipe_b}/{hash_b}"),
                "fixture must actually collide under plain interpolation"
            );
            assert_ne!(
                cache_key(hash_a, recipe_a),
                cache_key(hash_b, recipe_b),
                "({recipe_a:?}, {hash_a:?}) must not share a key with ({recipe_b:?}, {hash_b:?})"
            );
        }
    }

    #[test]
    fn hardening_release_bumped_the_parser_semantics_version() {
        // Issue #20 changed which packages parse at all; caches written by the
        // previous parser must not be reused.
        assert_eq!(
            PARSER_SEMANTICS_VERSION, 2,
            "update the history doc comment on PARSER_SEMANTICS_VERSION when bumping it"
        );
        assert!(scene_cache_recipe().ends_with(&format!(".{PARSER_SEMANTICS_VERSION}")));
    }
}
