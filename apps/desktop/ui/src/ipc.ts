// SPDX-License-Identifier: GPL-3.0-or-later
import { invoke } from "@tauri-apps/api/core";
import { save as dialogSave, open as dialogOpen } from "@tauri-apps/plugin-dialog";

// ponytail: loose types for delta/snapshot payloads until Rust shape mirrors TS
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

export async function newDoc() {
  return invoke("new_doc", {});
}

export async function snapshot() {
  return invoke("snapshot", {});
}

export async function commitTransform(args: Args) {
  return invoke("commit_transform", args);
}

/** Several moves, each with its own matrix, committed as one undo (align and distribute). */
export async function commitTransforms(args: { moves: { ids: number[]; m: number[] }[] }) {
  return invoke("commit_transforms", args);
}

export async function addPrimitive(args: Args) {
  return invoke("add_primitive", args);
}

export async function booleanOp(args: Args) {
  return invoke("boolean_op", args);
}

export async function addText(args: Args) {
  return invoke("add_text", args);
}

export async function deleteNodes(args: Args) {
  return invoke("delete", args);
}

export async function reorder(args: Args) {
  return invoke("reorder", args);
}

export async function setCutLineType(args: Args) {
  return invoke("set_cut_line_type", args);
}

/** `rgba` is `0xRRGGBBAA`, the document's `Style` encoding. One undo step for the selection. */
export async function setStrokeColor(args: { ids: number[]; rgba: number }) {
  return invoke("set_stroke_color", args);
}

export async function setMaterialPreset(args: Args) {
  return invoke("set_material_preset", args);
}

export async function undo() {
  return invoke("undo", {});
}

export async function redo() {
  return invoke("redo", {});
}

export async function importSvg(args: Args) {
  return invoke("import_svg", args);
}

export async function saveProject(args: Args) {
  return invoke("save_project", args);
}

export async function loadProject(args: Args) {
  return invoke("load_project", args);
}

export async function setMachine(args: Args) {
  return invoke("set_machine", args);
}

export async function listMachines() {
  return invoke("list_machines", {});
}

// --- device / cut / preset wire types (mirror driver-core::manager + desktop::device) ---

export type TransportKind =
  | { Usb: { locator: string } }
  | { Serial: { path: string; baud: number } };

export type DeviceInfo = {
  instance_id: string;
  machine_id: string;
  transport: TransportKind;
  candidate: boolean;
  // null means this cutter is attached to this computer. A Cut Host's cutters carry the id of
  // the host that owns them, which is what every call routes on.
  host: string | null;
};

export type PairedHostView = {
  id: string;
  name: string;
  address: string;
  /** Why this host cannot be reached, or null when it can. */
  unreachable: string | null;
};

export type DeviceError =
  | "Disconnected"
  | "Busy"
  | "Timeout"
  | "WriteZero"
  | { Io: string };

export type Phase =
  | "Disconnected"
  | "Connecting"
  | "Disconnecting"
  | "Idle"
  | "Sending"
  | "AwaitingConfirmation"
  | "AwaitingColorSwap"
  | "Cancelling"
  | "Failed";

/** Mirrors driver_core::CutStatus. The phase says what is happening now; `ended`
 *  says how the last job finished, which no phase can — a finished cut and a
 *  cancelled one both rest on "Idle". Actions say which buttons are legal.
 *  Nothing here needs interpreting, and nothing needs remembering. */
export type CutStatus = {
  phase: Phase;
  ended: "Completed" | "Cancelled" | null;
  actions: { cut: boolean; cancel: boolean; resume: boolean; confirm: boolean };
  pass: { index: number; total: number } | null;
  sent: { sent: number; total: number } | null;
  error: DeviceError | null;
};

/** Mirrors CutStatus::disconnected() — what to show before the first status arrives. */
export const DISCONNECTED_STATUS: CutStatus = {
  phase: "Disconnected",
  ended: null,
  actions: { cut: false, cancel: false, resume: false, confirm: false },
  pass: null,
  sent: null,
  error: null,
};

