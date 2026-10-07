// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { rotateAbout, translate } from "../render/affine";
import { SNAP_PX, snapMove, snapScale, snapTargets, type Targets } from "./snap";
import type { Box } from "./selectionBox";

// Rect A (moving) at 0..10, rect B at 30..40, on a Cameo-sized artboard. Tolerance 1 mm.
const A = { id: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } };
const B = { id: 2, bounds: { x: 30, y: 0, w: 10, h: 10 } };
const artboard = { x: 0, y: 0, w: 330, h: 3000 };
const scene = { nodes: [A, B] };
const boxA: Box = { frame: translate(0, 0), w: 10, h: 10 };
const t = snapTargets(scene, [1], artboard);

describe("snapTargets", () => {
  it("leaves out the shapes being moved and includes the artboard's lines", () => {
    const xs = t.x.map((l) => l.v);
    expect(xs).toEqual(expect.arrayContaining([30, 35, 40, 0, 165, 330]));
    expect(xs).not.toContain(5); // A's centre: a selection never snaps to itself
  });

  it("sorts each axis by coordinate, so a pointer move is a binary search", () => {
    for (const lines of [t.x, t.y]) {
      for (let i = 1; i < lines.length; i++) expect(lines[i].v).toBeGreaterThanOrEqual(lines[i - 1].v);
    }
  });
});

describe("snapMove", () => {
  it("butts A's right edge against B when it lands within reach", () => {
    const r = snapMove(boxA, { x: 5, y: 5 }, { x: 24.6, y: 5 }, t, 1, false);
    expect(r.point.x).toBeCloseTo(25, 9);
    expect(r.point.y).toBeCloseTo(5, 9);
  });

  it("leaves an axis alone when the nearest line is out of reach", () => {
    expect(snapMove(boxA, { x: 5, y: 5 }, { x: 22, y: 5 }, t, 1, false).point.x).toBe(22);
  });

  it("prefers the centre line when two of the box's lines are equally close", () => {
    const tie: Targets = { x: [{ v: -0.5, lo: 0, hi: 10 }, { v: 5.5, lo: 0, hi: 10 }], y: [] };
    expect(snapMove(boxA, { x: 5, y: 5 }, { x: 5, y: 5 }, tie, 1, false).point.x).toBeCloseTo(5.5, 9);
  });

  it("with Shift's axis lock snaps only the free axis", () => {
    const r = snapMove(boxA, { x: 5, y: 5 }, { x: 24.6, y: 5.4 }, t, 1, true);
    expect(r.point.x).toBeCloseTo(25, 9);
    expect(r.point.y).toBe(5.4); // y would snap back to 5 unlocked; locked, it is not this axis's call
  });

  it("draws one guide along the snapped line, spanning A and B", () => {
    const r = snapMove(boxA, { x: 5, y: 5 }, { x: 24.6, y: 5 }, t, 1, false);
    const g = r.guides.find((s) => Math.abs(s.a.x - 30) < 1e-9 && s.a.x === s.b.x);
    expect(g).toBeDefined();
    expect(Math.min(g!.a.y, g!.b.y)).toBeCloseTo(0, 9);
    expect(Math.max(g!.a.y, g!.b.y)).toBeCloseTo(10, 9);
  });

  it("reaches farther in mm when zoomed out, because the reach is CSS px", () => {
    // A dragged 17 mm stops 3 mm short of B: out of reach at 6 px/mm, within it at 1.5 px/mm.
    const at = (scale: number) => snapMove(boxA, { x: 5, y: 5 }, { x: 22, y: 5 }, t, SNAP_PX / scale, false).point.x;
    expect(at(6)).toBe(22);
    expect(at(1.5)).toBeCloseTo(25, 9);
  });
});

describe("snapScale", () => {
  it("snaps the edge an e handle moves", () => {
    const r = snapScale(boxA, "e", { x: 10, y: 5 }, { x: 29.6, y: 5 }, t, 1);
    expect(r.point.x).toBeCloseTo(30, 9);
    expect(r.point.y).toBe(5);
  });

  it("leaves x alone for an n handle, which moves only y", () => {
    const r = snapScale(boxA, "n", { x: 5, y: 0 }, { x: 5.3, y: -0.4 }, t, 1);
    expect(r.point.x).toBe(5.3);
    expect(r.point.y).toBeCloseTo(0, 9);
  });

  it("does not snap a rotated box, whose edges are not axis-aligned", () => {
    const rotated: Box = { frame: rotateAbout(Math.PI / 6, { x: 0, y: 0 }), w: 10, h: 10 };
    const cur = { x: 29.6, y: 5 };
    expect(snapScale(rotated, "e", { x: 10, y: 5 }, cur, t, 1)).toEqual({ point: cur, guides: [] });
  });
});
