// SPDX-License-Identifier: GPL-3.0-or-later
use std::path::Path;
use document::{CmdError, CutLineType, Delta, Editor, MachineProfile, NodeId, PresetAssignment, ShapeKind, commands, shape_tools};
use fileio::IoError;
use geometry::{Affine, BoolOp};

/// Wraps the document `Editor` with thin methods, one per IPC command. Each method
/// carries the actual logic (or delegates straight to `document`/`fileio`); `ipc.rs`
/// just maps typed errors to `String` for the Tauri boundary.
pub struct AppState {
    pub editor: Editor,
}

impl AppState {
    pub fn new() -> Self {
        AppState { editor: Editor::new() }
    }

    /// Test/IPC helper: add a rect under the document root, committed as one step.
    pub fn add_rect(&mut self, w: f64, h: f64) -> NodeId {
        let d = commands::add_primitive(&mut self.editor.doc.ids, self.editor.doc.root,
            ShapeKind::Rect { w, h }).unwrap();
        let id = if let document::NodeOp::Add { node, .. } = &d.0[0] { node.id } else { unreachable!() };
        self.editor.commit(d);
        id
    }

    /// Discards the current document (and its undo history) and starts a fresh one.
    pub fn new_doc(&mut self) -> String {
        self.editor = Editor::new();
        self.snapshot()
    }

    pub fn snapshot(&self) -> String {
        self.editor.doc.snapshot_json()
    }

    pub fn commit_transform(&mut self, ids: Vec<NodeId>, m: Affine) -> Result<Delta, CmdError> {
        let d = commands::transform_nodes(&self.editor.doc, &ids, m)?;
        Ok(self.editor.commit(d))
    }

    /// Every move in one undo, all or nothing: align and distribute give each unit its own matrix.
    pub fn commit_transforms(&mut self, moves: Vec<(Vec<NodeId>, Affine)>) -> Result<Delta, CmdError> {
        let d = commands::transform_each(&self.editor.doc, &moves)?;
        Ok(self.editor.commit(d))
    }

    pub fn add_primitive(&mut self, parent: NodeId, kind: ShapeKind) -> Result<Delta, CmdError> {
        let d = commands::add_primitive(&mut self.editor.doc.ids, parent, kind)?;
        Ok(self.editor.commit(d))
    }

    pub fn boolean_op(&mut self, ids: Vec<NodeId>, op: BoolOp) -> Result<Delta, CmdError> {
        self.editor.boolean(&ids, op)
    }

    pub fn add_text(&mut self, parent: NodeId, family: String, size_mm: f64, text: String) -> Result<Delta, CmdError> {
        self.editor.add_text(parent, &family, size_mm, &text)
    }

    pub fn offset_shapes(&mut self, ids: Vec<NodeId>, distance_mm: f64, union: bool, join: geometry::Join)
        -> Result<Delta, CmdError> {
        self.editor.commit_minted(|doc, gen| shape_tools::offset_shapes(doc, gen, &ids, distance_mm, union, join))
    }

    pub fn weed_box(&mut self, ids: Vec<NodeId>, margin_mm: f64, line_spacing_mm: Option<f64>)
        -> Result<Delta, CmdError> {
        self.editor.commit_minted(|doc, gen| shape_tools::weed_box(doc, gen, &ids, margin_mm, line_spacing_mm))
    }

    pub fn array_copies(&mut self, ids: Vec<NodeId>, cols: u32, rows: u32, gap_x_mm: f64, gap_y_mm: f64)
        -> Result<Delta, CmdError> {
        self.editor.commit_minted(|doc, gen| shape_tools::array_copies(doc, gen, &ids, cols, rows, gap_x_mm, gap_y_mm))
    }

    pub fn update_text(&mut self, id: NodeId, family: String, size_mm: f64, text: String) -> Result<Delta, CmdError> {
        let d = commands::update_text(&self.editor.doc, id, &family, size_mm, &text)?;
        // An edit that changes nothing is not an undo step, as with `set_cut_line_type`.
        if d.0.is_empty() { return Ok(d); }
        Ok(self.editor.commit(d))
    }

    pub fn convert_to_path(&mut self, ids: Vec<NodeId>) -> Result<Delta, CmdError> {
        let d = commands::convert_to_path(&self.editor.doc, &ids)?;
        if d.0.is_empty() { return Ok(d); }
        Ok(self.editor.commit(d))
    }

    pub fn weld(&mut self, ids: Vec<NodeId>) -> Result<Delta, CmdError> {
        self.editor.commit_minted(|doc, gen| shape_tools::weld(doc, gen, &ids))
    }

    pub fn delete(&mut self, ids: Vec<NodeId>) -> Result<Delta, CmdError> {
        let d = commands::delete_nodes(&self.editor.doc, &ids)?;
        Ok(self.editor.commit(d))
    }

