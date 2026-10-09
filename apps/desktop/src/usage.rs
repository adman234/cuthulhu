// SPDX-License-Identifier: GPL-3.0-or-later
//! The usage log: one JSON line per cut job, written when the job ends, so a makerspace can see who
//! cut what, on which cutter, with which material, and how it ended.
//!
//! Lives on the desktop, not in `driver-core`: the CLI and the Cut Host have no operator and no
//! document to name, and a Cut Host's jobs are logged here by the desktop that dispatched them.
//!
//! The file is JSON lines rather than one JSON document because a line is appended in one write and
//! never rewritten: a crash mid-write costs at most that line, and two desktops appending to one
//! file on a share interleave whole lines instead of corrupting a document.
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use driver_core::manager::{DeviceEvent, DeviceEventKind};
use driver_core::{CutStatus, Ended, HostId, Phase};
use serde::{Deserialize, Serialize};

use crate::device::IpcError;

/// How a job ended, as far as this desktop could tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Completed,
    Cancelled,
    Failed,
    /// Nothing reported an ending before the desktop stopped watching: a Cut Host job nobody polled
    /// to the end, or a job still running when the app quit. Logged rather than dropped, because a
    /// job that started is the fact a usage log exists to keep.
    Unknown,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Cancelled => "cancelled",
            Outcome::Failed => "failed",
            Outcome::Unknown => "unknown",
        }
    }
}

/// One pass of a logged job, with the settings it was actually cut with — resolved, not as typed,
/// since "speed blank, preset says 5" is a question a log reader should not have to answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsagePass {
    /// The pass's canonical `PassKey` spelling.
    pub key: String,
    pub preset_id: Option<String>,
    /// The preset's name when the job started; an id alone is unreadable once the preset is gone.
    #[serde(default)]
    pub preset_name: Option<String>,
    pub speed: Option<u32>,
    pub force: Option<u32>,
    pub repeat_count: u32,
    /// This pass's share of the job's `cut_length_mm`, so material totals need not guess.
    #[serde(default)]
    pub cut_length_mm: f64,
}

/// What is known about a job when it is handed to a cutter.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageStart {
    pub started: SystemTime,
    pub operator: Option<String>,
    pub machine_id: String,
    pub device_instance_id: String,
    pub host: Option<String>,
    pub document: Option<String>,
    pub passes: Vec<UsagePass>,
    pub cut_length_mm: f64,
}

/// One line of `usage.jsonl`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageEntry {
    /// RFC 3339, UTC: the log is read on other machines, so it carries no local offset to guess.
    pub started_at: String,
    pub ended_at: String,
    pub duration_s: f64,
    pub operator: Option<String>,
    pub machine_id: String,
    pub device_instance_id: String,
    /// The Cut Host's id when the job ran on one; `None` for a cutter on this computer.
    #[serde(default)]
    pub host: Option<String>,
    /// The project's file name when it had been saved or opened; a design never saved has none.
    pub document: Option<String>,
    pub passes: Vec<UsagePass>,
    /// Blade travel while cutting, in millimetres, counting every repeat — the planned polylines'
    /// length times each pass's repeat count. Travel between shapes is not in it.
    pub cut_length_mm: f64,
    pub outcome: Outcome,
    /// What failed, in the cutter's words, when `outcome` is `failed` (or why it is `cancelled`
    /// when the cutter was disconnected mid-job).
    #[serde(default)]
    pub error: Option<String>,
}

impl UsageStart {
    fn finish(&self, ended: SystemTime, outcome: Outcome, error: Option<String>) -> UsageEntry {
        let duration = ended.duration_since(self.started).unwrap_or_default();
        UsageEntry {
            started_at: rfc3339(self.started),
            ended_at: rfc3339(ended),
            // Tenths of a second: the JSON stays readable, and nothing here is timed finer.
            duration_s: (duration.as_secs_f64() * 10.0).round() / 10.0,
            operator: self.operator.clone(),
            machine_id: self.machine_id.clone(),
            device_instance_id: self.device_instance_id.clone(),
            host: self.host.clone(),
            document: self.document.clone(),
            passes: self
                .passes
                .iter()
                .map(|p| UsagePass { cut_length_mm: round_tenth(p.cut_length_mm), ..p.clone() })
                .collect(),
            cut_length_mm: round_tenth(self.cut_length_mm),
            outcome,
            error,
        }
    }
}

