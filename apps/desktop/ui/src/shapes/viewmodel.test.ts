// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { OFFSET_FORM, WEED_FORM } from "./viewmodel";

describe("OFFSET_FORM", () => {
  it("starts at a 2 mm round outset around everything", () => {
    expect(OFFSET_FORM.parse(OFFSET_FORM.defaults)).toEqual({
      ok: true, value: { distanceMm: 2, union: true, join: "Round" },
    });
  });

  it("takes a negative distance as an inset", () => {
    const r = OFFSET_FORM.parse({ ...OFFSET_FORM.defaults, distance: "-1.5", union: false, join: "Miter" });
    expect(r).toEqual({ ok: true, value: { distanceMm: -1.5, union: false, join: "Miter" } });
  });

  it("refuses a blank, non-numeric or zero distance in words", () => {
    for (const distance of ["", "  ", "abc", "-"]) {
      expect(OFFSET_FORM.parse({ ...OFFSET_FORM.defaults, distance })).toEqual({ ok: false, error: "Distance must be a number" });
    }
    expect(OFFSET_FORM.parse({ ...OFFSET_FORM.defaults, distance: "0" })).toEqual({ ok: false, error: "Distance must not be zero" });
  });

  it("falls back to round corners for a join it does not know", () => {
    const r = OFFSET_FORM.parse({ ...OFFSET_FORM.defaults, join: "Spiky" });
    expect(r.ok && r.value.join).toBe("Round");
  });
});

describe("WEED_FORM", () => {
  it("starts at a 3 mm margin with weed lines", () => {
    expect(WEED_FORM.parse(WEED_FORM.defaults)).toEqual({ ok: true, value: { marginMm: 3, lineSpacingMm: 25 } });
  });

  it("sends no spacing when lines are off, and does not read a blank one", () => {
    expect(WEED_FORM.parse({ margin: "0", lines: false, spacing: "" })).toEqual({ ok: true, value: { marginMm: 0, lineSpacingMm: null } });
  });

  it("refuses a negative margin and a spacing that is not a positive number", () => {
    expect(WEED_FORM.parse({ ...WEED_FORM.defaults, margin: "-1" })).toEqual({ ok: false, error: "Margin must not be negative" });
    expect(WEED_FORM.parse({ ...WEED_FORM.defaults, spacing: "0" })).toEqual({ ok: false, error: "Line spacing must be more than zero" });
    expect(WEED_FORM.parse({ ...WEED_FORM.defaults, spacing: "x" })).toEqual({ ok: false, error: "Line spacing must be a number" });
  });
});
