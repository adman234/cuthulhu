// SPDX-License-Identifier: GPL-3.0-or-later
//! Print & cut: the registration marks a Document carries so a printed sheet can be cut where it
//! was printed.
//!
//! The marks are ordinary Nodes — a Group of `NoCut` shapes, so they print with the artwork and are
//! never cut — and `JobSettings::registration` names that Group. Where the marks are is read off
//! their geometry each time it is needed, as inkscape-silhouette reads it off an existing template
//! [src: inkscape-silhouette sendto_silhouette.py L846-855 (GPL-2.0+)]: marks are edited by Deltas
//! and `JobSettings` is not, so a stored copy of the area would disagree with the marks after the
//! first undo, and the machine would search for marks where none are printed. The geometry is the Silhouette "Cameo, Portrait" layout
//! (`TB52,2`) that inkscape-silhouette's template draws: a filled square at the top-left and an L
//! at the top-right and bottom-left corners.
//! [src: inkscape-silhouette render_silhouette_regmarks.py L67-74, L90-98, L204-213 (GPL-2.0+)]
//!
//! The marks are drawn as filled outlines rather than stroked lines: a Node has no stroke width,
//! and an L's 0.3 mm line has to print at 0.3 mm whatever the exporter's default stroke is.
use serde::{Deserialize, Serialize};
use geometry::Affine;
use crate::history::Editor;
use crate::{CutLineType, Delta, Node, NodeId, NodeKind, NodeOp, ShapeKind, Style};

/// Side of the filled top-left square, in mm. [src: inkscape-silhouette render_silhouette_regmarks.py L67, L210 (GPL-2.0+)]
pub const REG_SQUARE_MM: f64 = 5.0;
/// Length of each arm of an L mark, in mm. [src: inkscape-silhouette render_silhouette_regmarks.py L68, L90-98 (GPL-2.0+)]
pub const REG_LINE_MM: f64 = 20.0;
/// Line width of an L mark, in mm — thicker marks register less accurately.
/// [src: inkscape-silhouette render_silhouette_regmarks.py L71-74 (GPL-2.0+)]
pub const REG_MARK_LINE_WIDTH_MM: f64 = 0.3;
/// How far in from the sheet's top-left corner the marks start by default, in mm.
/// [src: inkscape-silhouette render_silhouette_regmarks.inx L10-11 (GPL-2.0+)]
pub const REG_DEFAULT_INSET_MM: f64 = 10.0;

const BLACK: u32 = 0x000000FF;

/// Where the marks are, in mm on the Document: `origin` is the top-left square's top-left corner,
/// `width` runs from it to the top-right L's corner and `length` to the bottom-left L's — the
/// mark-to-mark distances the machine is told to search over.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct RegistrationArea {
    pub origin_x_mm: f64,
    pub origin_y_mm: f64,
    pub width_mm: f64,
    pub length_mm: f64,
}

/// A sheet a printer takes. Letter and A4 are what a home printer is loaded with.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper { Letter, A4 }

impl Paper {
    pub fn size_mm(self) -> (f64, f64) {
        match self {
            Paper::Letter => (215.9, 279.4),
            Paper::A4 => (210.0, 297.0),
        }
    }
}

impl RegistrationArea {
    /// The template's default for a sheet: marks inset 10 mm, spanning the sheet less that inset
    /// on both sides. [src: inkscape-silhouette render_silhouette_regmarks.py L169-180 (GPL-2.0+)]
    pub fn for_paper(paper: Paper) -> RegistrationArea {
        let (w, h) = paper.size_mm();
        let inset = REG_DEFAULT_INSET_MM;
        RegistrationArea { origin_x_mm: inset, origin_y_mm: inset, width_mm: w - 2.0 * inset, length_mm: h - 2.0 * inset }
    }

    /// Whether marks laid out here, line width and all, fit on `paper` (whose top-left corner is
    /// the Document's origin).
    pub fn fits(&self, paper: Paper) -> bool {
        let (w, h) = paper.size_mm();
        let half = REG_MARK_LINE_WIDTH_MM / 2.0;
        self.origin_x_mm - half >= 0.0 && self.origin_y_mm - half >= 0.0
            && self.origin_x_mm + self.width_mm + half <= w
            && self.origin_y_mm + self.length_mm + half <= h
    }
}