fn round_tenth(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Total length of a set of polylines, in their own units.
pub fn polyline_length(polylines: &[geometry::Polyline]) -> f64 {
    polylines
        .iter()
        .flat_map(|p| p.windows(2))
        .map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt())
        .sum()
}

pub fn default_usage_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("cuthulhu").join("usage.jsonl"))
}

/// UTC civil time from a `SystemTime`, without a date crate: the conversion is Howard Hinnant's
/// `civil_from_days`, and nothing else here needs a calendar.
pub fn rfc3339(t: SystemTime) -> String {
    let secs = t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn unwritable(e: impl std::fmt::Display) -> IpcError {
    IpcError::new("usage_log_unwritable", format!("the usage log could not be written ({e})"))
}

/// Append one entry as one line, in one write.
pub fn append(path: &Path, entry: &UsageEntry) -> Result<(), IpcError> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(unwritable)?;
    }
    let mut line = serde_json::to_string(entry).map_err(unwritable)?;
    line.push('\n');
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).map_err(unwritable)?;
    file.write_all(line.as_bytes()).map_err(unwritable)
}

/// Every entry in the file, oldest first. A line that does not parse is skipped rather than
/// refused: one torn line from a crash must not cost the operator the rest of the history.
pub fn read_all(path: &Path) -> Result<Vec<UsageEntry>, IpcError> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(IpcError::new("usage_log_unreadable", format!("the usage log could not be read ({e})")))
        }
    };
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

/// The newest `limit` entries, newest first.
pub fn read_recent(path: &Path, limit: usize) -> Result<Vec<UsageEntry>, IpcError> {
    let mut all = read_all(path)?;
    all.reverse();
    all.truncate(limit);
    Ok(all)
}

/// One CSV field. Quoted when it holds a separator, a quote or a line break; and a text field that
/// a spreadsheet would read as a formula is prefixed with `'`, because an operator name is typed by
/// whoever walks up to the cutter and the export is opened by whoever runs the space.
fn csv_text(s: &str) -> String {
    let guarded = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{s}") } else { s.to_string() };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn opt_num(v: Option<u32>) -> String {
    v.map(|v| v.to_string()).unwrap_or_default()
}

pub const CSV_HEADER: &str = "started_at,ended_at,duration_s,operator,machine_id,device_instance_id,host,document,outcome,cut_length_mm,pass_count,materials,passes,error";

