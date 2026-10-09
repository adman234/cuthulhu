// SPDX-License-Identifier: GPL-3.0-or-later
import type { CutStatus, DeviceInfo, JobSettings, LayerSettings, PassKey, PlanCutPassSummary } from "../ipc";
import { presetIdForKey, type PassVm, type Preset, type PresetLookup } from "../cut/viewmodel";

/** What the operator set on a Cuts row: everything but what the planner says about it. */
export type RowSettings = Pick<PassVm, "enabled" | "presetId" | "speed" | "force" | "repeatCount" | "trackEnhancing" | "tool">;

export type CutRow = PassVm & {
  nodeIds: number[];
  /** Each shape's first world point, for the preview's order badges. */
  starts: ([number, number] | null)[];
  /** Length the blade draws in one run of this pass, mm. */
  cutLengthMm: number;
};

/** A plan the Cuts panel shows: the revision it was planned against travels with its rows,
 *  because a cut request names that revision and the backend refuses a stale one. */
export type DockPlan = {
  revision: string;
  rows: CutRow[];
  skippedNotCut: number;
  /** Head moves between shapes for the rows as ordered and enabled, for the preview. */
  travel: [number, number, number, number][];
};

/** What Test cut may do: the same permission as Start (a connected, ready cutter for this
 *  design's machine), less the need for anything drawn. */
export function testCutControl(args: {
  status: CutStatus;
  connected: DeviceInfo | null;
  sending: boolean;
  mismatch: string | null;
}): Control {
  if (args.connected === null) return { enabled: false, reason: "Connect a cutter first" };
  if (args.mismatch !== null) return { enabled: false, reason: args.mismatch };
  if (args.sending) return { enabled: false, reason: "Sending…" };
  if (!args.status.actions.cut) return { enabled: false, reason: "The cutter is not ready" };
  return { enabled: true, reason: null };
}

/** Defaults for a pass nobody has touched. A preset-keyed pass starts on the preset it is keyed
 *  on, for the same reason the cut dialog does it: otherwise it is cut with no settings at all. */
export function freshSettings(key: PassKey): RowSettings {
  return { enabled: true, presetId: presetIdForKey(key), speed: null, force: null, repeatCount: null, trackEnhancing: null, tool: null };
}

/** A row's settings as the document saves them. */
export function toLayer(row: RowSettings): LayerSettings {
  return {
    output: row.enabled,
    preset_id: row.presetId,
    speed: row.speed,
    force: row.force,
    repeat_count: row.repeatCount,
    track_enhancing: row.trackEnhancing ?? null,
    pen: row.tool === undefined || row.tool === null ? null : row.tool === "Pen",
  };
}

/** A saved layer back into row settings. */
export function fromLayer(l: LayerSettings): RowSettings {
  return {
    enabled: l.output,
    presetId: l.preset_id,
    speed: l.speed,
    force: l.force,
    repeatCount: l.repeat_count,
    trackEnhancing: l.track_enhancing,
    tool: l.pen === null ? null : l.pen ? "Pen" : "Blade",
  };
}

/** Settings saved in the document, as the map `rowsFromPlan` reads. */
export function heldFromJob(job: JobSettings | undefined): Map<PassKey, RowSettings> {
  return new Map(Object.entries(job?.layers ?? {}).map(([k, l]) => [k, fromLayer(l)]));
}

/** Passes in the operator's saved order: keys named in `order` first, in that order, then the
 *  rest as the planner listed them. A saved key with no pass today is skipped, not an error —
 *  its colour is simply not in the design right now. */
export function orderRows<T extends { key: PassKey }>(rows: T[], order: PassKey[]): T[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank.get(a.r.key) ?? order.length + a.i) - (rank.get(b.r.key) ?? order.length + b.i))
    .map((x) => x.r);
}

/** The key order after moving row `index` one step, or null at an end. */
export function moveKey(rows: { key: PassKey }[], index: number, dir: -1 | 1): PassKey[] | null {
  const to = index + dir;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return null;
  const keys = rows.map((r) => r.key);
  [keys[index], keys[to]] = [keys[to], keys[index]];
  return keys;
}

/** The rows for a new plan, carrying over what the operator set on each colour.
 *
 *  Keyed by PassKey because that is the pass's identity across replans: the panel replans on
 *  every edit, and a layer whose speed was just typed must not snap back to defaults because a
 *  shape moved. A colour that leaves the design takes its settings with it only until it comes
 *  back — `held` keeps them. */
export function rowsFromPlan(
  passes: PlanCutPassSummary[],
  held: ReadonlyMap<PassKey, RowSettings>,
): CutRow[] {
  return passes.map((p) => ({
    key: p.key,
    shapeCount: p.shape_count,
    nodeIds: p.node_ids,
    starts: p.starts,
    cutLengthMm: p.cut_length_mm ?? 0,
    ...(held.get(p.key) ?? freshSettings(p.key)),
  }));
}

/** `held` with one row's settings recorded, as a new map so React sees the change. */
export function holdSettings(
  held: ReadonlyMap<PassKey, RowSettings>,
  row: CutRow,
): Map<PassKey, RowSettings> {
  const next = new Map(held);
  const { enabled, presetId, speed, force, repeatCount, trackEnhancing, tool } = row;
  next.set(row.key, { enabled, presetId, speed, force, repeatCount, trackEnhancing, tool });
  return next;
}

export type Control = { enabled: boolean; reason: string | null };

/** What the Cutter panel's Start button may do, and if not, why — in words, because a greyed
 *  Start with no reason is the most common question a makerspace member asks.
 *
 *  Permission comes from `status.actions` alone (CLAUDE.md: never re-derive it from the phase). */
