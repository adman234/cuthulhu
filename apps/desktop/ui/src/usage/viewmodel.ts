// SPDX-License-Identifier: GPL-3.0-or-later
import type { UsageEntry, UsageOutcome } from "../ipc";

/** One row of a totals table: jobs, how many of them finished, blade travel and time cutting. */
export type Total = { name: string; jobs: number; completed: number; lengthMm: number; seconds: number };

/** Shown for a job nobody put a name to, rather than leaving the row blank. */
export const NO_OPERATOR = "(no name given)";
export const NO_MATERIAL = "No preset";

const bump = (rows: Map<string, Total>, name: string): Total => {
  let row = rows.get(name);
  if (row === undefined) {
    row = { name, jobs: 0, completed: 0, lengthMm: 0, seconds: 0 };
    rows.set(name, row);
  }
  return row;
};

const sorted = (rows: Map<string, Total>): Total[] =>
  [...rows.values()].sort((a, b) => b.lengthMm - a.lengthMm || b.jobs - a.jobs || a.name.localeCompare(b.name));

export function totalsByOperator(entries: UsageEntry[]): Total[] {
  const rows = new Map<string, Total>();
  for (const e of entries) {
    const row = bump(rows, e.operator ?? NO_OPERATOR);
    row.jobs += 1;
    if (e.outcome === "completed") row.completed += 1;
    row.lengthMm += e.cut_length_mm;
    row.seconds += e.duration_s;
  }
  return sorted(rows);
}

/** A material is the preset a pass was cut with, named as it was named then. A job with two
 *  materials counts once toward each, with each pass's own length; its time cannot be split by
 *  pass, so it is counted toward each material it used. */
export function totalsByMaterial(entries: UsageEntry[]): Total[] {
  const rows = new Map<string, Total>();
  for (const e of entries) {
    const used = new Set<string>();
    for (const p of e.passes) {
      const name = p.preset_name ?? p.preset_id ?? NO_MATERIAL;
      const row = bump(rows, name);
      row.lengthMm += p.cut_length_mm ?? 0;
      if (!used.has(name)) {
        used.add(name);
        row.jobs += 1;
        if (e.outcome === "completed") row.completed += 1;
        row.seconds += e.duration_s;
      }
    }
  }
  return sorted(rows);
}

export function formatLength(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** The log stores UTC; the dialog shows the reader's own clock, to the minute. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export const OUTCOME_LABEL: Record<UsageOutcome, string> = {
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  unknown: "Not seen to finish",
};

/** The materials a job used, for its row in the list. */
export function materialsOf(e: UsageEntry): string {
  const names = [...new Set(e.passes.map((p) => p.preset_name ?? p.preset_id ?? NO_MATERIAL))];
  return names.join(", ");
}
