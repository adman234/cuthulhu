// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { OFFSET_FORM } from "./viewmodel";

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
