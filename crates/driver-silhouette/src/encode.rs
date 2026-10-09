// SPDX-License-Identifier: GPL-3.0-or-later
use crate::Model;
use driver_core::{Driver, DriverError, Expectation, Job, MachineCaps, MachineProfile, Registration, SessionStep, Tool};
use std::cell::Cell;
use std::time::Duration;

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

/// The registration-mark setup inkscape-silhouette sends before a search: orientation, "use
/// registration marks", mark type 2 (the Cameo/Portrait square-and-two-L layout), each L's arm
/// length (400 SU = 20 mm) and its stroke (10 SU), then `TB55,1`, whose meaning nobody has
/// documented. Sent verbatim rather than derived from the template, because these describe what
/// the machine's sensor looks for and the source sends the same values whatever was printed.
/// [src: inkscape-silhouette silhouette/Graphtec.py L1549-1555 (GPL-2.0+)]
/// [src: inkscape-silhouette Commands.md L178-190 (GPL-2.0+)]
const REGMARK_SETUP: [&str; 6] = ["TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1"];

/// How far before the marks the automatic search starts, in mm, so a sheet fed a little off still
/// has its top-left square inside the window. [src: inkscape-silhouette silhouette/Graphtec.py L1558-1563 (GPL-2.0+)]
const REGMARK_SEARCH_MARGIN_MM: f64 = 10.0;

/// "Found": the reply to a successful search. Anything else, or nothing, means the marks were not
/// found. [src: inkscape-silhouette silhouette/Graphtec.py L1574-1576 (GPL-2.0+)]
const REGMARK_FOUND: &[u8] = b"    0\x03";

/// How long the search may take. inkscape-silhouette reads with a 40 000 ms timeout (its comment
/// says 20 s; the argument says 40). [src: inkscape-silhouette silhouette/Graphtec.py L1574 (GPL-2.0+)]
const REGMARK_TIMEOUT: Duration = Duration::from_secs(40);

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

impl SilhouetteDriver {
    /// The opening every session shares: init, and on the Cameo 1 the pre-Cameo-3 setup —
    /// portrait, no corner lift. Job-wide, so it is sent once rather than per Pass; speed, force,
    /// blade offset and track enhancing follow per Pass, the order of the Silhouette Studio
    /// captures recorded in inkscape-silhouette. Resets the feed, since a session starts here.
    /// [src: inkscape-silhouette silhouette/Graphtec.py L1276-1301 (GPL-2.0+)]
    /// [src: inkscape-silhouette Commands.md L410-443 (GPL-2.0+)]
    fn session_setup(&self) -> Vec<u8> {
        self.feed_su.set(0);
        let mut out = vec![0x1b, 0x04]; // ESC EOT init
        if self.model == Model::Cameo1 {
            for cmd in ["FN0", "TB50,0", "FE0,0"] { push(cmd, &mut out); }
        }
        out
    }
}

/// The Cameo 1's cutting area and plot mode, `bottom` and `right` in device units.
/// [src: inkscape-silhouette silhouette/Graphtec.py L1604-1610 (GPL-2.0+)]
fn cameo1_cutting_area(bottom: i64, right: i64) -> Vec<u8> {
    let mut out = Vec::new();
    for cmd in ["\\0,0", &format!("Z{bottom},{right}"), "L0", "FE0,0", "FF0,0,0"] {
        push(cmd, &mut out);
    }
    out
}

fn su(mm: f64) -> i64 { (mm * 20.0).round() as i64 }   // 20 units/mm
fn push(s: &str, out: &mut Vec<u8>) { out.extend_from_slice(s.as_bytes()); out.push(0x03); }

