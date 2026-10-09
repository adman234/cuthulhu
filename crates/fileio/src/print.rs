// SPDX-License-Identifier: GPL-3.0-or-later
//! The sheet a print & cut job is printed from: every visible paint in the Document — registration
//! marks, artwork, and lines that are cut as well as drawn — at true size on a page of the paper
//! the printer is loaded with.
//!
//! Separate from `doc_to_svg`, which writes the project's interchange copy on the artboard: a
//! Cameo's artboard is a 295 mm x 3 m roll, the page is the paper, and the marks only register if
//! the sheet is printed at 100 % with its top-left corner at the Document's origin.
use std::path::Path;
use document::{shape_outline, Document, NodeId, NodeKind, Paper};
use geometry::Affine;
use crate::{paint_attrs, IoError};

/// Width a stroked line prints at, in mm. A Node has no stroke width of its own, and SVG's default
/// of one user unit would be a 1 mm line here.
// ponytail: one width for every stroke. A cut line is usually not meant to show at all and art is
// mostly fills; give `Style` a width when someone needs printed outlines of their own weight.
pub const PRINT_STROKE_MM: f64 = 0.25;

/// Why a sheet was refused.
#[derive(Debug)]
pub enum PrintError {
    /// The registration marks run off the page, so the printed sheet could not be registered.
    MarksOffPage(Paper),
    Marks(document::RegistrationError),
    Shape(NodeId, String),
    Io(IoError),
}

impl std::fmt::Display for PrintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PrintError::MarksOffPage(paper) => write!(f,
                "the registration marks do not fit on {} paper; add marks for that paper first", paper_name(*paper)),
            PrintError::Marks(e) => write!(f, "{e}"),
            PrintError::Shape(node, message) => write!(f, "shape #{}: {message}", node.0),
            PrintError::Io(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for PrintError {}

fn paper_name(paper: Paper) -> &'static str {
    match paper { Paper::Letter => "Letter", Paper::A4 => "A4" }
}

/// The printable sheet as SVG, sized in mm so a printer at 100 % reproduces it exactly.
///
/// Marks are checked against the page whether or not registration is switched on: a sheet printed
/// with them cut off cannot be registered later either.
pub fn doc_to_print_svg(doc: &Document, paper: Paper) -> Result<String, PrintError> {
    if let Some(reg) = doc.job.registration.filter(|r| doc.get(r.marks).is_some()) {
        let area = doc.marks_area(reg.marks).map_err(PrintError::Marks)?;
        if !area.fits(paper) {
            return Err(PrintError::MarksOffPage(paper));
        }
    }
    let mut body = String::new();
    walk(doc, doc.root, &Affine::identity(), &mut body)?;
    let (w, h) = paper.size_mm();
    Ok(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">{body}</svg>"#
    ))
}

fn walk(doc: &Document, id: NodeId, parent_xf: &Affine, out: &mut String) -> Result<(), PrintError> {
    let Some(node) = doc.get(id) else { return Ok(()) };
    let xf = node.transform.then(parent_xf);
    match &node.kind {
        NodeKind::Shape(_) => {
            // Paint decides what prints, not `cut_line_type`: the marks are `NoCut` and must print,
            // and a cut line with a visible stroke is drawn as the operator sees it on screen.
            let visible = |p: Option<u32>| p.is_some_and(|c| c & 0xFF != 0);
            if !visible(node.style.stroke) && !visible(node.style.fill) {
                return Ok(());
            }
            // Text resolves through its font here, where `doc_to_svg` skips it: a printed label
            // that silently vanished would be found only on paper.
            let path = shape_outline(node).map_err(|e| PrintError::Shape(id, e))?;
            if let Some(path) = path {
                let stroke_width = if visible(node.style.stroke) { format!(" stroke-width=\"{PRINT_STROKE_MM}\"") } else { String::new() };
                out.push_str(&format!(
                    "<path d=\"{}\"{}{}{stroke_width}/>",
                    path.transformed(&xf).to_svg(),
                    paint_attrs("stroke", node.style.stroke),
                    paint_attrs("fill", node.style.fill),
                ));
            }
        }
        NodeKind::Group | NodeKind::Layer => {
            for child in &node.children { walk(doc, *child, &xf, out)?; }
        }
    }
    Ok(())
}

