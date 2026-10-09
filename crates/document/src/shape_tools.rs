// SPDX-License-Identifier: GPL-3.0-or-later
//! Commands that make new shapes out of the selection — an offset contour, a weed box, copies —
//! rather than editing the nodes already there. Each returns one Delta, so each is one undo.
//!
//! They mint their ids from an `IdGen` the caller lends them rather than from placeholders the
//! caller patches afterwards (`boolean_op`'s arrangement): a weed box adds three nodes and an array
//! of copies adds hundreds, and a placeholder per node is a remapping nobody would get right.
//! `Editor::commit_minted` hands over a copy and keeps it only when the command succeeds.
use std::collections::{HashMap, HashSet};

use geometry::{offset, rect_path, weld as weld_paths, segments_outside, Affine, GeomError, Join, Path, Point, Rect, Seg};

use crate::commands::{ancestor_selected, delete_nodes, parent_index, shape_outline, world_via, CmdError};
use crate::delta::{Delta, Document, NodeOp};
use crate::node::{IdGen, Node, NodeId, NodeKind, ShapeKind};

/// The largest offset distance accepted, in mm. Far beyond any contour a cutter is asked for, and
/// low enough that a typo of an extra zero or two is refused rather than filling the mat.
pub const MAX_OFFSET_MM: f64 = 100.0;

/// The selection as the pieces a command acts on: each id once, in the order given, and none whose
/// ancestor is also selected, since that ancestor already carries it. Every id must exist.
pub(crate) fn selection_units(doc: &Document, parents: &HashMap<NodeId, NodeId>, ids: &[NodeId])
    -> Result<Vec<NodeId>, CmdError> {
    if ids.is_empty() { return Err(CmdError::EmptySelection); }
    let selected: HashSet<NodeId> = ids.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut units = vec![];
    for &id in ids {
        doc.get(id).ok_or(CmdError::NotFound)?;
        if !seen.insert(id) || ancestor_selected(parents, &selected, id) { continue; }
        units.push(id);
    }
    Ok(units)
}

/// World-space outlines of every shape at or beneath `id`, in document order. A Group's selection
/// means its shapes, as it does for a drag.
pub(crate) fn world_outlines(doc: &Document, parents: &HashMap<NodeId, NodeId>, id: NodeId)
    -> Result<Vec<Path>, CmdError> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut stack = vec![id];
    while let Some(id) = stack.pop() {
        // The cycle guard `set_cut_line_type` keeps: a malformed manifest is not validated on load.
        if !seen.insert(id) { continue; }
        let node = doc.get(id).ok_or(CmdError::NotFound)?;
        match &node.kind {
            NodeKind::Group | NodeKind::Layer => stack.extend(node.children.iter().rev().copied()),
            NodeKind::Shape(_) => {
                let local = shape_outline(node).map_err(CmdError::Geometry)?.expect("a shape has an outline");
                let world = world_via(doc, parents, id).ok_or(CmdError::NotFound)?;
                out.push(local.transformed(&world));
            }
        }
    }
    Ok(out)
}

/// The parent a new shape made from `unit` lands under, and the matrix taking world space into it.
pub(crate) fn landing(doc: &Document, parents: &HashMap<NodeId, NodeId>, unit: NodeId)
    -> Result<(NodeId, Affine), CmdError> {
    let parent = *parents.get(&unit).ok_or(CmdError::NoParent)?;
    let inv = world_via(doc, parents, parent).ok_or(CmdError::NotFound)?.inverse().ok_or_else(|| {
        CmdError::Geometry("the result's parent sits under a transform that cannot be reversed".into())
    })?;
    Ok((parent, inv))
}

fn path_node(gen: &mut IdGen, world: &Path, to_parent: &Affine) -> Node {
    Node::shape(gen.next(), ShapeKind::Path { d: world.transformed(to_parent).to_svg() })
}

