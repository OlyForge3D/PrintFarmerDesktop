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

/// Bumped whenever the parsers or the scene normalizer change the values they
/// produce for unchanged input bytes.
///
/// History:
/// * `1` — initial pipeline (STL/3MF/OBJ/STEP).
/// * `2` — issue #20 security hardening: non-finite coordinates, DTD-bearing
///   XML, over-deep XML and decompression bombs are now rejected, so packages
///   that previously produced a (poisoned) scene now fail to parse.
pub const PARSER_SEMANTICS_VERSION: u32 = 2;

/// Recipe for a cached scene DTO.
pub fn scene_cache_recipe() -> String {
    scene_recipe_for(SCENE_DTO_VERSION, PARSER_SEMANTICS_VERSION)
}

fn scene_recipe_for(scene_dto_version: u32, parser_semantics_version: u32) -> String {
    format!("scene/v{scene_dto_version}.{parser_semantics_version}")
}

/// Recipe for a cached thumbnail rendered at `size` pixels square.
pub fn thumbnail_cache_recipe(size: u32) -> String {
    format!("{}/thumb-{size}", scene_cache_recipe())
}

/// Full cache key for a derived artifact belonging to `model_hash`.
pub fn cache_key(model_hash: &str, recipe: &str) -> String {
    format!("{recipe}/{model_hash}")
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
    fn cache_key_is_namespaced_by_recipe() {
        let hash = "a".repeat(64);
        let key = cache_key(&hash, &scene_cache_recipe());
        assert!(key.ends_with(&hash));
        assert!(key.starts_with("scene/v"));
        assert_ne!(key, cache_key(&hash, &thumbnail_cache_recipe(512)));
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
