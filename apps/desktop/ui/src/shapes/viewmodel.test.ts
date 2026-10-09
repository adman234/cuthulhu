// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { COPIES_FORM, NEST_FORM, OFFSET_FORM, WEED_FORM, nestRefusal } from "./viewmodel";

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

describe("COPIES_FORM", () => {
  it("starts at one copy beside the original, 3 mm apart", () => {
    expect(COPIES_FORM.parse(COPIES_FORM.defaults)).toEqual({ ok: true, value: { cols: 2, rows: 1, gapXMm: 3, gapYMm: 3 } });
  });

  it("refuses counts that are not whole numbers of at least 1", () => {
    for (const cols of ["0", "1.5", "-2", ""]) {
      const r = COPIES_FORM.parse({ ...COPIES_FORM.defaults, cols });
      expect(r.ok).toBe(false);
    }
    expect(COPIES_FORM.parse({ ...COPIES_FORM.defaults, cols: "1.5" })).toEqual({ ok: false, error: "Columns must be a whole number of at least 1" });
  });

  it("refuses a grid of one cell and a negative gap", () => {
    expect(COPIES_FORM.parse({ ...COPIES_FORM.defaults, cols: "1", rows: "1" })).toEqual({ ok: false, error: "Copies need more than one column or row" });
    expect(COPIES_FORM.parse({ ...COPIES_FORM.defaults, gapY: "-1" })).toEqual({ ok: false, error: "Gaps must not be negative" });
  });
});

describe("NEST_FORM", () => {
  it("starts at a 3 mm gap with turning allowed", () => {
    expect(NEST_FORM.parse(NEST_FORM.defaults)).toEqual({ ok: true, value: { gapMm: 3, allowTurn: true } });
  });

  it("refuses a negative or missing gap", () => {
    expect(NEST_FORM.parse({ gap: "-1", turn: false })).toEqual({ ok: false, error: "Gap must not be negative" });
    expect(NEST_FORM.parse({ gap: "", turn: false })).toEqual({ ok: false, error: "Gap must be a number" });
  });
});

describe("nestRefusal", () => {
  it("names pieces too wide, and whether turning was tried", () => {
    expect(nestRefusal({ tooWide: [[1]], tooLong: false }, true)).toBe("Not nested: a piece is wider than the media even turned");
    expect(nestRefusal({ tooWide: [[1], [2]], tooLong: true }, false)).toBe("Not nested: 2 pieces are wider than the media");
  });

  it("names a pack that runs past the media, and is null when it fits", () => {
    expect(nestRefusal({ tooWide: [], tooLong: true }, true)).toBe("Not nested: the packed pieces run past the end of the media");
    expect(nestRefusal({ tooWide: [], tooLong: false }, true)).toBeNull();
  });
});