/// An outline `distance_mm` around the selection (negative: inside it), added as a new cut shape
/// and leaving the selection as it was — the contour around a sticker, or a border to weed to.
///
/// With `union`, every selected piece contributes to one contour, landing beside the first piece;
/// without it, each piece gets its own, beside itself, and those may overlap. Either way a piece
/// that is a Group is offset as the union of its shapes, since a contour around a Group's letters
/// one by one is what `union` is for.
pub fn offset_shapes(doc: &Document, gen: &mut IdGen, ids: &[NodeId], distance_mm: f64, union: bool, join: Join)
    -> Result<Delta, CmdError> {
    if !distance_mm.is_finite() || distance_mm == 0.0 || distance_mm.abs() > MAX_OFFSET_MM {
        return Err(CmdError::Geometry(format!(
            "an offset distance must be a number of mm other than zero, at most {MAX_OFFSET_MM} either way")));
    }
    let parents = parent_index(doc);
    let units = selection_units(doc, &parents, ids)?;
    let groups: Vec<(NodeId, Vec<Path>)> = if union {
        let mut all = vec![];
        for &u in &units { all.extend(world_outlines(doc, &parents, u)?); }
        vec![(units[0], all)]
    } else {
        units.iter().map(|&u| Ok((u, world_outlines(doc, &parents, u)?))).collect::<Result<_, CmdError>>()?
    };
    let mut ops = vec![];
    for (unit, paths) in groups {
        if paths.is_empty() { continue; }
        let (parent, to_parent) = landing(doc, &parents, unit)?;
        let outline = offset(&paths, distance_mm, join).map_err(|e| CmdError::Geometry(match e {
            // The one way an otherwise sound request comes back empty, said in its own terms.
            geometry::GeomError::Degenerate if distance_mm < 0.0 =>
                "the inset is deeper than the shape is wide, so nothing is left of it".into(),
            e => e.to_string(),
        }))?;
        ops.push(NodeOp::Add { parent, node: path_node(gen, &outline, &to_parent), index: usize::MAX });
    }
    if ops.is_empty() { return Err(CmdError::EmptySelection); }
    Ok(Delta(ops))
}

/// How far a weed line stops short of a design, in mm. A blade that runs into a letter's edge
/// lifts it with the waste; one millimetre of untouched vinyl around it is enough to keep the weed
/// line's cut from reaching the design without leaving a strip too wide to peel.
pub const WEED_LINE_CLEARANCE_MM: f64 = 1.0;
/// The closest weed lines may be, in mm. Closer is a mat of slivers that tears as it is peeled,
/// and an accidental 0.01 would ask for tens of thousands of lines.
pub const MIN_WEED_LINE_SPACING_MM: f64 = 2.0;
/// The widest margin a weed box takes, in mm, for the reason `MAX_OFFSET_MM` gives.
pub const MAX_WEED_MARGIN_MM: f64 = 100.0;
/// A weed line piece shorter than this, in mm, is left out: a nick between two letters is
/// nothing to peel by and only another blade-down.
const MIN_WEED_SEGMENT_MM: f64 = 1.0;

