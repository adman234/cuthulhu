// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { alignMoves, canDistribute, distributeMoves, type AlignMode, type Unit } from "./align";

const unit = (id: number, x: number, y: number, w: number, h: number): Unit => ({ ids: [id], bounds: { x, y, w, h } });
// Three units: A 0..10 × 0..10, B 20..24 × 5..25, C 40..60 × 2..6. Selection bounds 0..60 × 0..25.
const A = unit(1, 0, 0, 10, 10);
const B = unit(2, 20, 5, 4, 20);
const C = unit(3, 40, 2, 20, 4);
const artboard = { x: 0, y: 0, w: 330, h: 3000 };
const dx = (moves: ReturnType<typeof alignMoves>, id: number) => moves.find((m) => m.ids[0] === id)?.m[4] ?? 0;
const dy = (moves: ReturnType<typeof alignMoves>, id: number) => moves.find((m) => m.ids[0] === id)?.m[5] ?? 0;

describe("alignMoves, several units against their own bounds", () => {
  const cases: [AlignMode, number[], "x" | "y"][] = [
    ["left", [0, -20, -40], "x"],
    ["hcenter", [25, 8, -20], "x"], // centre of 0..60 is 30
    ["right", [50, 36, 0], "x"],
    ["top", [0, -5, -2], "y"],
    ["vmiddle", [7.5, -2.5, 8.5], "y"], // middle of 0..25 is 12.5
    ["bottom", [15, 0, 19], "y"],
  ];
  for (const [mode, expected, axis] of cases) {
    it(`${mode} moves each unit on ${axis} only`, () => {
      const moves = alignMoves([A, B, C], mode, artboard);
      const got = [1, 2, 3].map((id) => (axis === "x" ? dx(moves, id) : dy(moves, id)));
      expected.forEach((e, i) => expect(got[i]).toBeCloseTo(e, 9));
      for (const mv of moves) expect(axis === "x" ? mv.m[5] : mv.m[4]).toBe(0);
    });
  }

  it("leaves out units that would not move", () => {
    expect(alignMoves([A, B, C], "left", artboard).map((m) => m.ids[0])).toEqual([2, 3]);
  });
});

describe("alignMoves, one unit against the artboard", () => {
  it("centres a single unit on the mat", () => {
    const moves = alignMoves([B], "hcenter", artboard);
    expect(dx(moves, 2)).toBeCloseTo(165 - 22, 9);
  });

  it("does nothing with no units, or one unit and no artboard", () => {
    expect(alignMoves([], "left", artboard)).toEqual([]);
    expect(alignMoves([B], "left", null)).toEqual([]);
  });
});

describe("distributeMoves", () => {
  it("keeps the outermost units and makes the gaps equal", () => {
    // Span 0..60, sizes 10 + 4 + 20 = 34, so two gaps of 13: B's left goes to 23 (+3).
    const moves = distributeMoves([A, B, C], "x");
    expect(moves.map((m) => m.ids[0])).toEqual([2]);
    expect(dx(moves, 2)).toBeCloseTo(3, 9);
  });

  it("overlaps evenly when the units are longer than their span", () => {
    // A 0..10, D 2..32 (reaches furthest, so it stays), E 15..25 goes between: span 0..32, sizes
    // 50, gaps (32 - 50) / 2 = -9, so E's left goes to 10 - 9 = 1.
    const D = unit(4, 2, 0, 30, 1);
    const E = unit(5, 15, 0, 10, 1);
    const moves = distributeMoves([A, D, E], "x");
    expect(moves.map((m) => m.ids[0])).toEqual([5]);
    expect(dx(moves, 5)).toBeCloseTo(1 - 15, 9);
  });

  it("keeps the unit reaching furthest, not the one starting last", () => {
    // X 0..10, Y 5..50, Z 20..30: Y is the far end, Z goes between. Span 0..50, sizes 65, gaps
    // -7.5, so Z's left goes to 2.5 and Y stays where it is.
    const X = unit(9, 0, 0, 10, 1);
    const Y = unit(10, 5, 0, 45, 1);
    const Z = unit(11, 20, 0, 10, 1);
    const moves = distributeMoves([X, Y, Z], "x");
    expect(moves.map((m) => m.ids[0])).toEqual([11]);
    expect(dx(moves, 11)).toBeCloseTo(2.5 - 20, 9);
  });

  it("moves nothing when one unit spans the whole range", () => {
    // There is no gap to equalise; a span from the last-starting unit threw B past C here.
    const W = unit(12, 0, 0, 100, 1);
    expect(distributeMoves([W, unit(13, 10, 0, 10, 1), unit(14, 20, 0, 10, 1)], "x")).toEqual([]);
  });

  it("leaves out a move that is not a finite number", () => {
    const broken = unit(15, NaN, 0, 10, 1);
    expect(alignMoves([A, broken], "left", artboard)).toEqual([]);
  });

  it("orders units with the same start by document order", () => {
    const P = unit(6, 0, 0, 2, 1);
    const Q = unit(7, 0, 0, 4, 1);
    const R = unit(8, 20, 0, 2, 1);
    // P first (earlier in the list), Q in the middle: span 0..22, sizes 8, gaps 7, so Q starts at 9.
    expect(dx(distributeMoves([P, Q, R], "x"), 7)).toBeCloseTo(9, 9);
  });

  it("needs three units", () => {
    expect(distributeMoves([A, B], "x")).toEqual([]);
  });

  it("works on y with the same rule", () => {
    // Tops: A 0..10, C 2..6, B 5..25. Span 0..25, sizes 34, gaps -4.5: C's top goes to 5.5 (+3.5).
    expect(dy(distributeMoves([A, B, C], "y"), 3)).toBeCloseTo(3.5, 9);
  });
});

describe("canDistribute", () => {
  it("says no to fewer than three units, and to one that spans the rest on that axis only", () => {
    const plate = unit(20, 0, 0, 100, 5); // spans x, but not y: the others sit below it
    const p1 = unit(21, 10, 10, 10, 10);
    const p2 = unit(22, 40, 30, 10, 10);
    expect(canDistribute([A, B], "x")).toBe(false);
    expect(canDistribute([A, B, C], "x")).toBe(true);
    expect(canDistribute([plate, p1, p2], "x")).toBe(false);
    expect(canDistribute([plate, p1, p2], "y")).toBe(true);
  });

  it("finds a spanning unit that shares its start with another, in either document order", () => {
    const narrow = unit(23, 0, 0, 5, 1);
    const plate = unit(24, 0, 0, 100, 1);
    const piece = unit(25, 10, 0, 10, 1);
    expect(canDistribute([narrow, plate, piece], "x")).toBe(false);
    expect(canDistribute([plate, narrow, piece], "x")).toBe(false);
    expect(distributeMoves([narrow, plate, piece], "x")).toEqual([]);
  });
});