// `StateChanged` carries no payload: the event's own `status` is what changed.
export type DeviceEventKind =
  | "StateChanged"
  | { Progress: { pass_index: number; submitted_bytes: number; total_bytes: number } }
  | { PassComplete: number }
  | "JobComplete"
  | { Failed: DeviceError };

export type DeviceEvent = { job_id: number; kind: DeviceEventKind; status: CutStatus };

/** A pass's name, in the canonical form `cutplan::PassKey` writes: `all`, `color:ff0000ff`,
 *  `no-color`, `preset:<id>`, `no-preset`. Sent back verbatim in a travel or cut request — the
 *  string *is* the identity. Absence has its own token because a preset id is an unrestricted
 *  operator string, so `preset:none` would collide with a preset called `none`. */
export type PassKey = string;

/** How the planner splits shapes into passes. Mirrors `cutplan::Grouping`. */
export type Grouping = "Single" | "Color" | "Stroke" | "Fill" | "Preset";

/** Mirrors `document::PresetAssignment`'s adjacently-tagged JSON. */
export type PresetAssignmentJson =
  | { state: "inherit" }
  | { state: "unassigned" }
  | { state: "preset"; id: string };

export type PlanCutPassSummary = {
  key: PassKey;
  shape_count: number;
  node_ids: number[];
  /** Each shape's first world-space point, parallel to node_ids — where the blade lands.
   *  null is a shape whose outline flattened to nothing. */
  starts: ([number, number] | null)[];
};

export type PlanCutResponse = {
  passes: PlanCutPassSummary[];
  skipped_not_cut: number;
  doc_revision: string;
  travel: [number, number, number, number][];
};

export type IpcError = { code: string; message: string };

// Real IpcError-derived commands reject with the serialized {code,message}
// object itself (not a string) — String(e) on those yields "[object Object]".
// Older doc-editing commands still reject with a plain string. Handle both.
export function ipcErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function ipcErrorCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return null;
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return invoke("list_devices", {});
}

export async function connectDevice(info: DeviceInfo): Promise<void> {
  return invoke("connect_device", { info });
}

export async function disconnectDevice(): Promise<void> {
  return invoke("disconnect_device", {});
}

/** Re-opens the aimed cutter's transport, locally or on its Cut Host. What clears a cancel whose
 *  stop nothing confirmed — there is no verb for declaring one confirmed. */
export async function reconnectDevice(): Promise<void> {
  return invoke("reconnect_device", {});
}

export async function getDeviceState(): Promise<CutStatus> {
  return invoke("get_device_state", {});
}

export async function getConnectedDevice(): Promise<DeviceInfo | null> {
  return invoke("get_connected_device", {});
}

export async function forceQuit(): Promise<void> {
  return invoke("force_quit", {});
}

export async function planCut(grouping: Grouping): Promise<PlanCutResponse> {
  return invoke("plan_cut", { grouping });
}

/** A pass as the dialog has it configured: where it sits in the order, and whether it is cut. */
export type TravelPass = { key: PassKey; enabled: boolean };

/** Travel replanned by the backend for the dialog's current pass list, under the grouping that
 *  produced it. Every planned pass must be named (disabled ones included — they are dropped
 *  from the travel, not from the list). Rejects with code "stale_plan" when the document has
 *  changed since `docRevision` was planned. */
export async function travelForOrder(
  docRevision: string,
  grouping: Grouping,
  passes: TravelPass[],
): Promise<[number, number, number, number][]> {
  return invoke("travel_for_order", { docRevision, grouping, passes });
}

/** What a press of Cut did. `duplicate` is the Cut Host saying it had already accepted this
 *  dispatch and started nothing — the one fact the desktop cannot work out for itself, and the
 *  difference between a cutter about to move and one that never will. */
export type CutStarted = { job_id: number; duplicate: boolean };

export async function cut(request: Args): Promise<CutStarted> {
  return invoke("cut", { request });
}

export async function cancelCut(): Promise<void> {
  return invoke("cancel_cut", {});
}

export async function resumeCut(): Promise<void> {
  return invoke("resume_cut", {});
}

export async function confirmPassDone(): Promise<void> {
  return invoke("confirm_pass_done", {});
}