    pub fn reorder(&mut self, id: NodeId, new_index: usize) -> Result<Delta, CmdError> {
        let d = commands::reorder(&self.editor.doc, id, new_index)?;
        Ok(self.editor.commit(d))
    }

    pub fn set_cut_line_type(&mut self, ids: Vec<NodeId>, value: CutLineType)
        -> Result<Delta, CmdError> {
        let d = commands::set_cut_line_type(&self.editor.doc, &ids, value)?;
        // An empty delta is a no-op the operator asked for; committing it would clear the
        // redo stack and add an undo step that does nothing.
        if d.0.is_empty() { return Ok(d); }
        Ok(self.editor.commit(d))
    }

    pub fn set_stroke_color(&mut self, ids: Vec<NodeId>, rgba: u32) -> Result<Delta, CmdError> {
        let d = commands::set_stroke_color(&self.editor.doc, &ids, rgba)?;
        // Same rule as `set_cut_line_type`: re-picking the swatch a selection already has is a
        // no-op, not an undo step.
        if d.0.is_empty() { return Ok(d); }
        Ok(self.editor.commit(d))
    }

    pub fn set_material_preset(&mut self, ids: Vec<NodeId>, value: PresetAssignment)
        -> Result<Delta, CmdError> {
        let d = commands::set_material_preset(&self.editor.doc, &ids, value)?;
        // Same rule as `set_cut_line_type`: an empty delta is a no-op the operator asked for,
        // and committing it would clear the redo stack and add an undo step that does nothing.
        if d.0.is_empty() { return Ok(d); }
        Ok(self.editor.commit(d))
    }

    pub fn undo(&mut self) -> Option<Delta> {
        self.editor.undo()
    }

    pub fn redo(&mut self) -> Option<Delta> {
        self.editor.redo()
    }

    /// Imports SVG paths under `parent`, committed as one undoable step. Returns the
    /// committed delta plus any elements the importer had to skip (unsupported nodes).
    pub fn import_svg(&mut self, bytes: Vec<u8>, parent: NodeId) -> Result<(Delta, Vec<String>), IoError> {
        let (d, skipped) = fileio::import_svg(&bytes, &mut self.editor.doc.ids, parent)?;
        Ok((self.editor.commit(d), skipped))
    }

    pub fn save_project(&self, path: &Path) -> Result<(), IoError> {
        fileio::save_project(path, &self.editor.doc)
    }

    /// Loads a project from disk, replacing the current document and undo history.
    pub fn load_project(&mut self, path: &Path) -> Result<String, IoError> {
        let doc = fileio::load_project(path)?;
        self.editor = Editor::new();
        self.editor.doc = doc;
        Ok(self.snapshot())
    }

    pub fn set_layer_settings(&mut self, key: String, value: Option<document::LayerSettings>) {
        self.editor.set_layer_settings(key, value);
    }

    pub fn set_layer_order(&mut self, order: Vec<String>) {
        self.editor.set_layer_order(order);
    }

    pub fn set_mirror(&mut self, on: bool) {
        self.editor.set_mirror(on);
    }

    pub fn set_media(&mut self, w_mm: f64, h_mm: f64) -> Result<geometry::Rect, document::MediaError> {
        self.editor.set_media(w_mm, h_mm)
    }

    pub fn set_machine(&mut self, machine_id: &str) -> Result<(), CmdError> {
        let profile = document::builtin_profiles().into_iter().find(|p| p.id == machine_id)
            .ok_or(CmdError::NotFound)?;
        self.editor.set_machine(profile);
        Ok(())
    }