/// The entries as CSV, one row per job. The passes are folded into one column so a spreadsheet
/// keeps one row per job; `materials` is the distinct preset names, the column a makerspace sums
/// by.
pub fn to_csv(entries: &[UsageEntry]) -> String {
    let mut out = String::from(CSV_HEADER);
    out.push('\n');
    for e in entries {
        let mut materials: Vec<&str> = Vec::new();
        for p in &e.passes {
            let m = p.preset_name.as_deref().or(p.preset_id.as_deref()).unwrap_or("(none)");
            if !materials.contains(&m) {
                materials.push(m);
            }
        }
        let passes = e
            .passes
            .iter()
            .map(|p| {
                format!(
                    "{} [{}] speed {} force {} x{}",
                    p.key,
                    p.preset_id.as_deref().unwrap_or("-"),
                    opt_num(p.speed),
                    opt_num(p.force),
                    p.repeat_count
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let row = [
            csv_text(&e.started_at),
            csv_text(&e.ended_at),
            e.duration_s.to_string(),
            csv_text(e.operator.as_deref().unwrap_or("")),
            csv_text(&e.machine_id),
            csv_text(&e.device_instance_id),
            csv_text(e.host.as_deref().unwrap_or("")),
            csv_text(e.document.as_deref().unwrap_or("")),
            e.outcome.as_str().to_string(),
            e.cut_length_mm.to_string(),
            e.passes.len().to_string(),
            csv_text(&materials.join("; ")),
            csv_text(&passes),
            csv_text(e.error.as_deref().unwrap_or("")),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// Write the whole log as CSV to `out`, atomically, so a half-written export is never mistaken for
/// a short history. Returns how many jobs were written.
pub fn export_csv(log: &Path, out: &Path) -> Result<usize, IpcError> {
    let entries = read_all(log)?;
    let csv = to_csv(&entries);
    let export_failed =
        |e: &dyn std::fmt::Display| IpcError::new("usage_export_failed", format!("the CSV could not be written ({e})"));
    let dir = out.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| export_failed(&e))?;
    tmp.as_file_mut().write_all(csv.as_bytes()).map_err(|e| export_failed(&e))?;
    tmp.persist(out).map_err(|e| export_failed(&e.error))?;
    Ok(entries.len())
}

/// A local job between its start and its ending.
struct LocalPending {
    start: UsageStart,
    /// `None` until an event or `cut`'s reply names it. `DeviceManager::cut` replies only once the
    /// job reaches a pause point or its end, and the bridge may hear the end first, so the start
    /// is recorded before the call and whichever learns the id first binds it.
    job_id: Option<u64>,
    /// Only a job id above this can be this job's: ids rise, and this is the newest one known when
    /// the job was recorded, so a late event from an earlier job can never claim it.
    after: u64,
}

/// A Cut Host job between its acceptance and the poll that sees it end.
struct RemotePending {
    start: UsageStart,
    /// The host's job id for this cutter when the dispatch was accepted, or `None` if no poll had
    /// read one yet. The host writes the new id only once its `cut` call returns — at the first
    /// pause or at the end — so until it moves, a free cutter is still showing the *previous*
    /// job's ending, and a dispatch accepted but not yet begun looks exactly like that.
    before: Option<Option<u64>>,
    /// A poll since the dispatch has seen the cutter busy. With no `before` to compare against,
    /// this is what tells a finished job from one not yet started.
    seen_busy: bool,
}

#[derive(Default)]
struct RecorderState {
    local: Vec<LocalPending>,
    newest_local_job: u64,
    remote: HashMap<(HostId, String), RemotePending>,
    /// The job id each remote cutter last reported, from every poll.
    remote_jobs: HashMap<(HostId, String), Option<u64>>,
}

/// Pairs each job's start with its ending and appends the result to the log.
///
/// State lives here, in the device layer, so the event bridge in `main.rs` stays a forwarder: it
/// hands each event to `observe` and keeps nothing itself.
pub struct Recorder {
    log: Option<PathBuf>,
    state: Mutex<RecorderState>,
    /// Held across "record the start, then hand the job to the worker", so there is never more than
    /// one local start waiting to learn its job id — which is what lets an event bind it by order.
    local_gate: Mutex<()>,
}

impl Recorder {
    /// `None` logs nothing: what a test's device handle uses, so no test writes to the operator's
    /// real configuration directory.
    pub fn new(log: Option<PathBuf>) -> Self {
        Recorder { log, state: Mutex::new(RecorderState::default()), local_gate: Mutex::new(()) }
    }

    pub fn log_path(&self) -> Option<&Path> {
        self.log.as_deref()
    }

    fn write(&self, entry: UsageEntry) {
        let Some(path) = &self.log else { return };
        // A log that cannot be written must not fail or stall the cut it describes; it is said
        // where a developer or a terminal launch will see it.
        if let Err(e) = append(path, &entry) {
            eprintln!("cuthulhu: {}", e.message);
        }
    }

    /// Run a local `DeviceManager::cut` with its start recorded. `cut` is the worker call; its
    /// result decides nothing about the log on success, since the events say how the job ended.
    pub fn local_cut<E>(&self, start: Option<UsageStart>, cut: impl FnOnce() -> Result<u64, E>) -> Result<u64, E> {
        let Some(start) = start else { return cut() };
        let _gate = self.local_gate.lock().unwrap();
        {
            let mut st = self.state.lock().unwrap();
            // Any start still unbound here belongs to an earlier call that was refused before a job
            // existed (a busy worker): under the gate nothing else could have left one.
            st.local.retain(|p| p.job_id.is_some());
            let after = st.newest_local_job;
            st.local.push(LocalPending { start, job_id: None, after });
        }
        let result = cut();
        if let Ok(job_id) = &result {
            let mut st = self.state.lock().unwrap();
            st.newest_local_job = st.newest_local_job.max(*job_id);
            if !st.local.iter().any(|p| p.job_id == Some(*job_id)) {
                // Not yet bound by an event (or already finished and written, in which case no
                // unbound start remains and this finds nothing).
                if let Some(p) = st.local.iter_mut().find(|p| p.job_id.is_none()) {
                    p.job_id = Some(*job_id);
                }
            }
        }
        // A refusal leaves the start unbound: a job that failed in its first pass still sends a
        // `Failed` event, which binds and writes it; one that never started sends nothing, and the
        // next cut drops it.
        result
    }

    /// Hand every device event here, in order. Finishes the job the event ends, if it ends one.
    pub fn observe(&self, event: &DeviceEvent) {
        let now = SystemTime::now();
        let mut finished = Vec::new();
        {
            let mut st = self.state.lock().unwrap();
            let id = event.job_id;
            if id != 0 {
                if !st.local.iter().any(|p| p.job_id == Some(id)) {
                    if let Some(p) = st.local.iter_mut().find(|p| p.job_id.is_none() && id > p.after) {
                        p.job_id = Some(id);
                    }
                }
                st.newest_local_job = st.newest_local_job.max(id);
            }
            let ending = match &event.kind {
                DeviceEventKind::JobComplete => Some((Outcome::Completed, None)),
                DeviceEventKind::Failed(e) => Some((Outcome::Failed, Some(e.to_string()))),
                DeviceEventKind::StateChanged if event.status.ended == Some(Ended::Cancelled) => {
                    Some((Outcome::Cancelled, None))
                }
                _ => None,
            };
            if let (Some((outcome, error)), true) = (ending, id != 0) {
                if let Some(i) = st.local.iter().position(|p| p.job_id == Some(id)) {
                    let p = st.local.remove(i);
                    finished.push(p.start.finish(now, outcome, error));
                }
            }
            // A disconnect drops a parked job without an ending of its own: the worker discards it
            // and says only that the cutter is gone.
            if event.status.phase == Phase::Disconnected {
                let (gone, kept): (Vec<_>, Vec<_>) = st.local.drain(..).partition(|p| p.job_id.is_some());
                st.local = kept;
                finished.extend(gone.into_iter().map(|p| {
                    p.start.finish(
                        now,
                        Outcome::Cancelled,
                        Some("the cutter was disconnected before the job finished".into()),
                    )
                }));
            }
        }
        for entry in finished {
            self.write(entry);
        }
    }

    /// A Cut Host accepted a job. `new_job` is false when the host answered that it already had
    /// this dispatch: the job is then the one already open for that cutter, if any, and is recorded
    /// only when none is — the case of a first dispatch whose answer was lost. A new job replaces
    /// an open one nobody saw end, which is written as `unknown` rather than overwritten.
    pub fn remote_started(&self, host: HostId, device: String, start: UsageStart, new_job: bool) {
        let earlier = {
            let mut st = self.state.lock().unwrap();
            let key = (host, device);
            if !new_job && st.remote.contains_key(&key) {
                return;
            }
            let before = st.remote_jobs.get(&key).copied();
            st.remote.insert(key, RemotePending { start, before, seen_busy: false })
        };
        if let Some(earlier) = earlier {
            self.write(earlier.start.finish(SystemTime::now(), Outcome::Unknown, None));
        }
    }

    /// A poll of a remote cutter, taken after the latest dispatch to it, with the job id the host
    /// reported for it. Finishes that cutter's job once it has faulted, or is free again having
    /// visibly run the job — see `RemotePending` for why "free" alone is not enough.
    pub fn remote_polled(&self, host: &HostId, device: &str, status: &CutStatus, host_job: Option<u64>) {
        let key = (host.clone(), device.to_string());
        let finished = {
            let mut st = self.state.lock().unwrap();
            st.remote_jobs.insert(key.clone(), host_job);
            let Some(pending) = st.remote.get_mut(&key) else { return };
            let outcome = if status.phase == Phase::Failed {
                // A host refuses a dispatch to a cutter in fault, so a fault seen now is this job's.
                Some((Outcome::Failed, status.error.as_ref().map(|e| e.to_string())))
            } else if !status.actions.cut {
                pending.seen_busy = true;
                None
            } else if pending.seen_busy || pending.before.is_some_and(|before| before != host_job) {
                Some(match status.ended {
                    Some(Ended::Completed) => (Outcome::Completed, None),
                    Some(Ended::Cancelled) => (Outcome::Cancelled, None),
                    None => (Outcome::Unknown, None),
                })
            } else {
                None
            };
            outcome.map(|o| (st.remote.remove(&key).expect("present above").start, o))
        };
        if let Some((start, (outcome, error))) = finished {
            self.write(start.finish(SystemTime::now(), outcome, error));
        }
    }

    /// At exit: every job still open is written as `unknown`, so a job that started is never lost
    /// from the log just because nothing reported its end.
    pub fn flush_unfinished(&self) {
        let now = SystemTime::now();
        let open: Vec<UsageStart> = {
            let mut st = self.state.lock().unwrap();
            let local = st.local.drain(..).filter(|p| p.job_id.is_some()).map(|p| p.start);
            let mut all: Vec<UsageStart> = local.collect();
            all.extend(st.remote.drain().map(|(_, p)| p.start));
            all
        };
        for s in open {
            self.write(s.finish(now, Outcome::Unknown, None));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use driver_core::manager::DeviceError;
    use driver_core::Actions;
    use std::time::Duration;

    fn start(operator: Option<&str>) -> UsageStart {
        UsageStart {
            started: SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
            operator: operator.map(String::from),
            machine_id: "cameo1".into(),
            device_instance_id: "usb:1:4".into(),
            host: None,
            document: Some("sign.cut".into()),
            passes: vec![UsagePass {
                key: "color:ff0000ff".into(),
                preset_id: Some("cameo1-vinyl-sticker".into()),
                preset_name: Some("Vinyl Sticker".into()),
                speed: Some(5),
                force: Some(10),
                repeat_count: 2,
                cut_length_mm: 80.0,
            }],
            cut_length_mm: 80.0,
        }
    }

    fn status(phase: Phase, ended: Option<Ended>, cut: bool) -> CutStatus {
        CutStatus { phase, ended, actions: Actions { cut, ..Actions::default() }, pass: None, sent: None, error: None }
    }

    fn event(job_id: u64, kind: DeviceEventKind, status: CutStatus) -> DeviceEvent {
        DeviceEvent { job_id, kind, status }
    }

    fn recorder() -> (tempfile::TempDir, PathBuf, Recorder) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cuthulhu").join("usage.jsonl");
        let rec = Recorder::new(Some(path.clone()));
        (dir, path, rec)
    }

    #[test]
    fn rfc3339_is_utc_civil_time() {
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)), "2023-11-14T22:13:20Z");
        // A leap day, which is where a hand-written calendar goes wrong.
        assert_eq!(rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn a_polyline_is_as_long_as_its_segments() {
        let square = vec![vec![
            geometry::Point { x: 0.0, y: 0.0 },
            geometry::Point { x: 10.0, y: 0.0 },
            geometry::Point { x: 10.0, y: 10.0 },
            geometry::Point { x: 0.0, y: 10.0 },
            geometry::Point { x: 0.0, y: 0.0 },
        ]];
        assert_eq!(polyline_length(&square), 40.0);
    }

    #[test]
    fn entries_append_as_lines_and_read_back_newest_first() {
        let (_dir, path, _) = recorder();
        let first = start(Some("ada")).finish(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_090), Outcome::Completed, None);
        let second = UsageEntry { operator: Some("grace".into()), ..first.clone() };
        append(&path, &first).unwrap();
        append(&path, &second).unwrap();
        assert_eq!(first.duration_s, 90.0);
        assert_eq!(read_recent(&path, 10).unwrap(), vec![second.clone(), first.clone()]);
        assert_eq!(read_recent(&path, 1).unwrap(), vec![second]);
    }

    #[test]
    fn a_torn_line_costs_only_itself() {
        let (_dir, path, _) = recorder();
        let entry = start(None).finish(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_001), Outcome::Failed, Some("x".into()));
        append(&path, &entry).unwrap();
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"started_at\":\"2023-").unwrap();
        assert_eq!(read_all(&path).unwrap(), vec![entry]);
    }

    #[test]
    fn a_missing_log_is_an_empty_history() {
        let (_dir, path, _) = recorder();
        assert_eq!(read_recent(&path, 5).unwrap(), vec![]);
    }

    #[test]
    fn csv_quotes_separators_and_disarms_formulas() {
        assert_eq!(csv_text("plain"), "plain");
        assert_eq!(csv_text("a,b"), "\"a,b\"");
        assert_eq!(csv_text("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_text("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_text("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_text("+1"), "'+1");
        assert_eq!(csv_text("@sum"), "'@sum");
    }

    #[test]
    fn csv_has_one_row_per_job_under_the_header() {
        let entry = start(Some("Lovelace, Ada"))
            .finish(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_010), Outcome::Completed, None);
        let csv = to_csv(&[entry]);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], CSV_HEADER);
        assert_eq!(
            lines[1],
            "2023-11-14T22:13:20Z,2023-11-14T22:13:30Z,10,\"Lovelace, Ada\",cameo1,usb:1:4,,sign.cut,completed,80,1,\
             Vinyl Sticker,color:ff0000ff [cameo1-vinyl-sticker] speed 5 force 10 x2,"
        );
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn export_writes_the_whole_log() {
        let (dir, path, _) = recorder();
        let entry = start(None).finish(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_001), Outcome::Completed, None);
        append(&path, &entry).unwrap();
        append(&path, &entry).unwrap();
        let out = dir.path().join("usage.csv");
        assert_eq!(export_csv(&path, &out).unwrap(), 2);
        assert_eq!(fs::read_to_string(&out).unwrap().lines().count(), 3);
    }

    #[test]
    fn a_local_job_is_written_when_its_completion_arrives() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(Some("ada"))), || Ok::<u64, ()>(1)).unwrap();
        assert!(read_all(&path).unwrap().is_empty(), "nothing is written before the job ends");
        rec.observe(&event(1, DeviceEventKind::PassComplete(0), status(Phase::Sending, None, false)));
        rec.observe(&event(1, DeviceEventKind::JobComplete, status(Phase::Sending, None, false)));
        let log = read_all(&path).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].outcome, Outcome::Completed);
        assert_eq!(log[0].operator.as_deref(), Some("ada"));
    }

    /// The worker can finish a short job before `cut` replies, and the bridge can hear it first.
    #[test]
    fn an_ending_heard_before_the_reply_still_finds_its_job() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(None)), || {
            rec.observe(&event(4, DeviceEventKind::JobComplete, status(Phase::Sending, None, false)));
            Ok::<u64, ()>(4)
        })
        .unwrap();
        let log = read_all(&path).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].outcome, Outcome::Completed);
    }

    #[test]
    fn a_cancel_and_a_fault_are_logged_as_what_they_were() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(None)), || Ok::<u64, ()>(1)).unwrap();
        rec.observe(&event(1, DeviceEventKind::StateChanged, status(Phase::Idle, Some(Ended::Cancelled), true)));
        rec.local_cut(Some(start(None)), || Ok::<u64, ()>(2)).unwrap();
        rec.observe(&event(2, DeviceEventKind::Failed(DeviceError::Timeout), status(Phase::Sending, None, false)));
        let log = read_all(&path).unwrap();
        assert_eq!(log.iter().map(|e| e.outcome).collect::<Vec<_>>(), vec![Outcome::Cancelled, Outcome::Failed]);
        assert!(log[1].error.is_some());
    }

    /// A job that failed in its first pass is refused by `cut` *and* reported by a `Failed` event.
    #[test]
    fn a_job_refused_mid_first_pass_is_logged_from_its_event() {
        let (_dir, path, rec) = recorder();
        let r = rec.local_cut(Some(start(None)), || Err::<u64, &str>("timeout"));
        assert!(r.is_err());
        rec.observe(&event(1, DeviceEventKind::Failed(DeviceError::Timeout), status(Phase::Sending, None, false)));
        assert_eq!(read_all(&path).unwrap()[0].outcome, Outcome::Failed);
    }

    /// A busy refusal starts no job, so nothing is logged — and the start it left cannot be claimed
    /// by a later job's events.
    #[test]
    fn a_job_that_never_started_is_not_logged() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(Some("first"))), || Ok::<u64, ()>(1)).unwrap();
        let _ = rec.local_cut(Some(start(Some("refused"))), || Err::<u64, ()>(()));
        rec.observe(&event(1, DeviceEventKind::JobComplete, status(Phase::Sending, None, false)));
        rec.local_cut(Some(start(Some("third"))), || Ok::<u64, ()>(2)).unwrap();
        rec.observe(&event(2, DeviceEventKind::JobComplete, status(Phase::Sending, None, false)));
        let ops: Vec<_> = read_all(&path).unwrap().into_iter().map(|e| e.operator.unwrap()).collect();
        assert_eq!(ops, vec!["first", "third"]);
    }

    #[test]
    fn a_disconnect_ends_a_parked_job() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(None)), || Ok::<u64, ()>(1)).unwrap();
        rec.observe(&event(0, DeviceEventKind::StateChanged, status(Phase::Disconnected, None, false)));
        let log = read_all(&path).unwrap();
        assert_eq!(log[0].outcome, Outcome::Cancelled);
        assert!(log[0].error.as_deref().unwrap().contains("disconnected"));
    }

    #[test]
    fn a_remote_job_ends_when_its_cutter_is_free_again() {
        let (_dir, path, rec) = recorder();
        let host = HostId("pi".into());
        rec.remote_started(host.clone(), "usb:1".into(), UsageStart { host: Some("pi".into()), ..start(None) }, true);
        rec.remote_polled(&host, "usb:1", &status(Phase::Sending, None, false), Some(1));
        assert!(read_all(&path).unwrap().is_empty());
        rec.remote_polled(&host, "usb:1", &status(Phase::Idle, Some(Ended::Completed), true), Some(2));
        let log = read_all(&path).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].outcome, Outcome::Completed);
        assert_eq!(log[0].host.as_deref(), Some("pi"));
    }

    /// Between the accept and the host's `cut` call starting, the cutter is free and still shows
    /// the previous job's ending. That is not this job ending; the host's job id moving, or the
    /// cutter having been seen busy, is.
    #[test]
    fn a_free_cutter_still_showing_the_previous_ending_does_not_end_the_new_job() {
        let (_dir, path, rec) = recorder();
        let host = HostId("pi".into());
        let done = status(Phase::Idle, Some(Ended::Completed), true);
        rec.remote_polled(&host, "usb:1", &done, Some(7));
        rec.remote_started(host.clone(), "usb:1".into(), start(None), true);
        rec.remote_polled(&host, "usb:1", &done, Some(7));
        assert!(read_all(&path).unwrap().is_empty(), "the previous job's ending was taken for this one");
        // A short job can finish between two polls: the id moving is enough.
        rec.remote_polled(&host, "usb:1", &status(Phase::Idle, Some(Ended::Cancelled), true), Some(8));
        assert_eq!(read_all(&path).unwrap()[0].outcome, Outcome::Cancelled);
    }

    #[test]
    fn a_remote_fault_ends_the_job_as_failed() {
        let (_dir, path, rec) = recorder();
        let host = HostId("pi".into());
        rec.remote_started(host.clone(), "usb:1".into(), start(None), true);
        let failed = CutStatus { error: Some(DeviceError::Timeout), ..status(Phase::Failed, None, false) };
        rec.remote_polled(&host, "usb:1", &failed, None);
        let log = read_all(&path).unwrap();
        assert_eq!(log[0].outcome, Outcome::Failed);
        assert!(log[0].error.is_some());
    }

    /// A retry the host recognised is the job already open, not a second one; but when the first
    /// dispatch's answer was lost, nothing was open, and the retry is what records it.
    #[test]
    fn a_recognised_retry_is_logged_once() {
        let (_dir, path, rec) = recorder();
        let host = HostId("pi".into());
        rec.remote_started(host.clone(), "usb:1".into(), start(Some("lost-reply")), false);
        rec.remote_started(host.clone(), "usb:1".into(), start(Some("retry")), false);
        rec.remote_polled(&host, "usb:1", &status(Phase::Sending, None, false), Some(1));
        rec.remote_polled(&host, "usb:1", &status(Phase::Idle, Some(Ended::Completed), true), Some(1));
        let log = read_all(&path).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].operator.as_deref(), Some("lost-reply"));
    }

    #[test]
    fn jobs_nobody_saw_end_are_written_as_unknown_at_exit() {
        let (_dir, path, rec) = recorder();
        rec.local_cut(Some(start(None)), || Ok::<u64, ()>(1)).unwrap();
        rec.remote_started(HostId("pi".into()), "usb:1".into(), start(None), true);
        rec.flush_unfinished();
        let log = read_all(&path).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log.iter().all(|e| e.outcome == Outcome::Unknown));
    }

    #[test]
    fn a_recorder_without_a_log_writes_nothing() {
        let rec = Recorder::new(None);
        rec.local_cut(Some(start(None)), || Ok::<u64, ()>(1)).unwrap();
        rec.observe(&event(1, DeviceEventKind::JobComplete, status(Phase::Sending, None, false)));
        assert!(rec.log_path().is_none());
    }
}
