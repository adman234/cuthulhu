// SPDX-License-Identifier: GPL-3.0-or-later
import type { CutStatus, DeviceInfo, PassKey, PlanCutPassSummary } from "../ipc";
import { presetIdForKey, type PassVm } from "../cut/viewmodel";

/** What the operator set on a Cuts row: everything but what the planner says about it. */
export type RowSettings = Pick<PassVm, "enabled" | "presetId" | "speed" | "force" | "repeatCount">;

export type CutRow = PassVm & { nodeIds: number[] };

/** A plan the Cuts panel shows: the revision it was planned against travels with its rows,
 *  because a cut request names that revision and the backend refuses a stale one. */
export type DockPlan = { revision: string; rows: CutRow[]; skippedNotCut: number };

/** Defaults for a pass nobody has touched. A preset-keyed pass starts on the preset it is keyed
 *  on, for the same reason the cut dialog does it: otherwise it is cut with no settings at all. */
export function freshSettings(key: PassKey): RowSettings {
  return { enabled: true, presetId: presetIdForKey(key), speed: null, force: null, repeatCount: null };
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
    ...(held.get(p.key) ?? freshSettings(p.key)),
  }));
}

/** `held` with one row's settings recorded, as a new map so React sees the change. */
export function holdSettings(
  held: ReadonlyMap<PassKey, RowSettings>,
  row: CutRow,
): Map<PassKey, RowSettings> {
  const next = new Map(held);
  const { enabled, presetId, speed, force, repeatCount } = row;
  next.set(row.key, { enabled, presetId, speed, force, repeatCount });
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