export async function listHosts(): Promise<PairedHostView[]> {
  return invoke("list_hosts", {});
}

/** The fingerprint a host presents, for the operator to confirm. Sends no token: it runs
 *  before the operator has confirmed the host's identity. */
export async function probeHost(address: string): Promise<string> {
  return invoke("probe_host", { address });
}

export async function testHost(address: string, token: string, fingerprint: string): Promise<DeviceInfo[]> {
  return invoke("test_host", { address, token, fingerprint });
}

/** A Cut Host already paired at this address, if there is one. `sameFingerprint: false` means the
 *  host's certificate changed since it was paired — a reinstall, or something worth worrying
 *  about, and the operator is the only one who knows which. */
export type ExistingPairing = { id: string; name: string; sameFingerprint: boolean };

export async function existingPairing(address: string, fingerprint: string): Promise<ExistingPairing | null> {
  return invoke("existing_pairing", { address, fingerprint });
}

export async function pairHost(name: string, address: string, token: string, fingerprint: string): Promise<PairedHostView> {
  return invoke("pair_host", { name, address, token, fingerprint });
}

// `force` is the operator accepting that a host which cannot be asked may still be cutting. Only
// offered once an unforced attempt has been refused — see `forgetFrom`.
export async function forgetHost(id: string, force: boolean): Promise<void> {
  return invoke("forget_host", { id, force });
}

export async function listPresets(machineId: string) {
  return invoke("list_presets", { machineId });
}

export async function machineCaps(machineId: string) {
  return invoke("machine_caps", { machineId });
}

/** Mirrors `cutplan::preflight::SettingsRanges`. Fetched rather than restated, the way
 *  `traceControls` is: `cutplan::preflight` is what refuses a cut whose settings sit outside
 *  these, so the preset editor asks it for the bounds instead of keeping a second copy to drift. */
export type SettingRange = { min: number; max: number };
export type SettingsRanges = {
  speed: SettingRange;
  force: SettingRange;
  repeatCount: SettingRange;
  /** A preset's advisory ratchet-blade depth. Absent from an older backend, which then refuses an
   *  out-of-range depth itself. */
  bladeDepth?: SettingRange;
};

/** The shared ranges, or — given a machine — the ranges that machine admits (its own speed
 *  ceiling). */
export async function settingsRanges(machineId?: string): Promise<SettingsRanges> {
  return invoke("settings_ranges", machineId === undefined ? {} : { machineId });
}

/** Mirrors `document::LayerSettings`: one pass's saved choices. `null` defers to the preset. */
export type LayerSettings = {
  output: boolean;
  preset_id: string | null;
  speed: number | null;
  force: number | null;
  repeat_count: number | null;
  track_enhancing: boolean | null;
  pen: boolean | null;
};

/** Mirrors `document::JobSettings`. Absent from a document saved before it existed. */
export type JobSettings = {
  layers: Record<PassKey, LayerSettings>;
  layer_order: PassKey[];
  mirror: boolean;
};

/** `value: null` forgets the pass's settings. Saved with the project; not an undo step. */
export async function setLayerSettings(key: PassKey, value: LayerSettings | null) {
  return invoke("set_layer_settings", { key, value });
}

export async function setLayerOrder(order: PassKey[]) {
  return invoke("set_layer_order", { order });
}

export async function setMirror(on: boolean) {
  return invoke("set_mirror", { on });
}

/** Sizes the artboard to the loaded media, clamped by the backend to the machine's reach. */
export async function setMedia(wMm: number, hMm: number) {
  return invoke("set_media", { wMm, hMm });
}

export async function savePreset(p: Args) {
  return invoke("save_preset", { p });
}

/** A preset is identified by its machine as well as its id: the same id can name a material on a
 *  Cameo and on a Puma, and deleting by id alone removed both (#153). */
export async function deletePreset(machineId: string, id: string) {
  return invoke("delete_preset", { machineId, id });
}

// --- usage log (mirrors desktop::usage) ---

export type UsageOutcome = "completed" | "cancelled" | "failed" | "unknown";

