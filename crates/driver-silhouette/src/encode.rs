// SPDX-License-Identifier: GPL-3.0-or-later
use crate::Model;
use driver_core::{Driver, DriverError, Job, MachineCaps, MachineProfile};
use std::cell::Cell;

/// Hardware margins of the Cameo 1, in mm: the carriage cannot reach the first 9 mm from the
/// left, and the top millimetre is kept back so a reverse feed cannot run thin media off the
/// rollers. The artboard is the reachable area, so a design at (0,0) is cut at (9,1) on the
/// media. [src: inkscape-silhouette silhouette/Graphtec.py L218-221, L1501-1502, L1436-1438, L1612 (GPL-2.0+)]
const CAMEO1_MARGIN_LEFT_MM: f64 = 9.0;
const CAMEO1_MARGIN_TOP_MM: f64 = 1.0;

/// The Cameo 1's speed ceiling. Later models go to 30, which is what the shared
/// `SETTINGS_RANGES` admits. [src: inkscape-silhouette silhouette/Graphtec.py L1070-1072, L1204-1206 (GPL-2.0+)]
const CAMEO1_SPEED_MAX: u32 = 10;

/// The 0.9 mm blade's offset, in device units — the circle the head turns on a corner so the
/// trailing blade tip meets it. [src: inkscape-silhouette silhouette/Graphtec.py L1244-1259 (GPL-2.0+)]
const CAMEO1_BLADE_OFFSET_SU: i64 = 18;

pub struct SilhouetteDriver {
    profile: MachineProfile,
    model: Model,
    /// How far down the media this session's cutting has reached, in device units, so the
    /// epilogue can feed the media clear of every pass rather than only the last. `Cell`
    /// because the `Driver` trait encodes through `&self`; one session runs on one thread.
    feed_su: Cell<i64>,
}

impl SilhouetteDriver {
    /// The Cameo 5 Alpha, which every caller meant before the Cameo 1 arrived.
    pub fn new() -> Self {
        Self::for_model(Model::Cameo5Alpha)
    }

    pub fn cameo1() -> Self {
        Self::for_model(Model::Cameo1)
    }

    pub fn for_model(model: Model) -> Self {
        let profile = match model {
            Model::Cameo5Alpha => MachineProfile {
                id: "cameo5".into(), name: "Silhouette Cameo 5 Alpha".into(),
                width_mm: 330.0, height_mm: 3000.0 },
            // 304 mm of media width less the unreachable left margin, and 3000 mm of length less
            // the top margin, so the cutting area's far corner (`Z`) is the device's own maximum.
            // [src: inkscape-silhouette silhouette/Graphtec.py L218-221 (GPL-2.0+)]
            Model::Cameo1 => MachineProfile {
                id: "cameo1".into(), name: "Silhouette Cameo".into(),
                width_mm: 304.0 - CAMEO1_MARGIN_LEFT_MM, height_mm: 3000.0 - CAMEO1_MARGIN_TOP_MM },
        };
        SilhouetteDriver { profile, model, feed_su: Cell::new(0) }
    }

    pub fn model(&self) -> Model { self.model }
}

impl Default for SilhouetteDriver {
    fn default() -> Self { Self::new() }
}

fn su(mm: f64) -> i64 { (mm * 20.0).round() as i64 }   // 20 units/mm
fn push(s: &str, out: &mut Vec<u8>) { out.extend_from_slice(s.as_bytes()); out.push(0x03); }