fn union_bounds(paths: &[Path]) -> Option<Rect> {
    let mut acc: Option<(f64, f64, f64, f64)> = None;
    for p in paths {
        if p.segs.is_empty() { continue; }
        let b = p.bounds();
        acc = Some(match acc {
            None => (b.x, b.y, b.x + b.w, b.y + b.h),
            Some((x0, y0, x1, y1)) => (x0.min(b.x), y0.min(b.y), x1.max(b.x + b.w), y1.max(b.y + b.h)),
        });
    }
    acc.map(|(x0, y0, x1, y1)| Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
}

/// Positions of `n` evenly spaced lines strictly inside `[start, start + len]`, no further apart
/// than `spacing`: the box is divided rather than ruled from one edge, so the last strip is not a
/// sliver.
fn divisions(start: f64, len: f64, spacing: f64) -> Vec<f64> {
    let n = (len / spacing).ceil() as usize;
    (1..n).map(|i| start + len * i as f64 / n as f64).collect()
}

/// A rectangle around the selection, `margin_mm` clear of it, and — given a `line_spacing_mm` —
/// horizontal and vertical weed lines across that box which stop short of every selected shape, so
/// the waste around a design peels off in strips instead of one sheet that drags the letters with it.
///
/// The lines are clipped against the shapes' true outlines grown by `WEED_LINE_CLEARANCE_MM`, not
/// their boxes, so a line runs into the bowl of a C and between two letters. A shape with no area
/// (an open stroke) has no outline to grow, and is kept clear by its box grown the same way instead.
///
/// The box and the lines are new cut shapes in one new Group beside the first selected piece, one
/// Delta, the selection untouched.
pub fn weed_box(doc: &Document, gen: &mut IdGen, ids: &[NodeId], margin_mm: f64, line_spacing_mm: Option<f64>)
    -> Result<Delta, CmdError> {
    if !margin_mm.is_finite() || !(0.0..=MAX_WEED_MARGIN_MM).contains(&margin_mm) {
        return Err(CmdError::Geometry(format!("a weed box margin must be between 0 and {MAX_WEED_MARGIN_MM} mm")));
    }
    if let Some(s) = line_spacing_mm {
        if !s.is_finite() || s < MIN_WEED_LINE_SPACING_MM {
            return Err(CmdError::Geometry(format!(
                "weed lines must be at least {MIN_WEED_LINE_SPACING_MM} mm apart")));
        }
    }
    let parents = parent_index(doc);
    let units = selection_units(doc, &parents, ids)?;
    let mut paths = vec![];
    for &u in &units { paths.extend(world_outlines(doc, &parents, u)?); }
    let bounds = union_bounds(&paths).ok_or(CmdError::EmptySelection)?;
    let bx = Rect { x: bounds.x - margin_mm, y: bounds.y - margin_mm,
                    w: bounds.w + 2.0 * margin_mm, h: bounds.h + 2.0 * margin_mm };
    let (parent, to_parent) = landing(doc, &parents, units[0])?;

    let group = Node::container(gen.next(), NodeKind::Group);
    let group_id = group.id;
    let mut ops = vec![NodeOp::Add { parent, node: group, index: usize::MAX }];
    let mut border = Node::shape(gen.next(), ShapeKind::Rect { w: bx.w, h: bx.h });
    border.transform = Affine::translate(bx.x, bx.y).then(&to_parent);
    ops.push(NodeOp::Add { parent: group_id, node: border, index: usize::MAX });

    if let Some(spacing) = line_spacing_mm {
        let keep_out = keep_out_region(&paths)?;
        let mut segs = vec![];
        let mut rule = |a: Point, b: Point| {
            for (s, e) in segments_outside(&keep_out, a, b) {
                if ((e.x - s.x).powi(2) + (e.y - s.y).powi(2)).sqrt() >= MIN_WEED_SEGMENT_MM {
                    segs.push(Seg::Move(s));
                    segs.push(Seg::Line(e));
                }
            }
        };
        for y in divisions(bx.y, bx.h, spacing) { rule(Point { x: bx.x, y }, Point { x: bx.x + bx.w, y }); }
        for x in divisions(bx.x, bx.w, spacing) { rule(Point { x, y: bx.y }, Point { x, y: bx.y + bx.h }); }
        if !segs.is_empty() {
            ops.push(NodeOp::Add { parent: group_id, node: path_node(gen, &Path { segs }, &to_parent), index: usize::MAX });
        }
    }
    Ok(Delta(ops))
}

/// What weed lines stay out of: every selected shape grown by the clearance, with round corners
/// so a line clears a letter's corner by the same distance as its side.
fn keep_out_region(paths: &[Path]) -> Result<Path, CmdError> {
    let (solid, open): (Vec<&Path>, Vec<&Path>) = paths.iter().partition(|p| has_area(p));
    let mut region: Vec<Path> = open.iter().map(|p| {
        let b = p.bounds();
        let c = WEED_LINE_CLEARANCE_MM;
        rect_path(b.x - c, b.y - c, b.w + 2.0 * c, b.h + 2.0 * c)
    }).collect();
    if !solid.is_empty() {
        let solid: Vec<Path> = solid.into_iter().cloned().collect();
        match offset(&solid, WEED_LINE_CLEARANCE_MM, Join::Round) {
            Ok(p) => region.push(p),
            Err(GeomError::Degenerate) => {}
            Err(e) => return Err(CmdError::Geometry(e.to_string())),
        }
    }
    Ok(Path { segs: region.into_iter().flat_map(|p| p.segs).collect() })
}

/// Whether a path encloses anything: a closed run of at least three distinct points.
fn has_area(p: &Path) -> bool {
    p.flatten(0.1).iter().any(|poly| {
        // Closed explicitly: an open polyline's own edges sum to a nonzero "area" otherwise.
        let a: f64 = poly.iter().zip(poly.iter().cycle().skip(1))
            .map(|(p, q)| p.x * q.y - q.x * p.y).sum();
        poly.len() >= 3 && a.abs() > 1e-9
    })
}

/// The most nodes' worth of copies one command makes. A makerspace sheet of stickers is dozens;
/// thousands is a typo, and each copy is a node the canvas draws and the planner flattens.
pub const MAX_COPIES: u32 = 500;
/// The widest gap between copies, in mm, for the reason `MAX_OFFSET_MM` gives.
pub const MAX_COPY_GAP_MM: f64 = 1000.0;

/// Copy `id`'s subtree under `parent` with fresh ids, its root's local transform replaced by
/// `transform`. Emitted parent-first, each node added with no children and then its children added
/// under it, because `NodeOp::Add` inserts the node's id into its parent's list itself: a copy
/// carrying its children's ids would list each of them twice.
fn copy_subtree(doc: &Document, gen: &mut IdGen, id: NodeId, parent: NodeId, transform: Option<Affine>,
                ops: &mut Vec<NodeOp>, depth: usize) -> Result<(), CmdError> {
    // A cycle in a malformed manifest would otherwise copy forever; no real tree is this deep.
    if depth > 1000 { return Err(CmdError::Geometry("the selection's tree is too deep to copy".into())); }
    let node = doc.get(id).ok_or(CmdError::NotFound)?;
    let mut copy = node.clone();
    copy.id = gen.next();
    copy.children = vec![];
    if let Some(t) = transform { copy.transform = t; }
    let new_id = copy.id;
    ops.push(NodeOp::Add { parent, node: copy, index: usize::MAX });
    for &child in &node.children {
        copy_subtree(doc, gen, child, new_id, None, ops, depth + 1)?;
    }
    Ok(())
}

/// The selection repeated into a grid of `cols` × `rows`, the original in the top-left cell and
/// the copies `gap_x_mm` / `gap_y_mm` apart, measured between the selection's bounding boxes —
/// the spacing an operator lays out a sheet of stickers by. The whole selection moves as one
/// block, so pieces keep their places relative to each other in every cell.
///
/// Each copy is a deep copy beside its original, under the same parent, with every node given a
/// new id; one Delta for the lot.
pub fn array_copies(doc: &Document, gen: &mut IdGen, ids: &[NodeId], cols: u32, rows: u32, gap_x_mm: f64, gap_y_mm: f64)
    -> Result<Delta, CmdError> {
    if cols == 0 || rows == 0 || cols.saturating_mul(rows) < 2 {
        return Err(CmdError::Geometry("copies need at least two cells: more than one column or row".into()));
    }
    if cols.saturating_mul(rows) > MAX_COPIES {
        return Err(CmdError::Geometry(format!("at most {MAX_COPIES} cells of copies can be made at once")));
    }
    for g in [gap_x_mm, gap_y_mm] {
        if !g.is_finite() || !(0.0..=MAX_COPY_GAP_MM).contains(&g) {
            return Err(CmdError::Geometry(format!("the gap between copies must be between 0 and {MAX_COPY_GAP_MM} mm")));
        }
    }
    let parents = parent_index(doc);
    let units = selection_units(doc, &parents, ids)?;
    let mut paths = vec![];
    for &u in &units { paths.extend(world_outlines(doc, &parents, u)?); }
    let bounds = union_bounds(&paths).ok_or(CmdError::EmptySelection)?;
    let (pitch_x, pitch_y) = (bounds.w + gap_x_mm, bounds.h + gap_y_mm);

    let mut ops = vec![];
    for r in 0..rows {
        for c in 0..cols {
            if r == 0 && c == 0 { continue; }
            let shift = Affine::translate(c as f64 * pitch_x, r as f64 * pitch_y);
            for &u in &units {
                let parent = *parents.get(&u).ok_or(CmdError::NoParent)?;
                let pw = world_via(doc, &parents, parent).ok_or(CmdError::NotFound)?;
                let pw_inv = pw.inverse().ok_or_else(|| CmdError::Geometry(
                    "something in the selection sits under a transform that cannot be reversed".into()))?;
                // new_local = old_local · parent world · shift · parent world⁻¹, as a move does.
                let local = doc.get(u).ok_or(CmdError::NotFound)?.transform;
                let t = local.then(&pw).then(&shift).then(&pw_inv);
                copy_subtree(doc, gen, u, parent, Some(t), &mut ops, 0)?;
            }
        }
    }
    Ok(Delta(ops))
}

/// Replace the selection with one Path: every selected shape's outline — text included, letter by
/// letter — unioned, so overlapping letters of a script face or a word laid over a shape cut as
/// one piece instead of crossing cuts that leave slivers. Pieces that do not touch stay separate
/// contours of that one Path.
///
/// The new Path takes the first selected shape's paint and cut attributes, since those say which
/// pass it is cut in, and lands beside the first piece. One Delta: the selection's subtrees removed
/// and the Path added, so one undo brings the words back as words.
pub fn weld(doc: &Document, gen: &mut IdGen, ids: &[NodeId]) -> Result<Delta, CmdError> {
    let parents = parent_index(doc);
    let units = selection_units(doc, &parents, ids)?;
    let mut paths = vec![];
    for &u in &units { paths.extend(world_outlines(doc, &parents, u)?); }
    if paths.is_empty() { return Err(CmdError::EmptySelection); }
    let (parent, to_parent) = landing(doc, &parents, units[0])?;
    let welded = weld_paths(&paths).map_err(|e| CmdError::Geometry(match e {
        GeomError::Degenerate => "the selection has no area to weld: its shapes are open lines".into(),
        e => e.to_string(),
    }))?;
    let mut node = path_node(gen, &welded, &to_parent);
    if let Some(first) = first_shape(doc, units[0]) {
        node.style = first.style.clone();
        node.cut_line_type = first.cut_line_type;
        node.material_preset = first.material_preset.clone();
    }
    let mut ops = delete_nodes(doc, &units)?.0;
    ops.push(NodeOp::Add { parent, node, index: usize::MAX });
    Ok(Delta(ops))
}

/// The first shape at or beneath `id`, in document order.
fn first_shape(doc: &Document, id: NodeId) -> Option<&Node> {
    let mut seen = HashSet::new();
    let mut stack = vec![id];
    while let Some(id) = stack.pop() {
        if !seen.insert(id) { continue; }
        let node = doc.get(id)?;
        match node.kind {
            NodeKind::Shape(_) => return Some(node),
            _ => stack.extend(node.children.iter().rev().copied()),
        }
    }
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::history::Editor;

    pub(crate) fn rect_at(ed: &mut Editor, parent: NodeId, x: f64, y: f64, w: f64, h: f64) -> NodeId {
        let id = ed.doc.ids.next();
        let mut node = Node::shape(id, ShapeKind::Rect { w, h });
        node.transform = Affine::translate(x, y);
        ed.commit(Delta(vec![NodeOp::Add { parent, node, index: usize::MAX }]));
        id
    }

    pub(crate) fn added(d: &Delta) -> Vec<&Node> {
        d.0.iter().filter_map(|op| match op { NodeOp::Add { node, .. } => Some(node), _ => None }).collect()
    }

    pub(crate) fn outline_of(node: &Node) -> Path {
        shape_outline(node).unwrap().unwrap().transformed(&node.transform)
    }

    #[test]
    fn an_offset_adds_one_contour_around_the_selection_and_keeps_it() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        let d = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a], 2.0, true, Join::Round)).unwrap();
        let new = added(&d);
        assert_eq!(new.len(), 1);
        let b = outline_of(new[0]).bounds();
        assert!((b.x + 2.0).abs() < 1e-3 && (b.w - 14.0).abs() < 1e-3, "{b:?}");
        assert!(ed.doc.get(a).is_some(), "the source shape stays");
        assert_eq!(ed.doc.get(root).unwrap().children.len(), 2);
    }

    #[test]
    fn without_union_each_piece_gets_its_own_contour() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        let b = rect_at(&mut ed, root, 11.0, 0.0, 10.0, 10.0);
        let d = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a, b], 2.0, false, Join::Round)).unwrap();
        assert_eq!(added(&d).len(), 2);
        let ids: HashSet<NodeId> = added(&d).iter().map(|n| n.id).collect();
        assert_eq!(ids.len(), 2, "each minted its own id");
        // Unioned, the 1 mm gap closes and the two outsets become one contour.
        let d = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a, b], 2.0, true, Join::Round)).unwrap();
        assert_eq!(added(&d).len(), 1);
        assert_eq!(outline_of(added(&d)[0]).flatten(0.1).len(), 1);
    }

    #[test]
    fn an_offset_lands_in_the_parent_space_of_a_moved_layer() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let layer = ed.doc.ids.next();
        let mut node = Node::container(layer, NodeKind::Group);
        node.transform = Affine::translate(100.0, 0.0);
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node, index: usize::MAX }]));
        let a = rect_at(&mut ed, layer, 0.0, 0.0, 10.0, 10.0);
        let d = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a], 1.0, true, Join::Miter)).unwrap();
        let NodeOp::Add { parent, node, .. } = &d.0[0] else { panic!() };
        assert_eq!(*parent, layer);
        // Local to the group: the group's own move puts it back around the rect in world space.
        let b = outline_of(node).bounds();
        assert!((b.x + 1.0).abs() < 1e-3, "{b:?}");
    }

    #[test]
    fn an_offset_is_one_undo_and_a_refused_one_mints_nothing() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        let ids_before = ed.doc.ids.clone();
        let err = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a], -6.0, true, Join::Round)).unwrap_err();
        assert!(err.to_string().contains("deeper"), "{err}");
        assert_eq!(ed.doc.ids, ids_before);
        let before = ed.doc.clone();
        ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[a], 1.0, true, Join::Round)).unwrap();
        ed.undo().unwrap();
        assert_eq!(ed.doc.nodes, before.nodes);
    }

    #[test]
    fn an_offset_distance_out_of_range_is_refused_in_words() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        for d in [0.0, f64::NAN, 1000.0] {
            let err = offset_shapes(&ed.doc, &mut IdGen::default(), &[a], d, true, Join::Round).unwrap_err();
            assert!(err.to_string().starts_with("an offset distance"), "{err}");
        }
    }

    #[test]
    fn an_offset_of_a_group_contours_all_of_its_shapes() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let g = ed.doc.ids.next();
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::container(g, NodeKind::Group), index: usize::MAX }]));
        rect_at(&mut ed, g, 0.0, 0.0, 10.0, 10.0);
        rect_at(&mut ed, g, 30.0, 0.0, 10.0, 10.0);
        let d = ed.commit_minted(|doc, gen| offset_shapes(doc, gen, &[g], 1.0, false, Join::Round)).unwrap();
        let b = outline_of(added(&d)[0]).bounds();
        assert!((b.w - 42.0).abs() < 1e-3, "{b:?}");
    }

    fn weed(ed: &mut Editor, ids: &[NodeId], margin: f64, spacing: Option<f64>) -> Result<Delta, CmdError> {
        ed.commit_minted(|doc, gen| weed_box(doc, gen, ids, margin, spacing))
    }

    /// Every weed line piece, as (start, end) in world space.
    fn weed_lines(ed: &Editor, d: &Delta) -> Vec<(Point, Point)> {
        let lines = added(d).into_iter().find(|n| matches!(n.kind, NodeKind::Shape(ShapeKind::Path { .. }))).unwrap();
        let world = crate::commands::world_transform(&ed.doc, lines.id).unwrap();
        let p = shape_outline(lines).unwrap().unwrap().transformed(&world);
        p.flatten(0.1).into_iter().map(|poly| (poly[0], poly[1])).collect()
    }

    #[test]
    fn a_weed_box_surrounds_the_selection_by_the_margin_in_one_group() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 10.0, 10.0, 10.0, 10.0);
        let b = rect_at(&mut ed, root, 30.0, 15.0, 10.0, 10.0);
        let d = weed(&mut ed, &[a, b], 3.0, None).unwrap();
        let new = added(&d);
        assert_eq!(new.len(), 2, "a group and its border");
        assert!(matches!(new[0].kind, NodeKind::Group));
        let border = outline_of(new[1]).bounds();
        assert_eq!((border.x, border.y, border.w, border.h), (7.0, 7.0, 36.0, 21.0));
        assert_eq!(ed.doc.get(new[0].id).unwrap().children, vec![new[1].id]);
        ed.undo().unwrap();
        assert_eq!(ed.doc.get(root).unwrap().children, vec![a, b], "one undo removes it all");
    }

    #[test]
    fn weed_lines_cross_the_box_and_never_a_selected_shape() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 10.0, 10.0, 10.0, 10.0);
        let b = rect_at(&mut ed, root, 30.0, 15.0, 10.0, 10.0);
        let d = weed(&mut ed, &[a, b], 3.0, Some(4.0)).unwrap();
        let lines = weed_lines(&ed, &d);
        assert!(!lines.is_empty());
        let shapes = [(10.0, 10.0, 20.0, 20.0), (30.0, 15.0, 40.0, 25.0)];
        for (s, e) in &lines {
            assert!(s.x == e.x || s.y == e.y, "axis-aligned: {s:?} {e:?}");
            // Sampled along the piece: nothing within the clearance of either rect.
            for i in 0..=50 {
                let t = i as f64 / 50.0;
                let (x, y) = (s.x + t * (e.x - s.x), s.y + t * (e.y - s.y));
                for (x0, y0, x1, y1) in shapes {
                    let dx = (x0 - x).max(x - x1).max(0.0);
                    let dy = (y0 - y).max(y - y1).max(0.0);
                    assert!((dx * dx + dy * dy).sqrt() >= WEED_LINE_CLEARANCE_MM - 1e-3,
                        "({x},{y}) is within the clearance of {x0},{y0}");
                }
            }
            // And inside the box.
            for p in [s, e] { assert!(p.x >= 7.0 - 1e-9 && p.x <= 43.0 + 1e-9 && p.y >= 7.0 - 1e-9 && p.y <= 28.0 + 1e-9); }
        }
        // A horizontal line at y = 12.25 runs from the box edge to just short of the first rect.
        assert!(lines.iter().any(|(s, e)| s.y == e.y && (s.x - 7.0).abs() < 1e-9 && (e.x - 9.0).abs() < 1e-2), "{lines:?}");
    }

    /// Clipped against the outline, not the box: a line through a ring's empty middle still cuts
    /// the waste there.
    #[test]
    fn weed_lines_follow_the_outline_rather_than_its_box() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let id = ed.doc.ids.next();
        let ring = Node::shape(id, ShapeKind::Path { d: "M0,0 L40,0 L40,40 L0,40 Z M10,10 L10,30 L30,30 L30,10 Z".into() });
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: ring, index: usize::MAX }]));
        let d = weed(&mut ed, &[id], 2.0, Some(25.0)).unwrap();
        let lines = weed_lines(&ed, &d);
        // The one horizontal line, at y = 20: the two outside runs plus the run inside the hole.
        let at20: Vec<_> = lines.iter().filter(|(s, e)| s.y == e.y && (s.y - 20.0).abs() < 1e-9).collect();
        assert_eq!(at20.len(), 3, "{lines:?}");
        assert!(at20.iter().any(|(s, e)| (s.x - 11.0).abs() < 1e-2 && (e.x - 29.0).abs() < 1e-2), "{at20:?}");
    }

    #[test]
    fn a_weed_box_refuses_out_of_range_options_in_words() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        assert!(weed(&mut ed, &[a], -1.0, None).unwrap_err().to_string().starts_with("a weed box margin"));
        assert!(weed(&mut ed, &[a], 3.0, Some(0.5)).unwrap_err().to_string().starts_with("weed lines must be"));
        assert_eq!(weed(&mut ed, &[], 3.0, None).unwrap_err(), CmdError::EmptySelection);
        let g = ed.doc.ids.next();
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::container(g, NodeKind::Group), index: usize::MAX }]));
        assert_eq!(weed(&mut ed, &[g], 3.0, None).unwrap_err(), CmdError::EmptySelection, "an empty group has nothing to box");
    }

    #[test]
    fn an_open_stroke_is_kept_clear_by_its_box() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let id = ed.doc.ids.next();
        let line = Node::shape(id, ShapeKind::Path { d: "M0,10 L40,10".into() });
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: line, index: usize::MAX }]));
        let d = weed(&mut ed, &[id], 3.0, Some(5.0)).unwrap();
        for (s, e) in weed_lines(&ed, &d) {
            if s.x == e.x { assert!(e.y <= 9.0 + 1e-9 || s.y >= 11.0 - 1e-9, "{s:?} {e:?} crosses the stroke"); }
        }
    }

    fn copies(ed: &mut Editor, ids: &[NodeId], cols: u32, rows: u32, gx: f64, gy: f64) -> Result<Delta, CmdError> {
        ed.commit_minted(|doc, gen| array_copies(doc, gen, ids, cols, rows, gx, gy))
    }

    #[test]
    fn copies_fill_a_grid_spaced_by_the_gap_between_boxes() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 5.0, 5.0, 10.0, 20.0);
        let d = copies(&mut ed, &[a], 3, 2, 2.0, 3.0).unwrap();
        let mut origins: Vec<(f64, f64)> = added(&d).iter().map(|n| n.transform.apply(0.0, 0.0)).collect();
        origins.sort_by(|p, q| p.partial_cmp(q).unwrap());
        assert_eq!(origins, vec![(5.0, 28.0), (17.0, 5.0), (17.0, 28.0), (29.0, 5.0), (29.0, 28.0)]);
        assert_eq!(ed.doc.get(root).unwrap().children.len(), 6);
        ed.undo().unwrap();
        assert_eq!(ed.doc.get(root).unwrap().children, vec![a]);
    }

    #[test]
    fn copies_of_a_group_are_deep_with_new_ids_throughout() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let g = ed.doc.ids.next();
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::container(g, NodeKind::Group), index: usize::MAX }]));
        let a = rect_at(&mut ed, g, 0.0, 0.0, 10.0, 10.0);
        let b = rect_at(&mut ed, g, 20.0, 0.0, 10.0, 10.0);
        let d = copies(&mut ed, &[g], 2, 1, 5.0, 0.0).unwrap();
        let new = added(&d);
        assert_eq!(new.len(), 3);
        let copy = ed.doc.get(new[0].id).unwrap();
        assert!(matches!(copy.kind, NodeKind::Group));
        assert_eq!(copy.children.len(), 2, "each child listed once");
        assert!(!copy.children.contains(&a) && !copy.children.contains(&b));
        // The group moved by the box width plus the gap; its children keep their own transforms.
        assert_eq!(copy.transform.apply(0.0, 0.0), (35.0, 0.0));
        assert_eq!(ed.doc.get(copy.children[1]).unwrap().transform.apply(0.0, 0.0), (20.0, 0.0));
        assert_eq!(ed.doc.get(g).unwrap().children, vec![a, b], "the original is untouched");
    }

    #[test]
    fn copies_move_in_world_space_under_a_scaled_parent() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let g = ed.doc.ids.next();
        let mut group = Node::container(g, NodeKind::Group);
        group.transform = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: group, index: usize::MAX }]));
        let a = rect_at(&mut ed, g, 0.0, 0.0, 5.0, 5.0);
        let d = copies(&mut ed, &[a], 2, 1, 4.0, 0.0).unwrap();
        let copy = added(&d)[0].id;
        let world = crate::commands::world_transform(&ed.doc, copy).unwrap();
        // 10 mm wide in the world, so the copy starts 14 mm along.
        assert_eq!(world.apply(0.0, 0.0), (14.0, 0.0));
    }

    #[test]
    fn copies_refuse_a_single_cell_too_many_cells_or_a_bad_gap() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        assert!(copies(&mut ed, &[a], 1, 1, 0.0, 0.0).unwrap_err().to_string().contains("at least two cells"));
        assert!(copies(&mut ed, &[a], 0, 5, 0.0, 0.0).unwrap_err().to_string().contains("at least two cells"));
        assert!(copies(&mut ed, &[a], 100, 100, 0.0, 0.0).unwrap_err().to_string().contains("at most 500"));
        assert!(copies(&mut ed, &[a], 2, 1, -1.0, 0.0).unwrap_err().to_string().contains("gap between copies"));
        assert!(copies(&mut ed, &[a], 2, 1, f64::NAN, 0.0).unwrap_err().to_string().contains("gap between copies"));
    }

    #[test]
    fn copies_of_several_pieces_keep_their_layout_in_each_cell() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let a = rect_at(&mut ed, root, 0.0, 0.0, 10.0, 10.0);
        let b = rect_at(&mut ed, root, 20.0, 5.0, 10.0, 10.0);
        let d = copies(&mut ed, &[b, a], 1, 2, 0.0, 1.0).unwrap();
        let mut origins: Vec<(f64, f64)> = added(&d).iter().map(|n| n.transform.apply(0.0, 0.0)).collect();
        origins.sort_by(|p, q| p.partial_cmp(q).unwrap());
        assert_eq!(origins, vec![(0.0, 16.0), (20.0, 21.0)]);
    }

    #[test]
    fn weld_replaces_the_selection_with_one_path_and_one_undo_brings_it_back() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let g = ed.doc.ids.next();
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::container(g, NodeKind::Group), index: usize::MAX }]));
        let a = rect_at(&mut ed, g, 0.0, 0.0, 10.0, 10.0);
        let mut red = ed.doc.get(a).unwrap().clone();
        red.style.stroke = Some(0xFF0000FF);
        ed.commit(Delta(vec![NodeOp::Update { id: a, before: ed.doc.get(a).unwrap().clone(), after: red }]));
        rect_at(&mut ed, g, 5.0, 5.0, 10.0, 10.0);
        let c = rect_at(&mut ed, root, 8.0, 0.0, 10.0, 3.0);
        let before = ed.doc.clone();
        let d = ed.commit_minted(|doc, gen| weld(doc, gen, &[g, c])).unwrap();
        // Root holds the welded path alone: the group, its two rects and the third rect are gone.
        let kids = &ed.doc.get(root).unwrap().children;
        assert_eq!(kids.len(), 1);
        assert_eq!(ed.doc.nodes.len(), 2, "no orphaned children left behind");
        let path = ed.doc.get(kids[0]).unwrap();
        assert_eq!(path.style.stroke, Some(0xFF0000FF), "the first shape's pass");
        assert_eq!(outline_of(path).flatten(0.1).len(), 1, "all three overlap into one contour");
        assert_eq!(added(&d).len(), 1);
        ed.undo().unwrap();
        assert_eq!(ed.doc.nodes, before.nodes);
    }

    #[test]
    fn weld_of_open_lines_alone_refuses_in_words() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let id = ed.doc.ids.next();
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::shape(id, ShapeKind::Path { d: "M0,0 L10,0".into() }), index: usize::MAX }]));
        let err = ed.commit_minted(|doc, gen| weld(doc, gen, &[id])).unwrap_err();
        assert!(err.to_string().contains("no area to weld"), "{err}");
        assert!(ed.doc.get(id).is_some());
    }

    /// Text welds by the outline it was drawn with, so no font is needed to test it.
    #[test]
    fn weld_takes_text_by_its_drawn_outline() {
        let mut ed = Editor::new();
        let root = ed.doc.root;
        let id = ed.doc.ids.next();
        let text = ShapeKind::Text { family: "X".into(), size_mm: 10.0, text: "oo".into(),
            d: "M0,0 L6,0 L6,6 L0,6 Z M4,0 L10,0 L10,6 L4,6 Z".into() };
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node: Node::shape(id, text), index: usize::MAX }]));
        ed.commit_minted(|doc, gen| weld(doc, gen, &[id])).unwrap();
        let kids = &ed.doc.get(root).unwrap().children;
        let node = ed.doc.get(kids[0]).unwrap();
        assert!(matches!(node.kind, NodeKind::Shape(ShapeKind::Path { .. })));
        assert_eq!(outline_of(node).flatten(0.1).len(), 1);
    }
}
