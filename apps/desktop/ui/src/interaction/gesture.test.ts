// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { apply, isIdentity, rotateAbout, translate, type Pt } from "../render/affine";
import { gestureMatrix, MIN_SIZE_MM } from "./gesture";
import { boxCenter, type Box } from "./selectionBox";

const close = (a: Pt, b: Pt) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};
const none = { shift: false, alt: false };
// 40 × 20 mm, top-left at (10, 20): se corner at (50, 40), centre at (30, 30).
const box: Box = { frame: translate(10, 20), w: 40, h: 20 };

describe("move", () => {
  it("translates by the drag", () => {
    expect(gestureMatrix("move", box, { x: 0, y: 0 }, { x: 3, y: -4 }, none)).toEqual(translate(3, -4));
  });
  it("Shift locks to the longer axis", () => {
    expect(gestureMatrix("move", box, { x: 0, y: 0 }, { x: 3, y: -4 }, { shift: true, alt: false })).toEqual(translate(0, -4));
  });
  it("a press without movement is the identity, which the caller does not commit", () => {
    expect(isIdentity(gestureMatrix("move", box, { x: 5, y: 5 }, { x: 5, y: 5 }, none))).toBe(true);
  });
});

describe("scale", () => {
  it("a corner scales about the opposite corner", () => {
    const m = gestureMatrix("se", box, { x: 50, y: 40 }, { x: 90, y: 60 }, none);
    close(apply(m, { x: 10, y: 20 }), { x: 10, y: 20 });
    close(apply(m, { x: 50, y: 40 }), { x: 90, y: 60 });
  });
  it("an edge scales one axis only", () => {
    const m = gestureMatrix("e", box, { x: 50, y: 30 }, { x: 70, y: 999 }, none);
    close(apply(m, { x: 50, y: 40 }), { x: 70, y: 40 });
  });
  it("is measured from the handle, not from where the press landed", () => {
    // Grabbing 1 mm inside the corner must not change the factor.
    const m = gestureMatrix("se", box, { x: 49, y: 39 }, { x: 89, y: 59 }, none);
    close(apply(m, { x: 50, y: 40 }), { x: 90, y: 60 });
  });
  it("Alt scales about the centre", () => {
    const m = gestureMatrix("se", box, { x: 50, y: 40 }, { x: 60, y: 45 }, { shift: false, alt: true });
    close(apply(m, boxCenter(box)), boxCenter(box));
    close(apply(m, { x: 50, y: 40 }), { x: 60, y: 45 });
  });
  it("Shift keeps the proportions, following the axis that moved most", () => {
    const m = gestureMatrix("se", box, { x: 50, y: 40 }, { x: 90, y: 44 }, { shift: true, alt: false });
    close(apply(m, { x: 50, y: 40 }), { x: 90, y: 60 }); // ×2 both ways
  });
  it("stops at the minimum size rather than flipping", () => {
    const m = gestureMatrix("se", box, { x: 50, y: 40 }, { x: -100, y: 40 }, none);
    const ne = apply(m, { x: 50, y: 20 });
    expect(ne.x - 10).toBeCloseTo(MIN_SIZE_MM, 9);
  });
  it("scales a rotated box along its own axes", () => {
    const r30 = rotateAbout(Math.PI / 6, { x: 0, y: 0 });
    const rotated: Box = { frame: r30, w: 10, h: 4 };
    const grab = apply(r30, { x: 10, y: 2 });
    const along = { x: grab.x + 10 * Math.cos(Math.PI / 6), y: grab.y + 10 * Math.sin(Math.PI / 6) };
    const m = gestureMatrix("e", rotated, grab, along, none);
    close(apply(m, apply(r30, { x: 10, y: 0 })), apply(r30, { x: 20, y: 0 }));
    close(apply(m, apply(r30, { x: 0, y: 4 })), apply(r30, { x: 0, y: 4 }));
  });
});

describe("rotate", () => {
  it("turns about the box centre by the angle swept", () => {
    const c = boxCenter(box);
    const m = gestureMatrix("rotate", box, { x: c.x + 10, y: c.y }, { x: c.x, y: c.y + 10 }, none);
    close(apply(m, c), c);
    close(apply(m, { x: c.x + 10, y: c.y }), { x: c.x, y: c.y + 10 });
  });
  it("Shift snaps to 15° steps", () => {
    const c = boxCenter(box);
    const a = (50 * Math.PI) / 180;
    const m = gestureMatrix("rotate", box, { x: c.x + 10, y: c.y }, { x: c.x + 10 * Math.cos(a), y: c.y + 10 * Math.sin(a) }, { shift: true, alt: false });
    const b = (45 * Math.PI) / 180;
    close(apply(m, { x: c.x + 10, y: c.y }), { x: c.x + 10 * Math.cos(b), y: c.y + 10 * Math.sin(b) });
  });
});
