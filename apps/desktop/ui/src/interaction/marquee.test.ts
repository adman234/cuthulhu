// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { marqueeHits, marqueeSelection, normalizeRect, toggleId } from "./marquee";

describe("marquee", () => {
  it("normalizes a band dragged in any direction", () => {
    expect(normalizeRect({ x: 5, y: 1 }, { x: 1, y: 4 })).toEqual({ x: 1, y: 1, w: 4, h: 3 });
  });

  it("selects what the band touches, not only what it contains", () => {
    const scene = { nodes: [
      { id: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } },
      { id: 2, bounds: { x: 8, y: 8, w: 10, h: 10 } },
      { id: 3, bounds: { x: 50, y: 50, w: 1, h: 1 } },
    ] };
    expect(marqueeHits(scene, { x: 9, y: 9, w: 1, h: 1 })).toEqual([1, 2]);
  });

  it("adds with Shift, keeping order and dropping duplicates", () => {
    expect(marqueeSelection([3, 1], [1, 2], true)).toEqual([3, 1, 2]);
  });

  it("replaces without Shift", () => {
    expect(marqueeSelection([3, 1], [2], false)).toEqual([2]);
  });

  it("toggleId adds a missing id and removes a present one", () => {
    expect(toggleId([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleId([1, 2], 1)).toEqual([2]);
  });
});
