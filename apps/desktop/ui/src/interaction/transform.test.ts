// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { applyOptimistic, reconcile, gestureScene } from "./transform";
import { rotateAbout } from "../render/affine";
import type { Affine6 } from "../render/hittest";

describe("optimistic transform", () => {
  it("applyOptimistic offsets only selected node bounds", () => {
    const scene = { nodes: [
      { id: 1, bounds: { x: 0, y: 0, w: 4, h: 4 } },
      { id: 2, bounds: { x: 0, y: 0, w: 4, h: 4 } },
    ]};
    const out = applyOptimistic(scene, [2], [1, 0, 0, 1, 5, 0]);
    expect(out.nodes[1].bounds.x).toBe(5);
    expect(out.nodes[0].bounds.x).toBe(0);
  });
  it("reconcile applies an update op from the authoritative delta", () => {
    const scene = { nodes: [{ id: 1, bounds: { x: 0, y: 0, w: 4, h: 4 } }] };
    const out = reconcile(scene, [{ op: "update", nodeId: 1, patch: { bounds: { x: 9, y: 0, w: 4, h: 4 } } }]);
    expect(out.nodes[0].bounds.x).toBe(9);
  });
  it("applyOptimistic nudges the world transform when present", () => {
    const scene = {
      nodes: [{ id: 1, bounds: { x: 0, y: 0, w: 4, h: 4 },
                shape: { t: "rect" as const, w: 4, h: 4 },
                world: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number] }],
    };
    const out = applyOptimistic(scene, [1], [1, 0, 0, 1, 7, 3]);
    expect(out.nodes[0].world).toEqual([1, 0, 0, 1, 7, 3]);
    expect(out.nodes[0].bounds.x).toBe(7);
  });
  it("applyOptimistic previews a rotation through world and bounds", () => {
    const scene = {
      nodes: [{ id: 1, bounds: { x: 0, y: 0, w: 10, h: 10 }, local: { x: 0, y: 0, w: 10, h: 10 },
                world: [1, 0, 0, 1, 0, 0] as Affine6 }],
    };
    const out = applyOptimistic(scene, [1], rotateAbout(Math.PI / 4, { x: 5, y: 5 }));
    expect(out.nodes[0].bounds.w).toBeCloseTo(10 * Math.SQRT2, 9);
    expect(out.nodes[0].world![1]).toBeCloseTo(Math.SQRT1_2, 9);
  });
});

describe("gestureScene", () => {
  const committed = { nodes: [{ id: 1, bounds: { x: 0, y: 0, w: 4, h: 4 } }] };
  const preview = applyOptimistic(committed, [1], [1, 0, 0, 1, 10, 0]);

  it("starts the next gesture from the preview while its commit is still in flight", () => {
    // Without this a second press before the snapshot lands finds the handles where the shape
    // used to be, and its preview jumps back. CodeRabbit on #298.
    expect(gestureScene({ base: committed, preview }, committed)).toBe(preview);
  });

  it("drops the preview once a snapshot has replaced the scene it was built on", () => {
    const refreshed = { nodes: [{ id: 1, bounds: { x: 10, y: 0, w: 4, h: 4 } }] };
    expect(gestureScene({ base: committed, preview }, refreshed)).toBe(refreshed);
  });

  it("uses the committed scene when nothing is pending", () => {
    expect(gestureScene(null, committed)).toBe(committed);
  });
});
