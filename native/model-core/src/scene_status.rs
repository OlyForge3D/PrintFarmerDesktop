use serde::{Deserialize, Serialize};

/// Declarative load/validation status carried with normalized scene metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SceneLoadStatus {
    #[default]
    Complete,
    Partial,
    Unsupported,
}

impl SceneLoadStatus {
    pub fn combine(self, other: Self) -> Self {
        self.max(other)
    }
}
