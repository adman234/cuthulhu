// SPDX-License-Identifier: GPL-3.0-or-later
use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::mesh::outline::offset::OutlineOffset;
use i_overlay::mesh::style::{LineJoin, OutlineStyle};
use serde::{Deserialize, Serialize};

use crate::boolean::{path_to_shape, shapes_to_path, Shapes};
use crate::path::{GeomError, Path};

/// How an offset outline turns a convex corner. Concave corners are always trimmed flat by the
/// overlay, so the choice only shows on the outside of a turn.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub enum Join {
    /// An arc around the corner: what a contour cut around a sticker or a weed border wants, since
    /// a blade drags through a sharp outside corner and lifts the vinyl there.
    #[default]
    Round,
    /// A sharp corner, cut off at a limit so a needle-thin spike does not run off to infinity.
    Miter,
    /// A flat cut across the corner.
    Bevel,
}

/// How far the arc of a round join may stray from the true circle, in mm. Well under a blade's own
/// offset, so a finer arc would be segments the cutter cannot tell apart.
const ARC_TOLERANCE_MM: f64 = 0.02;

fn line_join(join: Join, distance: f64) -> LineJoin<f64> {
    match join {
        // i_overlay takes the arc as `segment length / radius`; a chord of length L on radius R
        // strays `R - sqrt(R² - L²/4) ≈ L²/8R` from the arc, which solves to the ratio below. It
        // clamps the ratio to [0.01π, 0.25π] itself, so a huge radius cannot ask for a million
        // segments.
        Join::Round => LineJoin::Round((8.0 * ARC_TOLERANCE_MM / distance.abs()).sqrt()),
        // The angle below which a miter is cut off: 15° keeps a 90° corner sharp and cuts only
        // the spikes a narrow serif would grow.
        Join::Miter => LineJoin::Miter(15f64.to_radians()),
        Join::Bevel => LineJoin::Bevel,
    }
}

/// The filled region of `paths`, as one set of non-overlapping shapes with the overlay's own
/// winding (outer contours one way, holes the other). Each path is read with the non-zero rule on
/// its own first and then unioned with the rest, which is what `boolean`'s Union does, so a hole in
/// one path that another path covers is filled rather than cancelled by opposite windings.
pub(crate) fn filled_region(paths: &[Path]) -> Shapes {
    let mut acc: Shapes = vec![];
    for p in paths {
        let own: Shapes = path_to_shape(p).simplify_shape(FillRule::NonZero);
        if acc.is_empty() {
            acc = own;
        } else {
            let both: Vec<Vec<[f64; 2]>> = acc.into_iter().flatten().chain(own.into_iter().flatten()).collect();
            // Both inputs are already normalised, so their windings agree and a positive count
            // is exactly "inside either".
            acc = both.simplify_shape(FillRule::Positive);
        }
    }
    acc
}

/// The outline at `distance` mm around the filled region of `paths`, every input unioned first.
/// A negative distance shrinks the region instead (an inset); a shrink that swallows the whole
/// region refuses with `Degenerate` rather than producing an empty shape.
///
/// Every path is read as closed, as `boolean` reads them: an open stroke is offset as the sliver
/// its closing edge makes. ponytail: no stroke offset for open paths (a weed line, a hairline).
/// Upgrade: route a path whose end is not its start through i_overlay's `StrokeOffset`.
pub fn offset(paths: &[Path], distance: f64, join: Join) -> Result<Path, GeomError> {
    if !distance.is_finite() { return Err(GeomError::Degenerate); }
    let region = filled_region(paths);
    if region.is_empty() { return Err(GeomError::Degenerate); }
    if distance == 0.0 { return Ok(shapes_to_path(&region)); }
    let style = OutlineStyle::new(distance).line_join(line_join(join, distance));
    let out: Shapes = region.outline(&style);
    if out.is_empty() { return Err(GeomError::Degenerate); }
    Ok(shapes_to_path(&out))
}

