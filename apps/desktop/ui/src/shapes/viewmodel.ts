// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shape tools' forms (offset, weed box, copies, nest): which fields each shows, what they start
// at, and how what the operator typed becomes a request. Ranges the backend enforces are not
// restated here — it refuses them in its own words, and the dialog shows that. What is refused here
// is only what cannot be sent at all: a blank or non-numeric field, or a count that is not a count.

export type FieldSpec =
  | { key: string; label: string; kind: "number"; unit?: string; step?: number }
  | { key: string; label: string; kind: "checkbox" }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] };

/** Numbers are kept as typed, so a half-typed "-" or "1." is not snapped back under the cursor. */
export type FormValues = Record<string, string | boolean>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type ToolForm<T> = {
  title: string;
  apply: string;
  fields: FieldSpec[];
  defaults: FormValues;
  parse: (v: FormValues) => Parsed<T>;
};

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A finite number, or the sentence saying which field is not one. */
function num(v: FormValues, key: string, label: string): number | string {
  const raw = v[key];
  const s = typeof raw === "string" ? raw.trim() : "";
  const n = s === "" ? NaN : Number(s);
  return Number.isFinite(n) ? n : `${label} must be a number`;
}

/** A whole number of at least 1. */
function count(v: FormValues, key: string, label: string): number | string {
  const n = num(v, key, label);
  if (typeof n === "string") return n;
  return Number.isInteger(n) && n >= 1 ? n : `${label} must be a whole number of at least 1`;
}

export type Join = "Round" | "Miter" | "Bevel";
export type OffsetRequest = { distanceMm: number; union: boolean; join: Join };

export const OFFSET_FORM: ToolForm<OffsetRequest> = {
  title: "Offset",
  apply: "Create offset",
  fields: [
    { key: "distance", label: "Distance (negative insets)", kind: "number", unit: "mm", step: 0.5 },
    { key: "join", label: "Corners", kind: "select", options: [
      { value: "Round", label: "Round" }, { value: "Miter", label: "Sharp" }, { value: "Bevel", label: "Bevelled" },
    ] },
    { key: "union", label: "One contour around everything", kind: "checkbox" },
  ],
  defaults: { distance: "2", join: "Round", union: true },
  parse: (v) => {
    const distanceMm = num(v, "distance", "Distance");
    if (typeof distanceMm === "string") return fail(distanceMm);
    if (distanceMm === 0) return fail("Distance must not be zero");
    const join = v.join === "Miter" || v.join === "Bevel" ? v.join : "Round";
    return { ok: true, value: { distanceMm, union: v.union === true, join } };
  },
};

export type WeedRequest = { marginMm: number; lineSpacingMm: number | null };

export const WEED_FORM: ToolForm<WeedRequest> = {
  title: "Weed box",
  apply: "Add weed box",
  fields: [
    { key: "margin", label: "Margin", kind: "number", unit: "mm", step: 0.5 },
    { key: "lines", label: "Weed lines across the box", kind: "checkbox" },
    { key: "spacing", label: "Line spacing", kind: "number", unit: "mm", step: 1 },
  ],
  defaults: { margin: "3", lines: true, spacing: "25" },
  parse: (v) => {
    const marginMm = num(v, "margin", "Margin");
    if (typeof marginMm === "string") return fail(marginMm);
    if (marginMm < 0) return fail("Margin must not be negative");
    // A spacing nobody is going to use is not read, so a blank one does not block a plain box.
    if (v.lines !== true) return { ok: true, value: { marginMm, lineSpacingMm: null } };
    const lineSpacingMm = num(v, "spacing", "Line spacing");
    if (typeof lineSpacingMm === "string") return fail(lineSpacingMm);
    if (lineSpacingMm <= 0) return fail("Line spacing must be more than zero");
    return { ok: true, value: { marginMm, lineSpacingMm } };
  },
};

export type CopiesRequest = { cols: number; rows: number; gapXMm: number; gapYMm: number };

export const COPIES_FORM: ToolForm<CopiesRequest> = {
  title: "Copies",
  apply: "Make copies",
  fields: [
    { key: "cols", label: "Columns", kind: "number" },
    { key: "rows", label: "Rows", kind: "number" },
    { key: "gapX", label: "Gap across", kind: "number", unit: "mm", step: 0.5 },
    { key: "gapY", label: "Gap down", kind: "number", unit: "mm", step: 0.5 },
  ],
  defaults: { cols: "2", rows: "1", gapX: "3", gapY: "3" },
  parse: (v) => {
    const cols = count(v, "cols", "Columns");
    if (typeof cols === "string") return fail(cols);
    const rows = count(v, "rows", "Rows");
    if (typeof rows === "string") return fail(rows);
    if (cols * rows < 2) return fail("Copies need more than one column or row");
    const gapXMm = num(v, "gapX", "Gap across");
    if (typeof gapXMm === "string") return fail(gapXMm);
    const gapYMm = num(v, "gapY", "Gap down");
    if (typeof gapYMm === "string") return fail(gapYMm);
    if (gapXMm < 0 || gapYMm < 0) return fail("Gaps must not be negative");
    return { ok: true, value: { cols, rows, gapXMm, gapYMm } };
  },
};