export function startControl(args: {
  status: CutStatus;
  connected: DeviceInfo | null;
  plan: DockPlan | null;
  planning: boolean;
  sending: boolean;
  mismatch: string | null;
}): Control {
  const { status, connected, plan, planning, sending, mismatch } = args;
  if (connected === null) return { enabled: false, reason: "Connect a cutter first" };
  if (mismatch !== null) return { enabled: false, reason: mismatch };
  if (sending) return { enabled: false, reason: "Sending…" };
  if (!status.actions.cut) return { enabled: false, reason: "The cutter is not ready" };
  if (planning || plan === null) return { enabled: false, reason: "Planning…" };
  if (!plan.rows.some((r) => r.shapeCount > 0)) return { enabled: false, reason: "Nothing to cut" };
  if (!plan.rows.some((r) => r.enabled && r.shapeCount > 0)) {
    return { enabled: false, reason: "Turn on Output for at least one layer" };
  }
  return { enabled: true, reason: null };
}

/** Why this design cannot go to the connected cutter, or null when it can. The backend refuses a
 *  document set up for another machine (preflight's MachineMismatch); saying so before Start is
 *  pressed lets the panel offer the fix instead of an error. */
export function machineMismatch(docMachineId: string | null, connected: DeviceInfo | null): string | null {
  if (connected === null || docMachineId === null || docMachineId === connected.machine_id) return null;
  return `This design is set up for ${docMachineId}, but the cutter is ${connected.machine_id}`;
}

/** Percent of the job's bytes the cutter has taken, or null when nothing is being sent. */
export function progressPercent(status: CutStatus): number | null {
  const s = status.sent;
  if (s === null || s.total <= 0) return null;
  return Math.min(100, Math.round((100 * s.sent) / s.total));
}

/** The speed a pass will run at, as a time estimate needs it. */
function runSpeed(row: CutRow, lookup: PresetLookup): number {
  const preset = row.presetId !== null ? lookup.presets.find((p) => p.id === row.presetId) : undefined;
  return row.speed ?? preset?.settings.speed ?? DEFAULT_SPEED;
}

/** What a machine falls back to with no speed set, for estimating only. */
const DEFAULT_SPEED = 5;
/** Seconds each pass costs beyond its drawing: lowering, settling, the move to the next pass. */
const PASS_OVERHEAD_S = 4;

/** Seconds the enabled passes will take, roughly.
 *
 *  ponytail: speed `n` is read as n cm/s — Silhouette's own description of the scale — and
 *  travel moves and acceleration are ignored, so this is a guide for "is this a coffee or a
 *  lunch", not a promise. A per-machine feed-rate table measured on hardware is the upgrade. */
export function estimateSeconds(rows: CutRow[], lookup: PresetLookup): number {
  let total = 0;
  for (const r of rows) {
    if (!r.enabled || r.shapeCount === 0) continue;
    const preset = r.presetId !== null ? lookup.presets.find((p) => p.id === r.presetId) : undefined;
    const repeat = r.repeatCount ?? preset?.settings.repeat_count ?? 1;
    total += (r.cutLengthMm * repeat) / (runSpeed(r, lookup) * 10) + PASS_OVERHEAD_S;
  }
  return total;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Node ids whose layer has Output off — what the canvas dims, as LightBurn does. */
export function mutedNodeIds(rows: CutRow[]): number[] {
  return rows.filter((r) => !r.enabled).flatMap((r) => r.nodeIds);
}

/** Whether choosing `preset` should turn the job's mirror on: a material cut face down (heat
 *  transfer vinyl) and a job not already mirrored. Turning it on is the safe direction; the
 *  operator can still turn it off, and the dock says it did it. */
export function shouldAutoMirror(preset: Preset | undefined, mirrored: boolean): boolean {
  return !mirrored && preset?.mirror === true;
}

/** Media an operator loads into a Cameo, in mm. "Roll" asks for the machine's whole reach; the
 *  backend clamps every size to what the machine can reach. */
export type Media = { id: string; name: string; w: number; h: number };
export const MEDIA: readonly Media[] = [
  { id: "mat-12x12", name: "12×12 in mat", w: 304.8, h: 304.8 },
  { id: "mat-12x24", name: "12×24 in mat", w: 304.8, h: 609.6 },
  { id: "letter", name: "Letter sheet", w: 215.9, h: 279.4 },
  { id: "a4", name: "A4 sheet", w: 210, h: 297 },
  { id: "roll", name: "Roll (full length)", w: 100000, h: 100000 },
];

/** Which media the artboard currently is, given the machine's reach, or null for a custom size.
 *  Compared after the same clamp the backend applies, within a hundredth of a mm. */
export function currentMedia(
  artboard: { w: number; h: number },
  reach: { width_mm: number; height_mm: number } | null,
): string | null {
  if (reach === null) return null;
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const hit = MEDIA.find((m) => close(Math.min(m.w, reach.width_mm), artboard.w) && close(Math.min(m.h, reach.height_mm), artboard.h));
  return hit?.id ?? null;
}

export const BEGINNER_KEY = "cuthulhu.beginner";

/** Beginner mode hides speed, force, passes and the tool switches, leaving the material picker:
 *  a member picks "Vinyl Sticker" and presses Start. Off unless someone turned it on on this
 *  computer — whoever sets up the makerspace PC switches it on once — with the same try/catch
 *  rule as the layout choice, so a blocked storage still opens the window. */
export function readBeginner(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(BEGINNER_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeBeginner(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(BEGINNER_KEY, on ? "on" : "off");
  } catch {
    // Best effort, as with the layout.
  }
}