/// The filled region of every path together, as one path: overlapping outlines merge into one,
/// and a hole in one that another covers is filled. Unlike `boolean`'s Union this takes a single
/// path too — a script face whose letters overlap welds on its own.
pub fn weld(paths: &[Path]) -> Result<Path, GeomError> {
    let region = filled_region(paths);
    if region.is_empty() { return Err(GeomError::Degenerate); }
    Ok(shapes_to_path(&region))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{ellipse_path, rect_path};

    /// Shoelace area over every contour, holes counted negative by their winding.
    fn area(p: &Path) -> f64 {
        p.flatten(0.01).iter().map(|poly| {
            poly.windows(2).map(|w| w[0].x * w[1].y - w[1].x * w[0].y).sum::<f64>() / 2.0
        }).sum::<f64>().abs()
    }

    #[test]
    fn a_round_outset_grows_a_square_by_the_distance_with_rounded_corners() {
        let sq = rect_path(0.0, 0.0, 10.0, 10.0);
        let out = offset(&[sq], 2.0, Join::Round).unwrap();
        let b = out.bounds();
        assert!((b.x + 2.0).abs() < 1e-3 && (b.y + 2.0).abs() < 1e-3, "{b:?}");
        assert!((b.w - 14.0).abs() < 1e-3 && (b.h - 14.0).abs() < 1e-3, "{b:?}");
        // 10² + four 10×2 sides + a full circle of radius 2 from the four quarter corners.
        let expected = 100.0 + 4.0 * 20.0 + std::f64::consts::PI * 4.0;
        assert!((area(&out) - expected).abs() < 0.3, "area {} vs {expected}", area(&out));
    }

    #[test]
    fn a_miter_outset_keeps_square_corners() {
        let out = offset(&[rect_path(0.0, 0.0, 10.0, 10.0)], 1.0, Join::Miter).unwrap();
        assert!((area(&out) - 144.0).abs() < 1e-3, "area {}", area(&out));
    }

    #[test]
    fn a_negative_distance_insets() {
        let out = offset(&[rect_path(0.0, 0.0, 10.0, 10.0)], -2.0, Join::Round).unwrap();
        let b = out.bounds();
        assert!((b.x - 2.0).abs() < 1e-3 && (b.w - 6.0).abs() < 1e-3, "{b:?}");
        assert!((area(&out) - 36.0).abs() < 1e-3);
    }

    #[test]
    fn an_inset_deeper_than_the_shape_is_degenerate() {
        assert_eq!(offset(&[rect_path(0.0, 0.0, 10.0, 10.0)], -6.0, Join::Round), Err(GeomError::Degenerate));
    }

    #[test]
    fn overlapping_outsets_merge_into_one_contour() {
        let a = rect_path(0.0, 0.0, 10.0, 10.0);
        let b = rect_path(12.0, 0.0, 10.0, 10.0);
        // 2 mm apart, each grown by 1.5 mm: the outsets overlap across the gap.
        let out = offset(&[a, b], 1.5, Join::Round).unwrap();
        assert_eq!(out.flatten(0.1).len(), 1);
    }

    /// A ring's hole shrinks as its outline grows: the inner edge moves inward, toward the
    /// ring's own material being kept.
    #[test]
    fn a_hole_shrinks_when_the_shape_grows() {
        let ring = Path {
            segs: ellipse_path(10.0, 10.0, 10.0, 10.0).segs.into_iter()
                .chain(ellipse_path(10.0, 10.0, 5.0, 5.0).transformed(&crate::Affine([1.0, 0.0, 0.0, -1.0, 0.0, 20.0])).segs)
                .collect(),
        };
        let out = offset(&[ring], 1.0, Join::Round).unwrap();
        let pi = std::f64::consts::PI;
        let expected = pi * 11.0 * 11.0 - pi * 4.0 * 4.0;
        assert!((area(&out) - expected).abs() < 3.0, "area {} vs {expected}", area(&out));
    }

    #[test]
    fn a_non_finite_distance_is_refused() {
        assert_eq!(offset(&[rect_path(0.0, 0.0, 1.0, 1.0)], f64::NAN, Join::Round), Err(GeomError::Degenerate));
    }

    #[test]
    fn weld_merges_overlapping_outlines_and_keeps_apart_ones_apart() {
        let a = rect_path(0.0, 0.0, 10.0, 10.0);
        let b = rect_path(5.0, 5.0, 10.0, 10.0);
        let c = rect_path(30.0, 0.0, 5.0, 5.0);
        let w = weld(&[a.clone(), b, c]).unwrap();
        assert_eq!(w.flatten(0.1).len(), 2);
        assert!((area(&w) - (175.0 + 25.0)).abs() < 1e-6);
        // One path whose own contours overlap welds too.
        let one = Path { segs: a.segs.into_iter().chain(rect_path(5.0, 0.0, 10.0, 10.0).segs).collect() };
        assert_eq!(weld(&[one]).unwrap().flatten(0.1).len(), 1);
        assert_eq!(weld(&[]), Err(GeomError::Degenerate));
    }
}
