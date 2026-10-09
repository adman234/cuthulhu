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
