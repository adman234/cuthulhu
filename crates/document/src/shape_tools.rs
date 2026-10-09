// SPDX-License-Identifier: GPL-3.0-or-later
//! Commands that make new shapes out of the selection — an offset contour, a weed box, copies —
//! rather than editing the nodes already there. Each returns one Delta, so each is one undo.
//!
//! They mint their ids from an `IdGen` the caller lends them rather than from placeholders the
//! caller patches afterwards (`boolean_op`'s arrangement): a weed box adds three nodes and an array
//! of copies adds hundreds, and a placeholder per node is a remapping nobody would get right.
//! `Editor::commit_minted` hands over a copy and keeps it only when the command succeeds.
use std::collections::{HashMap, HashSet};

use geometry::{offset, Affine, Join, Path};

use crate::commands::{ancestor_selected, parent_index, shape_outline, world_via, CmdError};
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
}