/** One pass of a logged job, with the settings it was actually cut with (resolved, not typed). */
export type UsagePass = {
  key: PassKey;
  preset_id: string | null;
  preset_name: string | null;
  speed: number | null;
  force: number | null;
  repeat_count: number;
  /** This pass's share of the job's length. */
  cut_length_mm: number;
};

/** One line of `<config_dir>/cuthulhu/usage.jsonl`. Times are RFC 3339 in UTC. */
export type UsageEntry = {
  started_at: string;
  ended_at: string;
  duration_s: number;
  operator: string | null;
  machine_id: string;
  device_instance_id: string;
  /** The Cut Host's id when the job ran on one. */
  host: string | null;
  /** The project's file name when it had been saved or opened. */
  document: string | null;
  passes: UsagePass[];
  /** Blade travel while cutting, counting every repeat. */
  cut_length_mm: number;
  outcome: UsageOutcome;
  error: string | null;
};

/** The newest `limit` jobs, newest first. */
export async function usageLog(limit: number): Promise<UsageEntry[]> {
  return invoke("usage_log", { limit });
}

/** Writes the whole log as CSV at `path`; answers how many jobs it holds. */
export async function exportUsageCsv(path: string): Promise<number> {
  return invoke("export_usage_csv", { path });
}

export async function pickCsvSavePath(): Promise<string | null> {
  return dialogSave({ defaultPath: "cuthulhu-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
}

// --- where presets live (mirrors desktop::settings::PresetsLocation) ---

export type PresetsLocation = { path: string; custom: boolean; defaultPath: string };

export async function getPresetsLocation(): Promise<PresetsLocation> {
  return invoke("get_presets_location", {});
}

/** A file, or a folder meaning `presets.json` inside it; `null` goes back to this computer's own
 *  file. Refused with `presets_unreachable` when the folder is not there (an unmounted share). */
export async function setPresetsLocation(path: string | null): Promise<PresetsLocation> {
  return invoke("set_presets_location", { path });
}

/** A folder rather than a file, so a share that holds no presets yet can still be chosen. */
export async function pickPresetsFolder(): Promise<string | null> {
  const r = await dialogOpen({ directory: true, multiple: false, title: "Folder for the shared presets.json" });
  return typeof r === "string" ? r : null;
}

const CUT_FILTER = [{ name: "cuthulhu project", extensions: ["cut"] }];

export async function pickSavePath(): Promise<string | null> {
  return dialogSave({ defaultPath: "cuthulhu-project.cut", filters: CUT_FILTER });
}

export async function pickOpenPath(): Promise<string | null> {
  const r = await dialogOpen({ multiple: false, filters: CUT_FILTER });
  return typeof r === "string" ? r : null;
}

// --- trace wire types ---

export type TraceControlsDto = {
  mode: "binary" | "color";
  speckle: number;
  smoothing: number;
  detail: number;
  colors: number;
};
// Mirrors trace::ControlSpec. No range, default, or step is written on this side — the whole point
// of the command below is that these numbers have one home.
export type ControlSpec = {
  name: "speckle" | "smoothing" | "detail" | "colors";
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  default: number;
  colorOnly: boolean;
};
export type TraceControlSpecsDto = {
  controls: ControlSpec[];
  defaultMode: "binary" | "color";
  maxDim: number;
};
export type TraceResultDto = { svg: string; pathCount: number; widthPx: number; heightPx: number; downscaled: boolean };

export async function traceControls(): Promise<TraceControlSpecsDto> {
  return invoke("trace_controls", {});
}
// Sorted installed family names; empty on a system with no fonts (a state, not an error).
export async function listFonts(): Promise<string[]> {
  return invoke("list_fonts", {});
}
export async function traceImage(args: { path: string; controls: TraceControlsDto }): Promise<TraceResultDto> {
  return invoke("trace_image", args);
}
export async function loadImagePreview(args: { path: string }): Promise<string> {
  return invoke("load_image_preview", args);
}
// Goes through Rust rather than the dialog plugin directly: the backend records what the user
// picked and refuses to trace anything else, so choosing the file here is what grants access.
export async function pickImagePath(): Promise<string | null> {
  return invoke("pick_image", {});
}
