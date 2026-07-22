//! Shared geometric primitives used by every format parser and, later, the
//! scene and thumbnail layers. Keeping a single bounds type means STL, 3MF, and
//! any future format all describe extents the same way.

/// Axis-aligned bounding box over a set of points. Constructed [`Aabb::empty`]
/// (an inverted box) and grown with [`Aabb::expand`]; an untouched box reports
/// [`Aabb::is_empty`] and a zero [`Aabb::size`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

impl Aabb {
    /// An empty box whose `min`/`max` are inverted so the first `expand`
    /// initializes both bounds.
    pub fn empty() -> Self {
        Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        }
    }

    /// Grow the box to include point `v`.
    pub fn expand(&mut self, v: [f32; 3]) {
        for ((min, max), &c) in self.min.iter_mut().zip(self.max.iter_mut()).zip(v.iter()) {
            *min = min.min(c);
            *max = max.max(c);
        }
    }

    /// True when no point has been added yet.
    pub fn is_empty(&self) -> bool {
        self.min[0] > self.max[0]
    }

    /// Size along each axis; `[0, 0, 0]` for an empty box.
    pub fn size(&self) -> [f32; 3] {
        if self.is_empty() {
            return [0.0; 3];
        }
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    /// Geometric center of the box; `[0, 0, 0]` for an empty box.
    pub fn center(&self) -> [f32; 3] {
        if self.is_empty() {
            return [0.0; 3];
        }
        [
            (self.min[0] + self.max[0]) * 0.5,
            (self.min[1] + self.max[1]) * 0.5,
            (self.min[2] + self.max[2]) * 0.5,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_box_reports_zero_size_and_center() {
        let aabb = Aabb::empty();
        assert!(aabb.is_empty());
        assert_eq!(aabb.size(), [0.0, 0.0, 0.0]);
        assert_eq!(aabb.center(), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn expanding_tracks_min_max_size_and_center() {
        let mut aabb = Aabb::empty();
        aabb.expand([-1.0, 2.0, 0.0]);
        aabb.expand([3.0, -4.0, 6.0]);
        assert!(!aabb.is_empty());
        assert_eq!(aabb.min, [-1.0, -4.0, 0.0]);
        assert_eq!(aabb.max, [3.0, 2.0, 6.0]);
        assert_eq!(aabb.size(), [4.0, 6.0, 6.0]);
        assert_eq!(aabb.center(), [1.0, -1.0, 3.0]);
    }
}