    pub fn list_machines(&self) -> Vec<MachineProfile> {
        document::builtin_profiles()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the ordering in `load_project` — parse, *then* replace the editor — which is what
    /// keeps a refused open (a newer project, or corrupt bytes) from costing the operator the
    /// document they already had open.
    #[test]
    fn app_state_keeps_its_document_when_a_load_fails() {
        let mut app = AppState::new();
        let id = app.add_rect(10.0, 10.0);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-project.cut");
        std::fs::write(&path, b"not a zip").unwrap();
        assert!(app.load_project(&path).is_err());
        assert!(app.editor.doc.get(id).is_some(),
            "a failed load must not replace the open document");
    }

    #[test]
    fn app_state_commit_transform_moves_node() {
        let mut app = AppState::new();
        let id = app.add_rect(10.0, 10.0);
        app.commit_transform(vec![id], geometry::Affine::translate(3.0, 0.0)).unwrap();
        assert_eq!(app.editor.doc.get(id).unwrap().transform.apply(0.0, 0.0), (3.0, 0.0));
    }

    #[test]
    fn app_state_commit_transforms_is_one_undo() {
        let mut app = AppState::new();
        let a = app.add_rect(10.0, 10.0);
        let b = app.add_rect(10.0, 10.0);
        app.commit_transforms(vec![
            (vec![a], geometry::Affine::translate(3.0, 0.0)),
            (vec![b], geometry::Affine::translate(0.0, 4.0)),
        ]).unwrap();
        app.undo().unwrap();
        assert_eq!(app.editor.doc.get(a).unwrap().transform.apply(0.0, 0.0), (0.0, 0.0));
        assert_eq!(app.editor.doc.get(b).unwrap().transform.apply(0.0, 0.0), (0.0, 0.0));
    }

    #[test]
    fn app_state_commit_transforms_refused_changes_nothing() {
        // Refused before anything is committed: no half-aligned document and no undo entry.
        let mut app = AppState::new();
        let a = app.add_rect(10.0, 10.0);
        let r = app.commit_transforms(vec![
            (vec![a], geometry::Affine::translate(3.0, 0.0)),
            (vec![NodeId(9_999)], geometry::Affine::translate(1.0, 0.0)),
        ]);
        assert!(r.is_err());
        assert_eq!(app.editor.doc.get(a).unwrap().transform.apply(0.0, 0.0), (0.0, 0.0));
        app.undo().unwrap(); // the undo is the rect's own add, so the rect goes
        assert!(app.editor.doc.get(a).is_none());
    }

    #[test]
    fn app_state_undo_reverts_last_commit() {
        let mut app = AppState::new();
        let id = app.add_rect(5.0, 5.0);
        assert!(app.editor.doc.get(id).is_some());
        app.undo();
        assert!(app.editor.doc.get(id).is_none());
        app.redo();
        assert!(app.editor.doc.get(id).is_some());
    }

    #[test]
    fn app_state_import_svg_commits_paths_under_parent() {
        let mut app = AppState::new();
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>"#;
        let root = app.editor.doc.root;
        let (_, skipped) = app.import_svg(svg.to_vec(), root).unwrap();
        assert!(skipped.is_empty());
        assert_eq!(app.editor.doc.get(root).unwrap().children.len(), 1);
    }

    #[test]
    fn app_state_set_machine_rejects_unknown_id() {
        let mut app = AppState::new();
        assert!(app.set_machine("not-a-real-machine").is_err());
    }

    #[test]
    fn app_state_new_doc_clears_history() {
        let mut app = AppState::new();
        app.add_rect(1.0, 1.0);
        app.new_doc();
        assert!(app.undo().is_none());
    }

    /// The panel dispatches on every click, including the one that re-picks the value the
    /// selection already carries. Committing that empty delta would clear the redo stack and
    /// leave an undo step that undoes nothing, so the method must decline to commit it.
    #[test]
    fn app_state_set_cut_line_type_no_op_keeps_redo_stack() {
        let mut app = AppState::new();
        let id = app.add_rect(1.0, 1.0);
        app.add_rect(2.0, 2.0);
        app.undo();

        let d = app.set_cut_line_type(vec![id], CutLineType::Cut).unwrap();
        assert!(d.0.is_empty(), "premise: the rect already cuts");
        assert!(app.redo().is_some(), "a no-op must not throw away redoable work");
    }

    #[test]
    fn app_state_set_stroke_color_no_op_keeps_redo_stack() {
        let mut app = AppState::new();
        let id = app.add_rect(1.0, 1.0);
        app.add_rect(2.0, 2.0);
        app.undo();

        let d = app.set_stroke_color(vec![id], 0x000000ff).unwrap();
        assert!(d.0.is_empty(), "premise: a new rect is stroked black");
        assert!(app.redo().is_some(), "a no-op must not throw away redoable work");
    }

    /// Each machine's profile is written twice — once in `document::builtin_profiles` (the
    /// artboard an operator designs on) and once in its Driver (what preflight checks the cut
    /// against). Here, where both crates are visible, they are pinned together: an artboard wider
    /// than the driver's reach would offer space that every cut there is refused for.
    #[test]
    fn every_document_profile_matches_its_driver() {
        use driver_core::DeviceBackendFactory;
        for p in document::builtin_profiles() {
            let driver = driver_registry::HardwareBackendFactory.driver_for(&p.id)
                .unwrap_or_else(|| panic!("no driver for document profile `{}`", p.id));
            let d = driver.profile();
            assert_eq!((d.id.as_str(), d.name.as_str(), d.width_mm, d.height_mm),
                       (p.id.as_str(), p.name.as_str(), p.width_mm, p.height_mm), "{}", p.id);
        }
    }

    /// The shape tools go through `commit_minted`: one undo each, and the nodes they add are new.
    #[test]
    fn app_state_offset_adds_one_undoable_contour() {
        let mut app = AppState::new();
        let id = app.add_rect(10.0, 10.0);
        let d = app.offset_shapes(vec![id], 1.0, true, geometry::Join::Round).unwrap();
        assert_eq!(d.0.len(), 1);
        assert_eq!(app.editor.doc.get(app.editor.doc.root).unwrap().children.len(), 2);
        app.undo().unwrap();
        assert_eq!(app.editor.doc.get(app.editor.doc.root).unwrap().children, vec![id]);
    }
}
