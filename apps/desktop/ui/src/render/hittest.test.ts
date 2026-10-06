// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { hitTest } from "./hittest";
import { rotateAbout, transformBounds } from "./affine";

describe("hitTest", () => {
  it("returns the topmost node whose bounds contain the point", () => {
    const scene = {
      nodes: [
        { id: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 2, bounds: { x: 5, y: 5, w: 10, h: 10 } },
      ],
    };
    expect(hitTest(scene, 7, 7)).toBe(2); // 2 is on top and contains the point
    expect(hitTest(scene, 1, 1)).toBe(1);
    expect(hitTest(scene, 99, 99)).toBe(null);
  });

  // A 10 mm square turned 45° about its centre: its axis-aligned bounds start at 5 - 5√2 ≈ -2.07.
  const turn = rotateAbout(Math.PI / 4, { x: 5, y: 5 });
  const diamond = {
    id: 7,
    bounds: transformBounds(turn, { x: 0, y: 0, w: 10, h: 10 }),
    local: { x: 0, y: 0, w: 10, h: 10 },
    world: turn,
  };

  it("tests a rotated shape in its own frame, not across its bounding box", () => {
    const scene = { nodes: [diamond] };
    expect(hitTest(scene, 5, 5)).toBe(7);
    expect(hitTest(scene, -1, -1)).toBe(null); // inside the bounds, outside the diamond
  });

  it("widens by a world-space tolerance", () => {
    const scene = { nodes: [diamond] };
    const x = 5 - 5 * Math.SQRT2 - 1; // 1 mm beyond the left vertex
    expect(hitTest(scene, x, 5, 0)).toBe(null);
    expect(hitTest(scene, x, 5, 2)).toBe(7);
  });

  it("a node scaled to nothing cannot be hit", () => {
    const flat = { id: 8, bounds: { x: 0, y: 0, w: 0, h: 0 }, local: { x: 0, y: 0, w: 10, h: 10 },
                   world: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number] };
    expect(hitTest({ nodes: [flat] }, 0, 0, 5)).toBe(null);
  });
});