impl Driver for SilhouetteDriver {
    fn profile(&self) -> &MachineProfile { &self.profile }
    fn caps(&self) -> MachineCaps {
        let base = MachineCaps { supports_speed: true, supports_force: true, needs_operator_pass_confirm: false, ..Default::default() };
        match self.model {
            Model::Cameo5Alpha => base,
            // ponytail: track enhancing and pen are offered on the Cameo 1 only, whose commands
            // (`FY0`, `FC0`) are sourced; the Cameo 5 dialect's equivalents carry a tool-holder
            // suffix nobody has captured yet.
            // ponytail: registration is the Cameo 1's alone. The Cameo 5 Alpha searches four
            // L-marks with `TB124` rather than `TB123` [src: inkscape-silhouette
            // silhouette/Graphtec.py L258-261, L1359-1362, L1560-1561 (GPL-2.0+)], and nothing in
            // this repo has checked that against its tool-suffixed dialect; offer it once a
            // capture or a hardware run has.
            Model::Cameo1 => MachineCaps {
                speed_max: CAMEO1_SPEED_MAX,
                supports_track_enhancing: true,
                supports_pen: true,
                supports_registration: true,
                ..base
            },
        }
    }
    fn session_begin(&self) -> Vec<u8> {
        let mut out = self.session_setup();
        if self.model == Model::Cameo1 {
            let bottom = su(self.profile.height_mm + CAMEO1_MARGIN_TOP_MM);
            let right = su(self.profile.width_mm + CAMEO1_MARGIN_LEFT_MM);
            out.extend(cameo1_cutting_area(bottom, right));
        }
        out
    }
    /// With registration, the Cameo 1's opening is split around the search: setup, the mark
    /// description and `TB123`, then a wait for "found", and only then the cutting area — which
    /// is the marks' own rectangle, since after a search the machine's origin is the top-left
    /// mark. [src: inkscape-silhouette silhouette/Graphtec.py L1535-1576, L1604-1610 (GPL-2.0+)]
    ///
    /// ponytail: automatic search (`TB123`) only. The manual variant (`TB23,h,w`, L1564-1566)
    /// needs the operator to jog the head over the first mark, which neither shell can do.
    fn session_open(&self, first: &Job) -> Vec<SessionStep> {
        let (Model::Cameo1, Some(reg)) = (self.model, first.registration) else {
            return vec![SessionStep::Send(self.session_begin())];
        };
        let mut search = self.session_setup();
        for cmd in REGMARK_SETUP { push(cmd, &mut search); }
        // `TB123,<length>,<width>,<top>,<left>`: the mark-to-mark distances, then where to start
        // looking. [src: inkscape-silhouette silhouette/Graphtec.py L1355-1357, L1563 (GPL-2.0+)]
        push(&format!("TB123,{},{},{},{}",
            su(reg.length_mm), su(reg.width_mm),
            su((reg.origin_y_mm - REGMARK_SEARCH_MARGIN_MM).max(0.0)),
            su((reg.origin_x_mm - REGMARK_SEARCH_MARGIN_MM).max(0.0))), &mut search);
        vec![
            SessionStep::Send(search),
            SessionStep::Expect(Expectation {
                reply: REGMARK_FOUND.to_vec(),
                timeout: REGMARK_TIMEOUT,
                refusal: "the cutter could not find the registration marks — check they are printed \
                          dark and sharp, the sheet is loaded square, and the top-left square is \
                          uncovered".into(),
            }),
            // The cutting area shrinks to the marks', as the source's `height = reglength`,
            // `width = regwidth` do. [src: inkscape-silhouette silhouette/Graphtec.py L1545-1547 (GPL-2.0+)]
            SessionStep::Send(cameo1_cutting_area(su(reg.length_mm), su(reg.width_mm))),
        ]
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
                // Preflight refuses a speed past `caps().speed_max`; the clamp is the last line of
                // defence for a caller that skipped it, so the wire never carries a speed the
                // machine does not have.
                if let Some(sp) = pass.settings.speed { push(&format!("!{}", sp.clamp(1, CAMEO1_SPEED_MAX)), &mut out); }
                if let Some(fo) = pass.settings.force { push(&format!("FX{fo}"), &mut out); }
                // A pen's tip sits on the holder's centre, so it gets no blade offset.
                // [src: inkscape-silhouette silhouette/Graphtec.py L1255-1259 (GPL-2.0+)]
                let offset = match pass.settings.tool { Tool::Blade => CAMEO1_BLADE_OFFSET_SU, Tool::Pen => 0 };
                push(&format!("FC{offset}"), &mut out);
                // `FY0` rolls the media three times before cutting; the machine skips it below
                // force 19. [src: inkscape-silhouette silhouette/Graphtec.py L1276-1285, L1073-1074 (GPL-2.0+)]
                push(if pass.settings.track_enhancing { "FY0" } else { "FY1" }, &mut out);
                (su(CAMEO1_MARGIN_LEFT_MM), su(CAMEO1_MARGIN_TOP_MM))
            }
        };
        // After a search the machine's origin is the top-left mark, so geometry is cut from the
        // marks' origin rather than the sheet's; the hardware margins still apply on top, as the
        // source adds them after subtracting the mark origin.
        // [src: inkscape-silhouette silhouette/Graphtec.py L1535-1543, L1612-1614, L1433-1438 (GPL-2.0+)]
        let (ox, oy) = match pass.registration {
            Some(Registration { origin_x_mm, origin_y_mm, .. }) if self.model == Model::Cameo1 => (origin_x_mm, origin_y_mm),
            Some(_) => return Err(DriverError::Encode("this Silhouette cannot cut against registration marks".into())),
            None => (0.0, 0.0),
        };
        let mut feed = self.feed_su.get();
        for _ in 0..pass.settings.repeat_count.max(1) {
            for poly in &pass.polylines {
                // Both drivers skip a path that cannot draw: a lone point would be a bare move
                // that still pushed the end-of-job feed. [src: Graphtec.py L1443 (GPL-2.0+)]
                if poly.len() < 2 { continue; }
                let f = poly[0];                            // note (y,x) order
                push(&format!("M{},{}", su(f.y - oy) + dy, su(f.x - ox) + dx), &mut out);
                for p in &poly[1..] { push(&format!("D{},{}", su(p.y - oy) + dy, su(p.x - ox) + dx), &mut out); }
                feed = poly.iter().map(|p| su(p.y - oy) + dy).fold(feed, i64::max);
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
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: None };
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
            settings: Settings { speed: Some(10), force: Some(20), repeat_count: 1, ..Default::default() }, registration: None };
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(s.contains("!10,1\u{3}") && s.contains("FX20,1\u{3}"));
    }

    #[test]
    fn session_framing_has_one_prologue_and_one_epilogue_across_two_passes() {
        let d = SilhouetteDriver::new();
        let job = |force| Job { polylines: vec![vec![Point{x:0.0,y:0.0}, Point{x:10.0,y:0.0}]],
                                settings: Settings { speed: Some(5), force: Some(force), repeat_count: 1, ..Default::default() }, registration: None };
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
                        settings: Settings { speed: Some(8), force: Some(12), repeat_count: 2, ..Default::default() }, registration: None };
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
        assert_eq!(d.caps(), MachineCaps { supports_speed: true, supports_force: true, needs_operator_pass_confirm: false, ..Default::default() });
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
            settings: Settings { speed: Some(5), force: Some(10), repeat_count: 1, ..Default::default() }, registration: None };
        let mut bytes = d.session_begin();
        bytes.extend(d.encode_pass(&job).unwrap());
        bytes.extend(d.session_end());
        let mut want = vec![0x1b, 0x04];
        // 295 mm + 9 = 304 mm = 6080 SU wide, 2999 mm + 1 = 3000 mm = 60000 SU long.
        want.extend(gpgl(&["FN0", "TB50,0", "FE0,0", "\\0,0", "Z60000,6080", "L0", "FE0,0", "FF0,0,0",
            "!5", "FX10", "FC18", "FY1",
            // (y,x) with y +20 SU (1 mm) and x +180 SU (9 mm)
            "M20,180", "D20,580", "D420,580", "D420,180", "D20,180",
            "M420,0", "SO0"]));
        assert_eq!(String::from_utf8_lossy(&bytes), String::from_utf8_lossy(&want));
    }

    #[test]
    fn cameo1_has_one_tool_so_no_j_and_no_tool_suffix() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()],
            settings: Settings { speed: Some(3), force: Some(20), repeat_count: 1, ..Default::default() }, registration: None };
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
            settings: Settings { speed: Some(30), force: None, repeat_count: 1, ..Default::default() }, registration: None };
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(s.starts_with("!10\u{3}"), "{s:?}");
        assert!(!s.contains("FX"), "an unset force is left to the machine: {s:?}");
    }

    /// The bug the running maximum guards: a later, shorter pass would otherwise set the new
    /// origin above an earlier pass's cuts, and the next job would cut over them.
    #[test]
    fn cameo1_feeds_past_the_furthest_pass_not_the_last() {
        let d = SilhouetteDriver::cameo1();
        let line = |y: f64| Job { polylines: vec![vec![Point{x:0.0,y}, Point{x:10.0,y}]], settings: Settings::default(), registration: None };
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
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: None };
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
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: None };
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
            settings: Settings { speed: None, force: None, repeat_count: 2, ..Default::default() },
            registration: None,
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

    #[test]
    fn cameo1_pen_drops_the_blade_offset_and_track_enhancing_is_per_pass() {
        let d = SilhouetteDriver::cameo1();
        let pen = Job { polylines: vec![square()],
            settings: Settings { tool: Tool::Pen, track_enhancing: true, ..Settings::default() }, registration: None };
        let s = String::from_utf8_lossy(&d.encode_pass(&pen).unwrap()).to_string();
        assert!(s.starts_with("FC0\u{3}FY0\u{3}"), "{s:?}");
        let blade = Job { polylines: vec![square()], settings: Settings::default(), registration: None };
        let s = String::from_utf8_lossy(&d.encode_pass(&blade).unwrap()).to_string();
        assert!(s.starts_with("FC18\u{3}FY1\u{3}"), "{s:?}");
    }

    #[test]
    fn caps_say_what_each_model_can_be_asked() {
        let c1 = SilhouetteDriver::cameo1().caps();
        assert_eq!((c1.speed_max, c1.supports_track_enhancing, c1.supports_pen), (10, true, true));
        let c5 = SilhouetteDriver::new().caps();
        assert_eq!((c5.speed_max, c5.supports_track_enhancing, c5.supports_pen), (30, false, false));
    }

    fn letter_marks() -> Registration {
        // The template's Letter defaults: 10 mm in from each edge, mark to mark 195.9 x 259.4 mm.
        Registration { origin_x_mm: 10.0, origin_y_mm: 10.0, width_mm: 195.9, length_mm: 259.4 }
    }

    fn steps_bytes(steps: &[SessionStep]) -> Vec<String> {
        steps.iter().map(|s| match s {
            SessionStep::Send(b) => String::from_utf8_lossy(b).to_string(),
            SessionStep::Expect(e) => format!("<expect {:?} within {}s>", String::from_utf8_lossy(&e.reply), e.timeout.as_secs()),
        }).collect()
    }

    /// The whole registered opening, pinned against inkscape-silhouette's: setup, the mark
    /// description, an automatic search starting 10 mm before the marks, a wait for `    0`, then
    /// a cutting area the size of the marks' rectangle.
    #[test]
    fn cameo1_registration_opening_is_the_documented_search() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: Some(letter_marks()) };
        let steps = d.session_open(&job);
        let mut search = vec![0x1b, 0x04];
        // 259.4 mm = 5188 SU, 195.9 mm = 3918 SU; the search starts at 0 mm (10 - 10) both ways.
        search.extend(gpgl(&["FN0", "TB50,0", "FE0,0",
            "TB50,0", "TB99", "TB52,2", "TB51,400", "TB53,10", "TB55,1", "TB123,5188,3918,0,0"]));
        let area = gpgl(&["\\0,0", "Z5188,3918", "L0", "FE0,0", "FF0,0,0"]);
        assert_eq!(steps_bytes(&steps), vec![
            String::from_utf8_lossy(&search).to_string(),
            "<expect \"    0\\u{3}\" within 40s>".to_string(),
            String::from_utf8_lossy(&area).to_string(),
        ]);
    }

    #[test]
    fn the_search_window_starts_ten_mm_before_marks_set_further_in() {
        let d = SilhouetteDriver::cameo1();
        let reg = Registration { origin_x_mm: 25.0, origin_y_mm: 30.0, width_mm: 100.0, length_mm: 150.0 };
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: Some(reg) };
        let SessionStep::Send(search) = &d.session_open(&job)[0] else { panic!("search is sent first") };
        assert!(String::from_utf8_lossy(search).ends_with("TB123,3000,2000,400,300\u{3}"), "{:?}", String::from_utf8_lossy(search));
    }

    /// After the search the mark is the origin: a point at the mark's corner is cut at the
    /// hardware margins (9 mm, 1 mm), and the end-of-job feed is measured in the same frame.
    #[test]
    fn cameo1_cuts_registered_geometry_from_the_mark_origin() {
        let d = SilhouetteDriver::cameo1();
        let at = |x: f64, y: f64| Point { x, y };
        let job = Job {
            polylines: vec![vec![at(10.0, 10.0), at(30.0, 10.0), at(30.0, 40.0)]],
            settings: Settings::default(),
            registration: Some(letter_marks()),
        };
        let _ = d.session_open(&job);
        let s = String::from_utf8_lossy(&d.encode_pass(&job).unwrap()).to_string();
        assert!(s.ends_with(&String::from_utf8_lossy(&gpgl(&["M20,180", "D20,580", "D620,580"])).to_string()), "{s:?}");
        assert_eq!(d.session_end(), gpgl(&["M620,0", "SO0"]));
    }

    #[test]
    fn an_unregistered_cameo1_opening_is_unchanged() {
        let d = SilhouetteDriver::cameo1();
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: None };
        assert_eq!(d.session_open(&job), vec![SessionStep::Send(d.session_begin())]);
    }

    /// The Cameo 5's search is unsourced for its dialect, so it neither offers registration nor
    /// encodes a registered Job as if it were not one.
    #[test]
    fn the_cameo5_refuses_a_registered_job() {
        let d = SilhouetteDriver::new();
        assert!(!d.caps().supports_registration);
        assert!(SilhouetteDriver::cameo1().caps().supports_registration);
        let job = Job { polylines: vec![square()], settings: Settings::default(), registration: Some(letter_marks()) };
        assert!(matches!(d.encode_pass(&job), Err(DriverError::Encode(_))));
        assert_eq!(d.session_open(&job), vec![SessionStep::Send(d.session_begin())]);
    }
}
