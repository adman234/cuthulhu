// SPDX-License-Identifier: GPL-3.0-or-later
use crate::affine::Point;
use crate::path::Path;

/// Flatten tolerance (mm) for the region a line is clipped against. Finer than the cut's own, since
/// the result is how close a weed line comes to a design and nothing else rounds it afterwards.
const CLIP_TOL: f64 = 0.02;

/// The parts of the segment `a`→`b` lying outside `region`, in order from `a`.
///
/// `region` is read even-odd, which is the same thing as non-zero for what the overlay hands back
/// (non-overlapping contours with their holes), and is what this is fed: an offset or a union.
/// Crossings are found against the infinite line through `a` and `b`, with a vertex lying on the
/// line counted on one side only, so a line grazing a corner or running along an edge neither
/// splits the segment there nor flips which side is inside.
pub fn segments_outside(region: &Path, a: Point, b: Point) -> Vec<(Point, Point)> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 { return vec![]; }
    let side = |p: Point| dx * (p.y - a.y) - dy * (p.x - a.x);
    let mut ts: Vec<f64> = vec![];
    for poly in region.flatten(CLIP_TOL) {
        for w in poly.windows(2) {
            let (sp, sq) = (side(w[0]), side(w[1]));
            if (sp > 0.0) == (sq > 0.0) { continue; }
            let u = sp / (sp - sq);
            let x = w[0].x + u * (w[1].x - w[0].x);
            let y = w[0].y + u * (w[1].y - w[0].y);
            ts.push(((x - a.x) * dx + (y - a.y) * dy) / len2);
        }
    }
    ts.sort_by(|p, q| p.total_cmp(q));
    // Walk the line from far before `a`: every crossing flips inside/outside, and an outside run
    // that overlaps [0, 1] is kept, trimmed to it.
    let at = |t: f64| Point { x: a.x + t * dx, y: a.y + t * dy };
    let mut out = vec![];
    let mut start = f64::NEG_INFINITY;
    let mut inside = false;
    for t in ts.into_iter().chain(std::iter::once(f64::INFINITY)) {
        if !inside {
            let (s, e) = (start.max(0.0), t.min(1.0));
            if e > s { out.push((at(s), at(e))); }
        }
        inside = !inside;
        start = t;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::rect_path;

    fn p(x: f64, y: f64) -> Point { Point { x, y } }

    #[test]
    fn a_line_through_a_square_loses_the_part_inside() {
        let sq = rect_path(10.0, 0.0, 10.0, 10.0);
        let parts = segments_outside(&sq, p(0.0, 5.0), p(30.0, 5.0));
        assert_eq!(parts, vec![(p(0.0, 5.0), p(10.0, 5.0)), (p(20.0, 5.0), p(30.0, 5.0))]);
    }

    #[test]
    fn a_line_that_misses_is_kept_whole_and_one_inside_is_dropped() {
        let sq = rect_path(10.0, 0.0, 10.0, 10.0);
        assert_eq!(segments_outside(&sq, p(0.0, 20.0), p(30.0, 20.0)), vec![(p(0.0, 20.0), p(30.0, 20.0))]);
        assert!(segments_outside(&sq, p(12.0, 5.0), p(18.0, 5.0)).is_empty());
    }

    #[test]
    fn a_line_starting_inside_keeps_only_what_leaves() {
        let sq = rect_path(10.0, 0.0, 10.0, 10.0);
        assert_eq!(segments_outside(&sq, p(15.0, 5.0), p(25.0, 5.0)), vec![(p(20.0, 5.0), p(25.0, 5.0))]);
    }

    /// Along an edge or through a corner: the vertex rule counts each on one side only, so the
    /// parity stays right on both sides of the square.
    #[test]
    fn a_line_along_an_edge_or_through_a_corner_keeps_its_parity() {
        let sq = rect_path(10.0, 0.0, 10.0, 10.0);
        let along = segments_outside(&sq, p(0.0, 0.0), p(30.0, 0.0));
        let total: f64 = along.iter().map(|(s, e)| e.x - s.x).sum();
        assert!(total >= 20.0 - 1e-9, "{along:?}");
        let diag = segments_outside(&sq, p(0.0, -10.0), p(40.0, 30.0));
        assert_eq!(diag, vec![(p(0.0, -10.0), p(10.0, 0.0)), (p(20.0, 10.0), p(40.0, 30.0))]);
    }

    #[test]
    fn a_hole_is_outside() {
        // A 30 mm square with a 10 mm hole wound the other way.
        let mut ring = rect_path(0.0, 0.0, 30.0, 30.0);
        ring.segs.extend(crate::path::Path::from_svg("M10,10 L10,20 L20,20 L20,10 Z").unwrap().segs);
        let parts = segments_outside(&ring, p(-5.0, 15.0), p(35.0, 15.0));
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert_eq!(parts[1], (p(10.0, 15.0), p(20.0, 15.0)));
    }
}
