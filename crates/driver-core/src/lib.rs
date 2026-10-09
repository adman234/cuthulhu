// SPDX-License-Identifier: GPL-3.0-or-later
use geometry::Polyline;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

pub mod manager;
pub mod status;
pub use status::{Actions, ByteProgress, CutStatus, Ended, PassPosition, Phase};

/// `registration` is the frame the polylines are cut in: `None` is the machine's own origin, and
/// `Some` is printed registration marks the machine must find first. It rides on every Job of a
/// cut rather than on the session because a Job is what a Driver encodes — the offset applies to
/// each Pass's coordinates — and `DeviceManager` refuses a cut whose Jobs disagree about it.
/// Skipped when absent, so a Job that does not register serializes exactly as it did before the
/// field existed: a Cut Host's dedupe digest and an older host's parser both see the same bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub polylines: Vec<Polyline>,
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration: Option<Registration>,
}

impl Job {
    /// A Job cut from the machine's own origin, which is every Job that is not print & cut.
    pub fn new(polylines: Vec<Polyline>, settings: Settings) -> Job {
        Job { polylines, settings, registration: None }
    }
}

/// Where printed registration marks sit on the sheet, in millimetres from the Document's origin
/// (the sheet's top-left corner): `origin` is the top-left square's top-left corner, and `width`
/// and `length` are the distances from it to the corners of the top-right and bottom-left L's —
/// the mark-to-mark distances the machine searches over.
/// Once the machine has found them, the mark origin is the origin the Job's geometry is cut from.
/// [src: inkscape-silhouette sendto_silhouette.py L852-855 (GPL-2.0+)]
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub origin_x_mm: f64,
    pub origin_y_mm: f64,
    pub width_mm: f64,
    pub length_mm: f64,
}

/// What is in the tool holder for a Pass. A pen draws where a blade cuts, and the two need
/// different corner handling: a blade's tip trails the holder's centre and is compensated for,
/// a pen's does not.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tool { #[default] Blade, Pen }

/// `track_enhancing` and `tool` default on deserialize, so a Settings written before they
/// existed — a Cut Host on an older build, a saved preset — reads as the blade it always meant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub speed: Option<u32>,
    pub force: Option<u32>,
    pub repeat_count: u32,
    /// Roll the media back and forth before cutting so the rollers grip a track into it.
    #[serde(default)]
    pub track_enhancing: bool,
    #[serde(default)]
    pub tool: Tool,
}
impl Default for Settings {
    fn default() -> Self { Settings { speed: None, force: None, repeat_count: 1, track_enhancing: false, tool: Tool::Blade } }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineProfile { pub id: String, pub name: String, pub width_mm: f64, pub height_mm: f64 }

/// What a machine can be asked to do. Read by preflight (whether a value is judged, and against
/// what ceiling) and by the UI (whether a control is offered).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineCaps {
    pub supports_speed: bool,
    pub supports_force: bool,
    pub needs_operator_pass_confirm: bool,
    /// The fastest speed this machine has. Narrower than the shared range on older machines —
    /// the Cameo 1 tops out at 10 where later Cameos reach 30 — so preflight refuses what the
    /// machine cannot do instead of the driver quietly clamping it.
    #[serde(default = "default_speed_max")]
    pub speed_max: u32,
    #[serde(default)]
    pub supports_track_enhancing: bool,
    #[serde(default)]
    pub supports_pen: bool,
    /// Whether the machine can find printed registration marks before cutting (print & cut).
    /// Defaulted false so a Cut Host on an older build, which never heard of it, reads as a
    /// machine that cannot — the refusal is the safe direction.
    #[serde(default)]
    pub supports_registration: bool,
}

fn default_speed_max() -> u32 { 30 }