/// Write the printable sheet to `path`, atomically, as `save_project` writes a project.
pub fn export_print_svg(path: &Path, doc: &Document, paper: Paper) -> Result<(), PrintError> {
    let svg = doc_to_print_svg(doc, paper)?;
    let io = |e: String| PrintError::Io(IoError::Io(e));
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| io(e.to_string()))?;
    std::io::Write::write_all(&mut tmp, svg.as_bytes()).map_err(|e| io(e.to_string()))?;
    tmp.persist(path).map_err(|e| io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use document::{CutLineType, Delta, Editor, Node, NodeOp, RegistrationArea, ShapeKind, Style};

    fn with_rect(ed: &mut Editor, style: Style, cut: CutLineType) {
        let root = ed.doc.root;
        let id = ed.doc.ids.next();
        let mut node = Node::shape(id, ShapeKind::Rect { w: 10.0, h: 10.0 });
        node.style = style;
        node.cut_line_type = cut;
        node.transform = Affine::translate(50.0, 60.0);
        ed.commit(Delta(vec![NodeOp::Add { parent: root, node, index: usize::MAX }]));
    }

    /// True size on the paper, not the artboard: a Cameo 1's artboard is 295 mm x 3 m.
    #[test]
    fn the_sheet_is_the_paper_at_true_size() {
        let mut ed = Editor::new();
        ed.add_registration_marks(RegistrationArea::for_paper(Paper::A4)).unwrap();
        let svg = doc_to_print_svg(&ed.doc, Paper::A4).unwrap();
        assert!(svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">"#), "{svg}");
    }

    /// Marks and artwork both print, cut or not; a shape with no visible paint does not.
    #[test]
    fn every_visible_paint_prints_and_nothing_else() {
        let mut ed = Editor::new();
        ed.add_registration_marks(RegistrationArea::for_paper(Paper::Letter)).unwrap();
        with_rect(&mut ed, Style { stroke: None, fill: Some(0xFF0000FF) }, CutLineType::NoCut);
        with_rect(&mut ed, Style { stroke: Some(0x0000FFFF), fill: None }, CutLineType::Cut);
        with_rect(&mut ed, Style { stroke: Some(0x00FF0000), fill: None }, CutLineType::Cut);
        let svg = doc_to_print_svg(&ed.doc, Paper::Letter).unwrap();
        assert_eq!(svg.matches("<path").count(), 3 + 2, "three marks and two painted rects: {svg}");
        // The square at (10, 10), black and unstroked.
        assert!(svg.contains(r##"<path d="M10,10 L15,10 L15,15 L10,15 Z" stroke="none" fill="#000000"/>"##), "{svg}");
        assert!(svg.contains(r##"fill="#ff0000""##), "{svg}");
        assert!(svg.contains(r##"stroke="#0000ff" fill="none" stroke-width="0.25""##), "{svg}");
    }

    #[test]
    fn marks_that_run_off_the_paper_are_refused() {
        let mut ed = Editor::new();
        ed.add_registration_marks(RegistrationArea::for_paper(Paper::A4)).unwrap();
        assert!(matches!(doc_to_print_svg(&ed.doc, Paper::Letter), Err(PrintError::MarksOffPage(Paper::Letter))));
        assert_eq!(PrintError::MarksOffPage(Paper::Letter).to_string(),
            "the registration marks do not fit on Letter paper; add marks for that paper first");
    }

    #[test]
    fn export_writes_the_sheet_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sheet.svg");
        let mut ed = Editor::new();
        ed.add_registration_marks(RegistrationArea::for_paper(Paper::Letter)).unwrap();
        export_print_svg(&path, &ed.doc, Paper::Letter).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, doc_to_print_svg(&ed.doc, Paper::Letter).unwrap());
        // And what the importer reads back is the same three marks, at the same place.
        let back = crate::svg_to_paths(written.as_bytes()).unwrap();
        assert_eq!(back.paths.len(), 3);
    }
}
