// SPDX-License-Identifier: GPL-3.0-or-later
import { apply, invert } from "./affine";

export type Bounds = { x: number; y: number; w: number; h: number };
export type Affine6 = [number, number, number, number, number, number];
export type ShapeGeom =
  | { t: "rect"; w: number; h: number }
  | { t: "ellipse"; rx: number; ry: number }
  | { t: "path"; d: string };
/** `bounds` is the world-space axis-aligned box — what a marquee tests, and all a node without
 *  geometry has. `local` is the shape's own box before `world`: what a click is tested against,
 *  so a rotated shape is hit where it is drawn rather than across its whole bounding box. */
export type SceneNode = { id: number; bounds: Bounds; local?: Bounds; shape?: ShapeGeom; world?: Affine6 };
export type Scene = { nodes: SceneNode[] };

/** Topmost node under (x, y). Everything is world mm, `tol` included: the caller divides a CSS-px
 *  constant by the view scale, so a thin line is as easy to click zoomed out as zoomed in. */
export function hitTest(scene: Scene, x: number, y: number, tol = 0): number | null {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    // topmost last
    if (contains(scene.nodes[i], x, y, tol)) return scene.nodes[i].id;
  }
  return null;
}

// ponytail: tests the shape's box, not its outline, so clicking the hole of an "O" selects it.
// Ceiling: fine for primitives and solid shapes. Upgrade: `isPointInStroke` on the renderer's
// cached Path2D with a widened lineWidth, once someone reports it.
function contains(n: SceneNode, x: number, y: number, tol: number): boolean {
  if (n.local && n.world) {
    const inv = invert(n.world);
    if (!inv) return false;
    const q = apply(inv, { x, y });
    // How far local x (and y) can move when the world point moves `tol` in any direction: the
    // inverse's rows, not 1 / the forward axis lengths, which only agree when the axes stay
    // perpendicular — a rotated node under a non-uniformly scaled Group is sheared.
    const tx = tol * Math.hypot(inv[0], inv[2]);
    const ty = tol * Math.hypot(inv[1], inv[3]);
    const b = n.local;
    return q.x >= b.x - tx && q.x <= b.x + b.w + tx && q.y >= b.y - ty && q.y <= b.y + b.h + ty;
  }
  const b = n.bounds;
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}