impl Driver for SilhouetteDriver {
    fn profile(&self) -> &MachineProfile { &self.profile }
    fn caps(&self) -> MachineCaps {
        MachineCaps { supports_speed: true, supports_force: true, needs_operator_pass_confirm: false }
    }
    fn session_begin(&self) -> Vec<u8> {
        self.feed_su.set(0);
        let mut out = vec![0x1b, 0x04]; // ESC EOT init
        if self.model == Model::Cameo1 {
            // The pre-Cameo-3 setup: track enhancing off, portrait, no corner lift, then the
            // cutting area and plot mode. Job-wide, so it is sent once rather than per Pass;
            // speed, force and blade offset follow per Pass, the order of the Silhouette Studio
            // captures recorded in inkscape-silhouette.
            // [src: inkscape-silhouette silhouette/Graphtec.py L1276-1301, L1604-1610 (GPL-2.0+)]
            // [src: inkscape-silhouette Commands.md L410-443 (GPL-2.0+)]
            let bottom = su(self.profile.height_mm + CAMEO1_MARGIN_TOP_MM);
            let right = su(self.profile.width_mm + CAMEO1_MARGIN_LEFT_MM);
            for cmd in ["FY1", "FN0", "TB50,0", "FE0,0", "\\0,0", &format!("Z{bottom},{right}"),
                        "L0", "FE0,0", "FF0,0,0"] {
                push(cmd, &mut out);
            }
        }
        out
    }
    fn encode_pass(&self, pass: &Job) -> Result<Vec<u8>, DriverError> {
        let mut out: Vec<u8> = Vec::new();
        let (dx, dy) = match self.model {
            Model::Cameo5Alpha => {
                let tool = 1;
                push(&format!("J{tool}"), &mut out);
                if let Some(sp) = pass.settings.speed { push(&format!("!{sp},{tool}"), &mut out); }
                if let Some(fo) = pass.settings.force { push(&format!("FX{fo},{tool}"), &mut out); }
                (0, 0)
            }
            Model::Cameo1 => {
                // One tool holder, so no `J` and no tool suffix on speed and force.
                // [src: inkscape-silhouette silhouette/Graphtec.py L1203-1220 (GPL-2.0+)]
                // ponytail: speed is clamped here, not refused by preflight, because
                // SETTINGS_RANGES is one range for every machine; a per-machine ceiling carried
                // in MachineCaps is the upgrade path.
                if let Some(sp) = pass.settings.speed { push(&format!("!{}", sp.clamp(1, CAMEO1_SPEED_MAX)), &mut out); }
                if let Some(fo) = pass.settings.force { push(&format!("FX{fo}"), &mut out); }
                push(&format!("FC{CAMEO1_BLADE_OFFSET_SU}"), &mut out);
                (su(CAMEO1_MARGIN_LEFT_MM), su(CAMEO1_MARGIN_TOP_MM))
            }
        };
        let mut feed = self.feed_su.get();
        for _ in 0..pass.settings.repeat_count.max(1) {
            for poly in &pass.polylines {
                // Both drivers skip a path that cannot draw: a lone point would be a bare move
                // that still pushed the end-of-job feed. [src: Graphtec.py L1443 (GPL-2.0+)]
                if poly.len() < 2 { continue; }
                let f = poly[0];                            // note (y,x) order
                push(&format!("M{},{}", su(f.y) + dy, su(f.x) + dx), &mut out);
                for p in &poly[1..] { push(&format!("D{},{}", su(p.y) + dy, su(p.x) + dx), &mut out); }
                feed = poly.iter().map(|p| su(p.y) + dy).fold(feed, i64::max);
            }
        }
        self.feed_su.set(feed);
        Ok(out)
    }
    fn pass_park(&self) -> Vec<u8> {
        // ponytail: no documented safe-park command yet; head stays put between passes — hardware checklist validates
        Vec::new()
    }
    fn status_query(&self) -> Vec<u8> {
        // ESC ENQ, not the bare-ENQ default: the Silhouette dialect frames its
        // status query as 1b 05. [src: Graphtec.py L180 (GPL-2.0+)]
        vec![0x1b, 0x05]
    }
    fn session_end(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.model == Model::Cameo1 {
            // Feed below the furthest cut, then make that the origin, so the next job starts on
            // fresh media. `SO0` alone would set the origin wherever the last path ended.
            // [src: inkscape-silhouette silhouette/Graphtec.py L1646-1649 (GPL-2.0+)]
            push(&format!("M{},0", self.feed_su.get()), &mut out);
            push("SO0", &mut out);
            return out;
        }
        push("SO0", &mut out);
        push("FN0", &mut out);
        out
    }
    fn abort_bytes(&self) -> Option<Vec<u8>> { None } // undocumented
}

#[cfg(test)]
mod tests {
    use super::*;
    use driver_core::{Job, Settings};
    use geometry::Point;

    fn square() -> Vec<Point> {
        [(0.0,0.0),(20.0,0.0),(20.0,20.0),(0.0,20.0),(0.0,0.0)]
            .iter().map(|&(x,y)| Point{x,y}).collect()
    }

    #[test]
    fn status_query_is_esc_enq() {
        // 1b 05 per the protocol doc; a bare 0x05 gets no reply from the device.
        assert_eq!(SilhouetteDriver::new().status_query(), vec![0x1b, 0x05]);
    }

