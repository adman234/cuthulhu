// SPDX-License-Identifier: GPL-3.0-or-later
import type { Paper, Registration, RegistrationArea, RegistrationStatus } from "../ipc";

/** The four area fields as typed, so a half-typed number is not thrown away on the next render. */
export type AreaDraft = { originX: string; originY: string; width: string; length: string };

export const PAPERS: { value: Paper; label: string }[] = [
  { value: "letter", label: "Letter (8.5 × 11 in)" },
  { value: "a4", label: "A4 (210 × 297 mm)" },
];

/** Millimetres to one decimal place at most, the precision the fields are typed in. */
export function mm(v: number): string {
  return String(Math.round(v * 10) / 10);
}

export function draftFromArea(a: RegistrationArea): AreaDraft {
  return { originX: mm(a.origin_x_mm), originY: mm(a.origin_y_mm), width: mm(a.width_mm), length: mm(a.length_mm) };
}

/** The draft as an area, or the field that is not a number. Only the shape of a number is judged
 *  here: whether the marks fit, or are far enough apart, is the backend's refusal to make. */
export function areaFromDraft(d: AreaDraft): { area: RegistrationArea } | { error: string } {
  const fields: [keyof AreaDraft, string][] = [
    ["originX", "Left"],
    ["originY", "Top"],
    ["width", "Width"],
    ["length", "Length"],
  ];
  const values: number[] = [];
  for (const [key, label] of fields) {
    const text = d[key].trim();
    const v = text === "" ? NaN : Number(text);
    if (!Number.isFinite(v)) return { error: `${label} must be a number of millimetres` };
    values.push(v);
  }
  const [origin_x_mm, origin_y_mm, width_mm, length_mm] = values;
  return { area: { origin_x_mm, origin_y_mm, width_mm, length_mm } };
}

/** One line saying where the document stands, in the order an operator works through it. */
export function statusLine(s: RegistrationStatus | null): string {
  if (s === null) return "Reading the document…";
  if (s.problem !== null) return s.problem;
  if (s.marks === null || s.area === null) return "No registration marks in this document yet.";
  const a = s.area;
  const where = `${mm(a.width_mm)} × ${mm(a.length_mm)} mm, from ${mm(a.origin_x_mm)}, ${mm(a.origin_y_mm)} mm`;
  return s.enabled ? `Marks placed (${where}); the cut will register against them.` : `Marks placed (${where}); registration is off.`;
}

/** The switch is offered only once there are marks that can be read: turning it on with none is
 *  refused by the backend, and a switch that is refused when used is a switch that lies. */
export function canToggle(s: RegistrationStatus | null): boolean {
  return s !== null && s.marks !== null && s.problem === null;
}

/** The cut dialog's notice for a registered plan, or null for one that is not. */
export function registeredNotice(r: Registration | null | undefined): string | null {
  if (!r) return null;
  return `Registered: the cutter looks for the printed marks first (${mm(r.widthMm)} × ${mm(r.lengthMm)} mm from ${mm(r.originXMm)}, ${mm(r.originYMm)} mm) and cuts from them.`;
}
