// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PALETTE, swatchCss } from "./palette";
import { passRowLabel } from "../cut/viewmodel";

describe("palette", () => {
  it("has twelve distinct opaque swatches", () => {
    expect(PALETTE).toHaveLength(12);
    expect(new Set(PALETTE.map((s) => s.rgba)).size).toBe(12);
    expect(new Set(PALETTE.map((s) => s.name)).size).toBe(12);
    for (const s of PALETTE) expect(s.rgba & 0xff).toBe(0xff);
  });

  it("renders the same CSS colour the Cuts row shows for that swatch's pass", () => {
    // The palette and the Cuts panel must agree, or a member picks red and sees a row in a
    // different red. The row's swatch comes from the pass key the planner writes.
    for (const s of PALETTE) {
      const key = `color:${(s.rgba >>> 0).toString(16).padStart(8, "0")}`;
      expect(passRowLabel(key, { presets: [], loaded: true }, "Color").swatch).toBe(swatchCss(s.rgba));
    }
    expect(swatchCss(0x0000ffff)).toBe("#0000ff");
  });
});