/// What a Document says about registration: the Group holding its marks, and whether the
/// operator wants the cut registered against them.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Registration {
    pub marks: NodeId,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool { true }

impl crate::Document {
    /// The area a cut should register against: `None` when registration is off or its marks are
    /// not in the Document (the add was undone, or they were deleted) — there is nothing to
    /// register against, which the cut dialog shows. Marks that are there but no longer the
    /// template's shape are an error rather than `None`: cutting unregistered a sheet the operator
    /// printed for registration would cut it in the wrong place.
    pub fn active_registration(&self) -> Result<Option<RegistrationArea>, RegistrationError> {
        match self.job.registration {
            Some(r) if r.enabled && self.get(r.marks).is_some() => self.marks_area(r.marks).map(Some),
            _ => Ok(None),
        }
    }

    /// The area the marks under `group` were laid out for, from where they now are: the union of
    /// their outlines, less the half line width an L adds outside its corner. Refuses marks that
    /// were rotated, scaled or partly deleted, since the machine is told a fixed mark size
    /// (`TB51`, `TB53`) and would search for the shape the template drew.
    pub fn marks_area(&self, group: NodeId) -> Result<RegistrationArea, RegistrationError> {
        let node = self.get(group).ok_or(RegistrationError::NoMarks)?;
        if node.children.len() != 3 { return Err(RegistrationError::MarksAltered); }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for child in &node.children {
            let mark = self.get(*child).ok_or(RegistrationError::MarksAltered)?;
            let outline = crate::commands::shape_outline(mark).ok().flatten().ok_or(RegistrationError::MarksAltered)?;
            let world = crate::commands::world_transform(self, *child).ok_or(RegistrationError::MarksAltered)?;
            let [a, b, c, d, _, _] = world.0;
            if (a - 1.0).abs() > 1e-9 || b.abs() > 1e-9 || c.abs() > 1e-9 || (d - 1.0).abs() > 1e-9 {
                return Err(RegistrationError::MarksAltered);
            }
            let bounds = outline.transformed(&world).bounds();
            x0 = x0.min(bounds.x);
            y0 = y0.min(bounds.y);
            x1 = x1.max(bounds.x + bounds.w);
            y1 = y1.max(bounds.y + bounds.h);
        }
        let half = REG_MARK_LINE_WIDTH_MM / 2.0;
        let area = RegistrationArea {
            origin_x_mm: x0 + half, origin_y_mm: y0 + half,
            width_mm: x1 - x0 - 2.0 * half, length_mm: y1 - y0 - 2.0 * half,
        };
        if !area.width_mm.is_finite() || !area.length_mm.is_finite() { return Err(RegistrationError::MarksAltered); }
        Ok(area)
    }
}

/// Why a template was refused.
#[derive(Debug, PartialEq)]
pub enum RegistrationError {
    NotFinite,
    /// The marks would overlap, or there would be no room between them to cut anything.
    TooSmall,
    OffPage,
    NoMarks,
    MarksAltered,
}

impl std::fmt::Display for RegistrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistrationError::NotFinite => write!(f, "the registration mark area must be given in numbers"),
            RegistrationError::TooSmall => write!(f,
                "the registration marks must be at least {} mm apart each way", 2.0 * REG_LINE_MM),
            RegistrationError::OffPage => write!(f, "the registration marks must fit on the page"),
            RegistrationError::NoMarks => write!(f, "this document has no registration marks; add them first"),
            RegistrationError::MarksAltered => write!(f,
                "the registration marks have been changed from the template's shape; add them again before cutting against them"),
        }
    }
}
impl std::error::Error for RegistrationError {}

impl RegistrationArea {
    fn check(&self) -> Result<(), RegistrationError> {
        let all = [self.origin_x_mm, self.origin_y_mm, self.width_mm, self.length_mm];
        if !all.iter().all(|v| v.is_finite()) { return Err(RegistrationError::NotFinite); }
        // Two L arms meet along each edge; closer than that, the marks run into each other and
        // the machine has nothing to tell apart.
        if self.width_mm < 2.0 * REG_LINE_MM || self.length_mm < 2.0 * REG_LINE_MM {
            return Err(RegistrationError::TooSmall);
        }
        let half = REG_MARK_LINE_WIDTH_MM / 2.0;
        if self.origin_x_mm - half < 0.0 || self.origin_y_mm - half < 0.0 {
            return Err(RegistrationError::OffPage);
        }
        Ok(())
    }
}

