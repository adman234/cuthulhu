// SPDX-License-Identifier: GPL-3.0-or-later
use cli::pipeline::{driver_for, dry_run_pass_bytes, plan_cut_from_svg};
use driver_core::Settings;

/// A dry run must refuse what a real cut would refuse. Through `build_bytes` it did
/// not: off-bed geometry printed bytes, so `--dry-run` reported a cut that
/// a grouped cut and the desktop would both have rejected.
#[test]
fn plain_dry_run_refuses_geometry_off_the_bed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let svg = dir.path().join("off-bed.svg");
    std::fs::write(&svg, br##"<svg xmlns="http://www.w3.org/2000/svg" width="10000mm" height="10mm">
        <rect x="9000" width="500" height="5" fill="#000000"/></svg>"##).expect("write");

    let out = std::process::Command::new(env!("CARGO_BIN_EXE_cuthulhu"))
        .args(["cut", svg.to_str().unwrap(), "--device", "cameo5", "--dry-run"])
        .output()
        .expect("run");

    assert!(!out.status.success(), "off-bed dry run must fail");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("outside"), "expected a bounds refusal, got: {err}");
}

#[test]
fn multi_pass_dry_run_parks_between_passes_like_the_device_manager() {
    // Two stroke colors → two passes. The dry-run stream must mirror
    // DeviceManager framing: session_begin, pass, pass_park, pass, session_end.
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0 L20 0" stroke="#ff0000"/>
        <path d="M0 10 L20 10" stroke="#00ff00"/>
    </svg>"##;
    // Planned through the one entry point every mode uses since #148, preflight included.
    let puma = driver_for("puma").expect("registry id");
    let plan = plan_cut_from_svg(svg, puma.as_ref(), &Settings::default(), cutplan::Grouping::Color, &[], &[], false).unwrap();
    let passes = &plan.passes;
    assert_eq!(passes.len(), 2);

    let streams: Vec<String> = passes
        .iter()
        .enumerate()
        .map(|(i, pass)| {
            String::from_utf8(dry_run_pass_bytes(puma.as_ref(), &pass.job, i, passes.len()).unwrap()).unwrap()
        })
        .collect();

    // HPGL: session_begin = "IN;", pass_park and session_end are both "PU;".
    assert!(streams[0].starts_with("IN;"), "{}", streams[0]);
    assert!(streams[0].ends_with("PU;"), "pass 0 must park: {}", streams[0]);
    assert!(!streams[1].starts_with("IN;"), "session_begin only once: {}", streams[1]);
    assert!(streams[1].ends_with("PU;"), "last pass must close the session: {}", streams[1]);

    // Silhouette distinguishes park (empty) from session_end (SO0/FN0), so it can
    // catch a stream that wrongly closes the session between passes.
    let cameo = driver_for("cameo5").expect("registry id");
    let contains = |bytes: &[u8], needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
    let c0 = dry_run_pass_bytes(cameo.as_ref(), &passes[0].job, 0, passes.len()).unwrap();
    let c1 = dry_run_pass_bytes(cameo.as_ref(), &passes[1].job, 1, passes.len()).unwrap();
    assert!(!contains(&c0, b"FN0"), "pass 0 must not close the session");
    assert!(contains(&c1, b"FN0"), "last pass must close the session");
}

/// The Cameo 1 end to end through the CLI: preflight against its 295 mm reachable width, then
/// the margin-shifted stream with one setup and one feed past the furthest pass.
#[test]
fn cameo1_dry_run_refuses_past_its_reach_and_feeds_past_every_pass() {
    let dir = tempfile::tempdir().expect("tempdir");
    let wide = dir.path().join("wide.svg");
    // 300 mm fits a Cameo 5 (330 mm) but not the Cameo 1's 295 mm reach.
    std::fs::write(&wide, br##"<svg xmlns="http://www.w3.org/2000/svg" width="310mm" height="10mm" viewBox="0 0 310 10">
        <path d="M0 0 L300 0" stroke="#000000" fill="none"/></svg>"##).expect("write");
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_cuthulhu"))
        .args(["cut", wide.to_str().unwrap(), "--device", "cameo1", "--dry-run"])
        .output()
        .expect("run");
    assert!(!out.status.success(), "a cut past the Cameo 1's reach must be refused");

    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
        <path d="M0 50 L20 50" stroke="#ff0000" fill="none"/>
        <path d="M0 10 L20 10" stroke="#00ff00" fill="none"/>
    </svg>"##;
    let cameo1 = driver_for("cameo1").expect("registry id");
    let plan = plan_cut_from_svg(svg, cameo1.as_ref(), &Settings::default(), cutplan::Grouping::Color, &[], &[], false).unwrap();
    let passes = &plan.passes;
    assert_eq!(passes.len(), 2);
    let mut stream = Vec::new();
    for (i, pass) in passes.iter().enumerate() {
        stream.extend(dry_run_pass_bytes(cameo1.as_ref(), &pass.job, i, passes.len()).unwrap());
    }
    let s = String::from_utf8_lossy(&stream).to_string();
    assert_eq!(s.matches("TB50,0").count(), 1, "setup once: {s:?}");
    assert!(s.contains("M1020,180\u{3}"), "the red line, shifted by the margins: {s:?}");
    // The later green pass ends at y=10, but the feed must clear the red one at y=50.
    assert!(s.ends_with("M1020,0\u{3}SO0\u{3}"), "{s:?}");
    assert!(!s.contains('J'), "no tool select on a one-tool machine: {s:?}");
}