/// The capabilities a machine has unless its Driver says otherwise: the shared speed ceiling, and
/// none of the optional tool controls. The three original fields have no sensible default, so a
/// literal still names them; this exists for the fields added after them.
impl Default for MachineCaps {
    fn default() -> Self {
        MachineCaps {
            supports_speed: false,
            supports_force: false,
            needs_operator_pass_confirm: false,
            speed_max: default_speed_max(),
            supports_track_enhancing: false,
            supports_pen: false,
            supports_registration: false,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum DriverError { UnsupportedGeometry, Encode(String) }
#[derive(Debug, PartialEq)]
pub enum TransportError { NotFound, Disconnected, Timeout, WriteZero, Io(String) }

/// One step of opening a cutting session.
#[derive(Clone, Debug, PartialEq)]
pub enum SessionStep {
    Send(Vec<u8>),
    /// Wait for the machine to answer what the steps before this one sent, and fail the cut
    /// unless the answer is `Expectation::reply`.
    Expect(Expectation),
}

/// An answer a session cannot go on without — a machine reporting it has found the registration
/// marks, say. `refusal` is the sentence an operator reads when the answer is something else or
/// never comes, so it names what failed rather than how the bytes differed.
#[derive(Clone, Debug, PartialEq)]
pub struct Expectation {
    pub reply: Vec<u8>,
    pub timeout: Duration,
    pub refusal: String,
}

pub trait Driver {
    fn profile(&self) -> &MachineProfile;
    fn caps(&self) -> MachineCaps;
    fn session_begin(&self) -> Vec<u8>;
    /// The session's opening for a cut whose first Pass is `first`. Most sessions only send
    /// `session_begin`; one that must ask the machine something before it may cut — whether it
    /// has found the registration marks — splits its opening around an `Expect`. The default
    /// exists so a Driver with nothing to ask need not know this method exists.
    fn session_open(&self, first: &Job) -> Vec<SessionStep> {
        let _ = first;
        vec![SessionStep::Send(self.session_begin())]
    }
    fn encode_pass(&self, pass: &Job) -> Result<Vec<u8>, DriverError>;
    fn pass_park(&self) -> Vec<u8>;
    /// Bytes that query device status for completion polling; the device replies
    /// with a single status char (`0` ready / `1` moving / `2` unloaded) plus a
    /// terminator. Default is a bare ENQ; drivers whose dialect frames it
    /// differently (e.g. Silhouette's ESC-prefixed `1b 05`) override this.
    fn status_query(&self) -> Vec<u8> {
        vec![0x05]
    }
    fn session_end(&self) -> Vec<u8>;
    fn abort_bytes(&self) -> Option<Vec<u8>>;
}
pub trait Transport: Send {
    fn write(&mut self, bytes: &[u8]) -> Result<usize, TransportError>;
    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize, TransportError>;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TransportKind {
    Usb { locator: String }, // "bus:address"
    Serial { path: String, baud: u32 },
}
/// Which Cut Host a device is attached to. Opaque, and minted at pairing rather than derived
/// from the host's address, its display name, or its certificate — all three change in ordinary
/// use (a static lease, a rename, a regenerated certificate), and an id built on any of them
/// would make every saved cutter reference point at nothing the first time one did.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HostId(pub String);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub instance_id: String,
    pub machine_id: String,
    pub transport: TransportKind,
    pub candidate: bool,
    /// The Cut Host this device is attached to, or `None` for one plugged into this computer.
    /// Local is the absence of a host, not a mode.
    pub host: Option<HostId>,
}

pub trait DeviceBackendFactory: Send + Sync {
    fn list_devices(&self) -> Vec<DeviceInfo>;
    fn driver_for(&self, machine_id: &str) -> Option<Box<dyn Driver + Send>>;
    fn open_transport(&self, info: &DeviceInfo) -> Result<Box<dyn Transport>, TransportError>;
}

pub fn write_all(t: &mut dyn Transport, mut bytes: &[u8]) -> Result<(), TransportError> {
    while !bytes.is_empty() {
        match t.write(bytes)? {
            0 => return Err(TransportError::WriteZero),
            n => bytes = &bytes[n..],
        }
    }
    Ok(())
}

/// The bytes that open Pass `index`: the session prologue on the first Pass, then
/// the encoded Pass itself.
///
/// `DeviceManager` writes these, waits for the machine (polling `status_query` in
/// between), then writes `close_pass`. The two together are this Pass's own bytes, so a
/// caller that wants the whole Pass at once — `cuthulhu cut --dry-run` — concatenates
/// them rather than restating when a prologue is owed.
pub fn open_pass(d: &dyn Driver, job: &Job, index: usize) -> Result<Vec<u8>, DriverError> {
    let mut bytes = Vec::new();
    for step in open_pass_steps(d, job, index)? {
        if let SessionStep::Send(b) = step { bytes.extend(b); }
    }
    Ok(bytes)
}

/// `open_pass` with any answer the session waits for left in place, which is what
/// `DeviceManager` runs. `open_pass` is these steps' bytes with the waits dropped, so a dry run
/// shows every byte the machine is sent and nothing it is not.
///
/// The Pass's bytes join the opening's last `Send` rather than following it as a step of their
/// own, so a session with nothing to ask is written in exactly the chunks it always was.
pub fn open_pass_steps(d: &dyn Driver, job: &Job, index: usize) -> Result<Vec<SessionStep>, DriverError> {
    let mut steps = if index == 0 { d.session_open(job) } else { Vec::new() };
    let pass = d.encode_pass(job)?;
    match steps.last_mut() {
        Some(SessionStep::Send(bytes)) => bytes.extend(pass),
        _ => steps.push(SessionStep::Send(pass)),
    }
    Ok(steps)
}

/// The bytes that close Pass `index` of `total`: park between Passes, end the
/// session after the last one.
pub fn close_pass(d: &dyn Driver, index: usize, total: usize) -> Vec<u8> {
    if index + 1 < total { d.pass_park() } else { d.session_end() }
}

#[derive(Default)]
pub struct MockTransport {
    pub written: Vec<u8>,
    pub reads: VecDeque<Result<Vec<u8>, TransportError>>,
    pub write_results: VecDeque<Result<usize, TransportError>>,
}
impl Transport for MockTransport {
    fn write(&mut self, b: &[u8]) -> Result<usize, TransportError> {
        match self.write_results.pop_front() {
            Some(result) => match result {
                Ok(n) => {
                    let clamped = n.min(b.len());
                    self.written.extend_from_slice(&b[..clamped]);
                    Ok(clamped)
                }
                Err(e) => Err(e),
            },
            None => {
                self.written.extend_from_slice(b);
                Ok(b.len())
            }
        }
    }
    fn read(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize, TransportError> {
        match self.reads.pop_front() {
            Some(result) => match result {
                Ok(data) => {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    Ok(n)
                }
                Err(e) => Err(e),
            },
            None => Err(TransportError::Timeout),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// `None` is not a mode — it is the absence of a host, which is what "plugged into this
    /// computer" is. A user who never pairs a Pi has every device in this state and sees no
    /// difference from before.
    #[test]
    fn a_device_with_no_host_is_local() {
        let local = DeviceInfo {
            instance_id: "usb:sn:CAMEO-A".into(),
            machine_id: "cameo5".into(),
            transport: TransportKind::Usb { locator: "sn:CAMEO-A".into() },
            candidate: false,
            host: None,
        };
        assert!(local.host.is_none());
    }

    /// The same cutter reached through two different hosts is two different devices, even though
    /// #100 makes its `instance_id` identical — the id says which machine, the host says which
    /// computer owns it.
    #[test]
    fn the_same_cutter_on_two_hosts_is_two_devices() {
        let on_a = DeviceInfo {
            instance_id: "usb:sn:CAMEO-A".into(),
            machine_id: "cameo5".into(),
            transport: TransportKind::Usb { locator: "sn:CAMEO-A".into() },
            candidate: false,
            host: Some(HostId("host-1".into())),
        };
        let on_b = DeviceInfo { host: Some(HostId("host-2".into())), ..on_a.clone() };
        assert_ne!(on_a, on_b);
        assert_eq!(on_a.instance_id, on_b.instance_id, "the cutter's own id is unchanged");
    }

    #[test]
    fn mock_transport_records_all_bytes() {
        let mut t = MockTransport::default();
        t.write(b"AB").unwrap();
        t.write(b"C").unwrap();
        assert_eq!(t.written, b"ABC");
    }
    #[test]
    fn default_settings_leave_speed_force_unset() {
        let s = Settings::default();
        assert!(s.speed.is_none() && s.force.is_none() && s.repeat_count == 1);
    }
    #[test]
    fn write_all_loops_partial_writes_and_flags_zero() {
        let mut t = MockTransport::default();
        t.write_results.push_back(Ok(2)); // partial: only 2 of 5 accepted
        write_all(&mut t, b"HELLO").unwrap();
        assert_eq!(t.written, b"HELLO");

        let mut z = MockTransport::default();
        z.write_results.push_back(Ok(0));
        assert_eq!(write_all(&mut z, b"X"), Err(TransportError::WriteZero));
    }
    #[test]
    fn mock_read_replays_script_then_times_out() {
        let mut t = MockTransport::default();
        t.reads.push_back(Ok(b"ready".to_vec()));
        let mut buf = [0u8; 8];
        let n = t.read(&mut buf, Duration::from_millis(10)).unwrap();
        assert_eq!(&buf[..n], b"ready");
        assert_eq!(t.read(&mut buf, Duration::from_millis(10)), Err(TransportError::Timeout));
    }
    #[test]
    fn mock_write_clamps_scripted_count_to_buffer_length() {
        let mut t = MockTransport::default();
        t.write_results.push_back(Ok(6)); // script says 6 bytes
        let result = t.write(b"HELLO").unwrap(); // but buffer is only 5
        assert_eq!(result, 5); // should return 5, not 6
        assert_eq!(t.written, b"HELLO"); // and only append 5 bytes
    }

    struct FakeFactory;
    impl DeviceBackendFactory for FakeFactory {
        fn list_devices(&self) -> Vec<DeviceInfo> {
            vec![
                DeviceInfo {
                    instance_id: "usb:1:4".into(),
                    machine_id: "cameo5".into(),
                    transport: TransportKind::Usb { locator: "1:4".into() },
                    candidate: false,
                    host: None,
                },
                DeviceInfo {
                    instance_id: "serial:/dev/ttyUSB0".into(),
                    machine_id: "puma".into(),
                    transport: TransportKind::Serial { path: "/dev/ttyUSB0".into(), baud: 9600 },
                    candidate: true,
                    host: None,
                },
            ]
        }
        fn driver_for(&self, _: &str) -> Option<Box<dyn Driver + Send>> { None }
        fn open_transport(&self, _: &DeviceInfo) -> Result<Box<dyn Transport>, TransportError> {
            Err(TransportError::NotFound)
        }
    }
    #[test]
    fn serial_devices_are_candidates_requiring_user_selection() {
        let f = FakeFactory;
        let serial: Vec<_> = f.list_devices().into_iter()
            .filter(|d| matches!(d.transport, TransportKind::Serial { .. })).collect();
        assert!(serial.iter().all(|d| d.candidate), "serial ports can't be assumed to be Pumas");
    }

    /// Distinguishable constants for the three framing methods, so a test can say
    /// which one landed and in what order. `profile`/`caps` diverge: framing reads
    /// neither, and a test that starts needing them is testing something else.
    struct FramingDriver;
    impl Driver for FramingDriver {
        fn profile(&self) -> &MachineProfile { unreachable!("framing does not read the profile") }
        fn caps(&self) -> MachineCaps { unreachable!("framing does not read the caps") }
        fn session_begin(&self) -> Vec<u8> { b"BEGIN".to_vec() }
        fn encode_pass(&self, pass: &Job) -> Result<Vec<u8>, DriverError> {
            Ok(format!("PASS{}", pass.polylines.len()).into_bytes())
        }
        fn pass_park(&self) -> Vec<u8> { b"PARK".to_vec() }
        fn session_end(&self) -> Vec<u8> { b"END".to_vec() }
        fn abort_bytes(&self) -> Option<Vec<u8>> { None }
    }

    #[test]
    fn only_the_first_pass_carries_the_session_prologue() {
        let job = Job::new(Vec::new(), Settings::default());
        assert_eq!(open_pass(&FramingDriver, &job, 0).unwrap(), b"BEGINPASS0".to_vec());
        assert_eq!(open_pass(&FramingDriver, &job, 1).unwrap(), b"PASS0".to_vec());
    }

    #[test]
    fn a_pass_parks_unless_it_is_the_last_one() {
        assert_eq!(close_pass(&FramingDriver, 0, 2), b"PARK".to_vec(), "another Pass follows, so park");
        assert_eq!(close_pass(&FramingDriver, 1, 2), b"END".to_vec(), "the last Pass closes the session");
        // The boundary a caller gets wrong: a one-Pass job's only Pass is also its last,
        // so it must close rather than park.
        assert_eq!(close_pass(&FramingDriver, 0, 1), b"END".to_vec());
    }

    /// A Driver whose opening waits for an answer: the dry-run bytes are every byte sent, with
    /// the wait dropped, and the Pass joins the opening's last write.
    struct AskingDriver;
    impl Driver for AskingDriver {
        fn profile(&self) -> &MachineProfile { unreachable!() }
        fn caps(&self) -> MachineCaps { unreachable!() }
        fn session_begin(&self) -> Vec<u8> { b"BEGIN".to_vec() }
        fn session_open(&self, _first: &Job) -> Vec<SessionStep> {
            vec![
                SessionStep::Send(b"ASK".to_vec()),
                SessionStep::Expect(Expectation { reply: b"YES".to_vec(), timeout: Duration::from_secs(1), refusal: "no".into() }),
                SessionStep::Send(b"AREA".to_vec()),
            ]
        }
        fn encode_pass(&self, _pass: &Job) -> Result<Vec<u8>, DriverError> { Ok(b"PASS".to_vec()) }
        fn pass_park(&self) -> Vec<u8> { Vec::new() }
        fn session_end(&self) -> Vec<u8> { Vec::new() }
        fn abort_bytes(&self) -> Option<Vec<u8>> { None }
    }

    #[test]
    fn an_opening_that_waits_keeps_its_wait_out_of_the_bytes() {
        let job = Job::new(Vec::new(), Settings::default());
        assert_eq!(open_pass(&AskingDriver, &job, 0).unwrap(), b"ASKAREAPASS".to_vec());
        let steps = open_pass_steps(&AskingDriver, &job, 0).unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[2], SessionStep::Send(b"AREAPASS".to_vec()));
        assert_eq!(open_pass_steps(&AskingDriver, &job, 1).unwrap(), vec![SessionStep::Send(b"PASS".to_vec())]);
        // And the default opening is `session_begin`, in the same write as the Pass.
        assert_eq!(open_pass_steps(&FramingDriver, &job, 0).unwrap(), vec![SessionStep::Send(b"BEGINPASS0".to_vec())]);
    }

    /// A Job that does not register serializes as it did before the field existed, so a Cut
    /// Host's dedupe digest and an older host's parser see the same bytes.
    #[test]
    fn an_unregistered_job_serializes_without_the_field() {
        let job = Job::new(Vec::new(), Settings::default());
        let json = serde_json::to_string(&job).unwrap();
        assert!(!json.contains("registration"), "{json}");
        let back: Job = serde_json::from_str(&json).unwrap();
        assert_eq!(back, job);
        let caps: MachineCaps = serde_json::from_str(r#"{"supportsSpeed":true,"supportsForce":true,"needsOperatorPassConfirm":false}"#).unwrap();
        assert!(!caps.supports_registration, "a host that never heard of registration cannot do it");
    }
}