/// An L mark's outline: the area a `REG_MARK_LINE_WIDTH_MM` stroke along two `REG_LINE_MM` arms
/// covers, with the square corner a mitred join gives. `h` and `v` (±1) point the arms inward,
/// as the template's `h_dir`/`v_dir` do. [src: inkscape-silhouette render_silhouette_regmarks.py L90-98 (GPL-2.0+)]
fn l_mark_outline(cx: f64, cy: f64, h: f64, v: f64) -> String {
    let hw = REG_MARK_LINE_WIDTH_MM / 2.0;
    let arm = REG_LINE_MM;
    let pts = [
        (cx + h * arm, cy - v * hw),
        (cx - h * hw, cy - v * hw),
        (cx - h * hw, cy + v * arm),
        (cx + h * hw, cy + v * arm),
        (cx + h * hw, cy + v * hw),
        (cx + h * arm, cy + v * hw),
    ];
    let mut d = String::new();
    for (i, (x, y)) in pts.iter().enumerate() {
        d.push_str(&format!("{}{} {} ", if i == 0 { "M" } else { "L" }, fmt(*x), fmt(*y)));
    }
    d.push('Z');
    d
}

/// Short decimal spelling, so `10.15` is not written `10.149999999999999`.
fn fmt(v: f64) -> String {
    let s = format!("{:.4}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn mark(id: NodeId, kind: ShapeKind, transform: Affine) -> Node {
    let mut node = Node::shape(id, kind);
    node.transform = transform;
    node.style = Style { stroke: None, fill: Some(BLACK) };
    // Printed, never cut: a blade over a registration mark cuts the one thing the machine needs to
    // see on the next sheet.
    node.cut_line_type = CutLineType::NoCut;
    node
}

impl Editor {
    /// Lay out registration marks for `area` under the Document's root as one undoable step,
    /// replacing any marks this Document already has, and register the cut against them.
    ///
    /// A replacement keeps the Group's id: `Registration` names the Group, and undoing the
    /// replacement must bring back marks it still names rather than an orphan it does not.
    pub fn add_registration_marks(&mut self, area: RegistrationArea) -> Result<Delta, RegistrationError> {
        area.check()?;
        let mut ops = Vec::new();
        let existing = self.doc.job.registration.map(|r| r.marks).filter(|id| self.doc.get(*id).is_some());
        let group_id = match existing {
            Some(old) => {
                // In the same step, so one undo puts the previous layout back whole.
                let removal = crate::commands::delete_nodes(&self.doc, &[old]).map_err(|_| RegistrationError::NoMarks)?;
                ops.extend(removal.0);
                old
            }
            None => self.doc.ids.next(),
        };
        let ids = &mut self.doc.ids;
        let mut group = Node::container(group_id, NodeKind::Group);
        group.cut_line_type = CutLineType::NoCut;
        group.style = Style { stroke: None, fill: None };
        let (ox, oy) = (area.origin_x_mm, area.origin_y_mm);
        let square = mark(ids.next(), ShapeKind::Rect { w: REG_SQUARE_MM, h: REG_SQUARE_MM }, Affine::translate(ox, oy));
        let top_right = mark(ids.next(), ShapeKind::Path { d: l_mark_outline(ox + area.width_mm, oy, -1.0, 1.0) }, Affine::identity());
        let bottom_left = mark(ids.next(), ShapeKind::Path { d: l_mark_outline(ox, oy + area.length_mm, 1.0, -1.0) }, Affine::identity());
        let root = self.doc.root;
        ops.push(NodeOp::Add { parent: root, node: group, index: usize::MAX });
        for node in [square, top_right, bottom_left] {
            ops.push(NodeOp::Add { parent: group_id, node, index: usize::MAX });
        }
        let delta = self.commit(Delta(ops));
        self.doc.job.registration = Some(Registration { marks: group_id, enabled: true });
        Ok(delta)
    }

    /// Whether the cut registers against the marks. Refused when there are none to register
    /// against, so a switch an operator turned on cannot be quietly doing nothing.
    pub fn set_registration_enabled(&mut self, on: bool) -> Result<(), RegistrationError> {
        let has_marks = self.doc.job.registration.is_some_and(|r| self.doc.get(r.marks).is_some());
        match self.doc.job.registration.as_mut() {
            Some(r) if has_marks || !on => { r.enabled = on; Ok(()) }
            _ if !on => Ok(()),
            _ => Err(RegistrationError::NoMarks),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::world_transform;

    fn letter() -> RegistrationArea { RegistrationArea::for_paper(Paper::Letter) }

    fn marks_of(ed: &Editor) -> Vec<Node> {
        let group = ed.doc.job.registration.unwrap().marks;
        ed.doc.get(group).unwrap().children.iter().map(|c| ed.doc.get(*c).unwrap().clone()).collect()
    }

    fn bbox(ed: &Editor, node: &Node) -> (f64, f64, f64, f64) {
        let path = crate::commands::shape_outline(node).unwrap().unwrap();
        let b = path.transformed(&world_transform(&ed.doc, node.id).unwrap()).bounds();
        (b.x, b.y, b.x + b.w, b.y + b.h)
    }

    fn close(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
        [a.0 - b.0, a.1 - b.1, a.2 - b.2, a.3 - b.3].iter().all(|d| d.abs() < 1e-6)
    }

    fn same_area(a: RegistrationArea, b: RegistrationArea) -> bool {
        close((a.origin_x_mm, a.origin_y_mm, a.width_mm, a.length_mm), (b.origin_x_mm, b.origin_y_mm, b.width_mm, b.length_mm))
    }

    #[test]
    fn paper_defaults_are_the_templates_ten_mm_inset() {
        let a = letter();
        assert_eq!((a.origin_x_mm, a.origin_y_mm), (10.0, 10.0));
        assert!((a.width_mm - 195.9).abs() < 1e-9 && (a.length_mm - 259.4).abs() < 1e-9);
        let a4 = RegistrationArea::for_paper(Paper::A4);
        assert_eq!((a4.width_mm, a4.length_mm), (190.0, 277.0));
        assert!(a.fits(Paper::Letter) && a4.fits(Paper::A4));
        assert!(!a4.fits(Paper::Letter), "A4's marks run off the bottom of a Letter sheet");
    }

    /// The square at the origin, the top-right L's corner at (origin + width, origin) and the
    /// bottom-left's at (origin, origin + length), each arm 20 mm and 0.3 mm wide — and every one
    /// of them printed, never cut.
    #[test]
    fn the_marks_are_where_the_template_puts_them_and_are_never_cut() {
        let mut ed = Editor::new();
        ed.add_registration_marks(letter()).unwrap();
        let group = ed.doc.get(ed.doc.job.registration.unwrap().marks).unwrap();
        assert!(matches!(group.kind, NodeKind::Group));
        let marks = marks_of(&ed);
        assert_eq!(marks.len(), 3);
        assert!(marks.iter().all(|m| m.cut_line_type == CutLineType::NoCut));
        assert!(marks.iter().all(|m| m.style == Style { stroke: None, fill: Some(BLACK) }));

        let hw = 0.15;
        assert!(close(bbox(&ed, &marks[0]), (10.0, 10.0, 15.0, 15.0)), "{:?}", bbox(&ed, &marks[0]));
        let right = 10.0 + 195.9;
        assert!(close(bbox(&ed, &marks[1]), (right - 20.0, 10.0 - hw, right + hw, 30.0)), "{:?}", bbox(&ed, &marks[1]));
        let bottom = 10.0 + 259.4;
        assert!(close(bbox(&ed, &marks[2]), (10.0 - hw, bottom - 20.0, 30.0, bottom + hw)), "{:?}", bbox(&ed, &marks[2]));
    }

    #[test]
    fn the_area_read_back_off_the_marks_is_the_area_they_were_laid_out_for() {
        let mut ed = Editor::new();
        let custom = RegistrationArea { origin_x_mm: 12.5, origin_y_mm: 20.0, width_mm: 150.0, length_mm: 200.0 };
        ed.add_registration_marks(custom).unwrap();
        assert!(same_area(ed.doc.active_registration().unwrap().unwrap(), custom));
    }

    /// Moving the marks moves the registration with them; turning them is refused, because the
    /// machine searches for the template's shape.
    #[test]
    fn registration_follows_the_marks_and_refuses_them_altered() {
        let mut ed = Editor::new();
        ed.add_registration_marks(letter()).unwrap();
        let group = ed.doc.job.registration.unwrap().marks;
        ed.doc.nodes.get_mut(&group).unwrap().transform = Affine::translate(5.0, 0.0);
        let moved = ed.doc.active_registration().unwrap().unwrap();
        assert!((moved.origin_x_mm - 15.0).abs() < 1e-9 && (moved.width_mm - 195.9).abs() < 1e-9);

        ed.doc.nodes.get_mut(&group).unwrap().transform = Affine([0.0, 1.0, -1.0, 0.0, 0.0, 0.0]);
        assert_eq!(ed.doc.active_registration(), Err(RegistrationError::MarksAltered));
        ed.doc.nodes.get_mut(&group).unwrap().transform = Affine::identity();
        let lone = ed.doc.get(group).unwrap().children[1];
        let d = crate::commands::delete_nodes(&ed.doc, &[lone]).unwrap();
        ed.commit(d);
        assert_eq!(ed.doc.active_registration(), Err(RegistrationError::MarksAltered));
    }

    /// Adding again replaces the marks in one step under the same Group, so undoing it puts the
    /// first layout back *and* registers against it; undoing the very first add leaves no marks,
    /// so nothing registers.
    #[test]
    fn undo_and_redo_keep_registration_and_marks_together() {
        let mut ed = Editor::new();
        ed.add_registration_marks(letter()).unwrap();
        let a4 = RegistrationArea::for_paper(Paper::A4);
        ed.add_registration_marks(a4).unwrap();
        assert_eq!(ed.doc.get(ed.doc.root).unwrap().children.len(), 1, "replaced, not added beside");
        assert!(same_area(ed.doc.active_registration().unwrap().unwrap(), a4));

        ed.undo();
        assert!(same_area(ed.doc.active_registration().unwrap().unwrap(), letter()), "undo restores the letter marks and registers against them");
        ed.undo();
        assert!(ed.doc.get(ed.doc.root).unwrap().children.is_empty());
        assert_eq!(ed.doc.active_registration(), Ok(None), "no marks, so nothing to register against");
        ed.redo();
        assert!(same_area(ed.doc.active_registration().unwrap().unwrap(), letter()));
        ed.redo();
        assert!(same_area(ed.doc.active_registration().unwrap().unwrap(), a4));
    }

    #[test]
    fn the_switch_turns_registration_off_and_needs_marks_to_turn_on() {
        let mut ed = Editor::new();
        assert_eq!(ed.set_registration_enabled(true), Err(RegistrationError::NoMarks));
        assert_eq!(ed.set_registration_enabled(false), Ok(()));
        ed.add_registration_marks(letter()).unwrap();
        ed.set_registration_enabled(false).unwrap();
        assert_eq!(ed.doc.active_registration(), Ok(None));
        ed.set_registration_enabled(true).unwrap();
        assert!(ed.doc.active_registration().unwrap().is_some());
    }

    #[test]
    fn an_area_that_cannot_be_printed_or_told_apart_is_refused() {
        let mut ed = Editor::new();
        let base = letter();
        assert_eq!(ed.add_registration_marks(RegistrationArea { width_mm: f64::NAN, ..base }), Err(RegistrationError::NotFinite));
        assert_eq!(ed.add_registration_marks(RegistrationArea { width_mm: 39.0, ..base }), Err(RegistrationError::TooSmall));
        assert_eq!(ed.add_registration_marks(RegistrationArea { origin_y_mm: 0.1, ..base }), Err(RegistrationError::OffPage));
        assert!(ed.doc.job.registration.is_none() && ed.doc.get(ed.doc.root).unwrap().children.is_empty());
    }

    /// A project saved before registration existed opens with none.
    #[test]
    fn job_settings_without_registration_read_as_none() {
        let job: crate::JobSettings = serde_json::from_str(r#"{"layers":{},"layer_order":[],"mirror":false}"#).unwrap();
        assert_eq!(job.registration, None);
    }
}