    #[test]
    fn encodes_square_to_documented_gpgl_stream() {
        let d = SilhouetteDriver::new();
        let job = Job { polylines: vec![square()], settings: Settings::default() };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.session_end());
        // ESC EOT · J1 · M0,0 · D0,400 · D400,400 · D400,0 · D0,0 · SO0 · FN0  (20/mm, (y,x))
        let mut want = vec![0x1b, 0x04];
        for cmd in ["J1","M0,0","D0,400","D400,400","D400,0","D0,0","SO0","FN0"] {
            want.extend_from_slice(cmd.as_bytes()); want.push(0x03);
        }
        assert_eq!(bytes, want);
    }

    #[test]
    fn speed_and_force_emitted_only_when_set() {
        let d = SilhouetteDriver::new();
        let job = Job { polylines: vec![square()],
            settings: Settings { speed: Some(10), force: Some(20), repeat_count: 1 } };
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(s.contains("!10,1\u{3}") && s.contains("FX20,1\u{3}"));
    }

    #[test]
    fn session_framing_has_one_prologue_and_one_epilogue_across_two_passes() {
        let d = SilhouetteDriver::new();
        let job = |force| Job { polylines: vec![vec![Point{x:0.0,y:0.0}, Point{x:10.0,y:0.0}]],
                                settings: Settings { speed: Some(5), force: Some(force), repeat_count: 1 } };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job(10)).unwrap());
        bytes.extend(d.pass_park());
        bytes.extend(d.encode_pass(&job(20)).unwrap());
        bytes.extend(d.session_end());
        let count = |needle: &[u8]| bytes.windows(needle.len()).filter(|w| *w == needle).count();
        assert_eq!(count(&[0x1b, 0x04]), 1, "exactly one ESC EOT prologue");
        assert_eq!(count(b"SO0"), 1, "exactly one feed-out epilogue");
        assert_eq!(count(b"FX10,1"), 1);
        assert_eq!(count(b"FX20,1"), 1, "per-pass settings present");
    }

    #[test]
    fn single_pass_session_is_byte_identical_to_sp2_encoding() {
        let d = SilhouetteDriver::new();
        let job = Job { polylines: vec![vec![Point{x:1.0,y:2.0}, Point{x:3.0,y:4.0}]],
                        settings: Settings { speed: Some(8), force: Some(12), repeat_count: 2 } };
        let mut session = d.session_begin();
        session.extend(d.encode_pass(&job).unwrap());
        session.extend(d.session_end());
        // must equal the pre-plan golden bytes for this job (copied from the SP2 encoder,
        // which looped `repeat_count` M/D passes inside a single J/speed/force/SO0/FN0 frame)
        fn sp2_golden_for_job() -> Vec<u8> {
            let mut want = vec![0x1b, 0x04];
            for cmd in ["J1","!8,1","FX12,1","M40,20","D80,60","M40,20","D80,60","SO0","FN0"] {
                want.extend_from_slice(cmd.as_bytes()); want.push(0x03);
            }
            want
        }
        assert_eq!(session, sp2_golden_for_job());
    }

    #[test]
    fn caps_and_abort_bytes_match_the_documented_contract() {
        let d = SilhouetteDriver::new();
        assert_eq!(d.caps(), MachineCaps { supports_speed: true, supports_force: true, needs_operator_pass_confirm: false });
        assert_eq!(d.abort_bytes(), None);
    }

    fn gpgl(cmds: &[&str]) -> Vec<u8> {
        let mut want = Vec::new();
        for cmd in cmds { want.extend_from_slice(cmd.as_bytes()); want.push(0x03); }
        want
    }

    /// The whole Cameo 1 stream for one square, pinned against the sequence inkscape-silhouette
    /// sends a pre-Cameo-3 machine: setup, cutting area, the square shifted by the 9 mm / 1 mm
    /// margins, then a feed below the cut and a new origin.
    #[test]
    fn cameo1_encodes_square_to_documented_gpgl_stream() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()],
            settings: Settings { speed: Some(5), force: Some(10), repeat_count: 1 } };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.session_end());
        let mut want = vec![0x1b, 0x04];
        // 295 mm + 9 = 304 mm = 6080 SU wide, 2999 mm + 1 = 3000 mm = 60000 SU long.
        want.extend(gpgl(&["FY1", "FN0", "TB50,0", "FE0,0", "\\0,0", "Z60000,6080", "L0", "FE0,0", "FF0,0,0",
            "!5", "FX10", "FC18",
            // (y,x) with y +20 SU (1 mm) and x +180 SU (9 mm)
            "M20,180", "D20,580", "D420,580", "D420,180", "D20,180",
            "M420,0", "SO0"]));
        assert_eq!(String::from_utf8_lossy(&bytes), String::from_utf8_lossy(&want));
    }

    #[test]
    fn cameo1_has_one_tool_so_no_j_and_no_tool_suffix() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()],
            settings: Settings { speed: Some(3), force: Some(20), repeat_count: 1 } };
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(!s.contains('J'), "{s:?}");
        assert!(s.contains("!3\u{3}") && s.contains("FX20\u{3}"), "{s:?}");
    }

    /// The Cameo 1 tops out at speed 10; a preset written for a later Cameo must not reach the
    /// wire as a speed the machine does not have.
    #[test]
    fn cameo1_speed_is_clamped_to_its_ceiling() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()],
            settings: Settings { speed: Some(30), force: None, repeat_count: 1 } };
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(s.starts_with("!10\u{3}"), "{s:?}");
        assert!(!s.contains("FX"), "an unset force is left to the machine: {s:?}");
    }

    /// The bug the running maximum guards: a later, shorter pass would otherwise set the new
    /// origin above an earlier pass's cuts, and the next job would cut over them.
    #[test]
    fn cameo1_feeds_past_the_furthest_pass_not_the_last() {
        let d = SilhouetteDriver::cameo1();
        let line = |y: f64| Job { polylines: vec![vec![Point{x:0.0,y}, Point{x:10.0,y}]], settings: Settings::default() };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&line(100.0)).unwrap());
        bytes.extend(d.encode_pass(&line(10.0)).unwrap());
        let end = d.session_end();
        assert_eq!(end, gpgl(&["M2020,0", "SO0"]), "{:?}", String::from_utf8_lossy(&end));

        // A new session starts from zero rather than inheriting the last job's reach.
        let _ = d.session_begin();
        let _ = d.encode_pass(&line(10.0)).unwrap();
        assert_eq!(d.session_end(), gpgl(&["M220,0", "SO0"]));
    }

    #[test]
    fn cameo1_session_setup_is_sent_once_across_two_passes() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()], settings: Settings::default() };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.pass_park());
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.session_end());
        let count = |needle: &[u8]| bytes.windows(needle.len()).filter(|w| *w == needle).count();
        assert_eq!(count(&[0x1b, 0x04]), 1);
        assert_eq!(count(b"TB50,0"), 1);
        assert_eq!(count(b"SO0"), 1);
        assert_eq!(count(b"FC18"), 2, "the blade offset travels with each pass's settings");
    }

    #[test]
    fn cameo1_profile_is_the_reachable_area() {
        let d = SilhouetteDriver::cameo1();
        assert_eq!(d.profile().id, "cameo1");
        assert_eq!(d.profile().width_mm, 295.0);
        assert_eq!(d.profile().height_mm, 2999.0);
        assert_eq!(d.model(), Model::Cameo1);
    }

    /// Adding the Cameo 1 must not move a byte of what the Cameo 5 already sends.
    #[test]
    fn cameo5_stream_is_unchanged_by_the_cameo1_dialect() {
        let d = SilhouetteDriver::new();
        let job = Job { polylines: vec![square()], settings: Settings::default() };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.session_end());
        let mut want = vec![0x1b, 0x04];
        want.extend(gpgl(&["J1","M0,0","D0,400","D400,400","D400,0","D0,0","SO0","FN0"]));
        assert_eq!(bytes, want);
    }

    /// The cutting area's far corner must be the device's own length, 3000 mm, not past it.
    #[test]
    fn cameo1_cutting_area_ends_at_the_device_maximum() {
        let s = String::from_utf8_lossy(&SilhouetteDriver::cameo1().session_begin()).to_string();
        assert!(s.contains("Z60000,6080\u{3}"), "{s:?}");
    }

    #[test]
    fn cameo1_repeats_paths_and_skips_ones_that_cannot_draw() {
        let d = SilhouetteDriver::cameo1();
        let job = Job {
            polylines: vec![vec![Point{x:0.0,y:5.0}], vec![], vec![Point{x:0.0,y:0.0}, Point{x:10.0,y:0.0}]],
            settings: Settings { speed: None, force: None, repeat_count: 2 },
        };
        let _ = d.session_begin();
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert_eq!(s.matches('M').count(), 2, "one move per repeat of the one drawable path: {s:?}");
        assert!(!s.contains("M120,"), "the lone point at y=5 is not moved to: {s:?}");
        assert_eq!(d.session_end(), gpgl(&["M20,0", "SO0"]), "the lone point does not push the feed");
    }

    #[test]
    fn cameo1_session_with_nothing_cut_feeds_nowhere() {
        let d = SilhouetteDriver::cameo1();
        let _ = d.session_begin();
        assert_eq!(d.session_end(), gpgl(&["M0,0", "SO0"]));
    }
}
