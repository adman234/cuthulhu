// SPDX-License-Identifier: GPL-3.0-or-later
//! What the operator chose about cutting this Document, saved with it: each colour pass's
//! settings, the order the passes are cut in, whether the job is mirrored, and the media.
//!
//! Kept beside the tree rather than in it because none of it belongs to a Node: a pass is the
//! planner's grouping of Nodes (keyed by the same `PassKey` spelling the cut path uses), and it
//! comes and goes as shapes are recoloured. Settings for a pass that no shape currently makes are
//! kept, so recolouring a shape back finds its layer as it was left.
//!
//! These are not `Delta`s: like the machine choice, they are panel state an operator sets, not
//! geometry, and undo walks the drawing.
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use geometry::Rect;
use crate::history::Editor;

/// One pass's saved choices. Every `None` defers to the material preset, the same rule the cut
/// request follows.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct PassSettings {
    #[serde(default = "yes")]
    pub output: bool,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub speed: Option<u32>,
    #[serde(default)]
    pub force: Option<u32>,
    #[serde(default)]
    pub repeat_count: Option<u32>,
    #[serde(default)]
    pub track_enhancing: Option<bool>,
    #[serde(default)]
    pub pen: Option<bool>,
}

fn yes() -> bool { true }

impl Default for PassSettings {
    fn default() -> Self {
        PassSettings { output: true, preset_id: None, speed: None, force: None, repeat_count: None, track_enhancing: None, pen: None }
    }
}

#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct JobSettings {
    /// Keyed by `PassKey` spelling (`color:ff0000ff`, …).
    #[serde(default)]
    pub pass_settings: BTreeMap<String, PassSettings>,
    /// The order passes are cut in, by key. A pass missing here follows, in planned order.
    #[serde(default)]
    pub pass_order: Vec<String>,
    /// Cut the job mirrored left-to-right across the artboard, as heat-transfer vinyl needs.
    #[serde(default)]
    pub mirror: bool,
    /// The registration marks this Document prints, for print & cut. See `registration.rs`.
    #[serde(default)]
    pub registration: Option<crate::registration::Registration>,
}

/// Why a media size was refused.
#[derive(Debug, PartialEq)]
pub enum MediaError {
    NoMachine,
    NotPositive,
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::NoMachine => write!(f, "choose a machine before setting the media size"),
            MediaError::NotPositive => write!(f, "a media size must be wider and longer than zero"),
        }
    }
}

impl Editor {
    /// `None` forgets the pass's settings, so it starts again from its preset.
    pub fn set_pass_settings(&mut self, key: String, value: Option<PassSettings>) {
        match value {
            Some(v) => { self.doc.job.pass_settings.insert(key, v); }
            None => { self.doc.job.pass_settings.remove(&key); }
        }
    }

    pub fn set_pass_order(&mut self, order: Vec<String>) {
        // A key named twice would make "cut first" ambiguous; keep its first place.
        let mut seen = std::collections::HashSet::new();
        self.doc.job.pass_order = order.into_iter().filter(|k| seen.insert(k.clone())).collect();
    }

    pub fn set_mirror(&mut self, on: bool) {
        self.doc.job.mirror = on;
    }

    /// Size the artboard to the media loaded — a 12×12 mat, a strip of roll — clamped to what the
    /// machine can reach, so a design laid out on the artboard is one the blade can cut.
    pub fn set_media(&mut self, w_mm: f64, h_mm: f64) -> Result<Rect, MediaError> {
        let m = self.doc.machine.as_ref().ok_or(MediaError::NoMachine)?;
        if !(w_mm > 0.0 && h_mm > 0.0) { return Err(MediaError::NotPositive); }
        self.doc.artboard = Rect { x: 0.0, y: 0.0, w: w_mm.min(m.width_mm), h: h_mm.min(m.height_mm) };
        Ok(self.doc.artboard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::builtin_profiles;

    #[test]
    fn layer_settings_are_saved_forgotten_and_ordered_without_duplicates() {
        let mut ed = Editor::new();
        let s = PassSettings { speed: Some(4), output: false, ..PassSettings::default() };
        ed.set_pass_settings("color:ff0000ff".into(), Some(s.clone()));
        assert_eq!(ed.doc.job.pass_settings.get("color:ff0000ff"), Some(&s));
        ed.set_pass_settings("color:ff0000ff".into(), None);
        assert!(ed.doc.job.pass_settings.is_empty());
        ed.set_pass_order(vec!["b".into(), "a".into(), "b".into()]);
        assert_eq!(ed.doc.job.pass_order, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn media_is_clamped_to_the_machines_reach_and_needs_a_machine() {
        let mut ed = Editor::new();
        assert_eq!(ed.set_media(300.0, 300.0), Err(MediaError::NoMachine));
        let cameo1 = builtin_profiles().into_iter().find(|p| p.id == "cameo1").unwrap();
        ed.set_machine(cameo1);
        // A 12×12 in mat is 304.8 mm; the Cameo 1 reaches 295 across.
        let r = ed.set_media(304.8, 304.8).unwrap();
        assert_eq!((r.w, r.h), (295.0, 304.8));
        assert_eq!(ed.set_media(0.0, 10.0), Err(MediaError::NotPositive));
        assert_eq!(ed.set_media(f64::NAN, 10.0), Err(MediaError::NotPositive));
    }

    /// A project saved before job settings existed has no `job` field and must still open.
    #[test]
    fn a_document_without_job_settings_reads_as_the_defaults() {
        let mut v: serde_json::Value = serde_json::from_str(&crate::Document::new().snapshot_json()).unwrap();
        v.as_object_mut().unwrap().remove("job");
        let back: crate::Document = serde_json::from_value(v).unwrap();
        assert_eq!(back.job, JobSettings::default());
        let layer: PassSettings = serde_json::from_str("{}").unwrap();
        assert!(layer.output, "a layer saved with nothing says nothing about output, so it cuts");
    }
}
