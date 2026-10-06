// SPDX-License-Identifier: GPL-3.0-or-later
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

export function hitTest(scene: Scene, x: number, y: number): number | null {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    // topmost last
    const b = scene.nodes[i].bounds;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return scene.nodes[i].id;
  }
  return null;
}
