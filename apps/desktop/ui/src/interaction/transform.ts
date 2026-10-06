// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Scene, SceneNode } from "../render/hittest";
import { compose, transformBounds, type Pt } from "../render/affine";

export type { Pt };
export type Matrix = Affine6; // a b c d e f

export function dragMatrix(start: Pt, cur: Pt): Matrix {
  return [1, 0, 0, 1, cur.x - start.x, cur.y - start.y];
}

/** Previews `m` on the selected nodes with no round trip. Any affine, not only a translation:
 *  handles scale and rotate through here, and the preview has to be the matrix the commit sends. */
export function applyOptimistic(scene: Scene, ids: number[], m: Matrix): Scene {
  // A Set, because this runs every drag frame and a marquee can select thousands.
  const moving = new Set(ids);
  return { nodes: scene.nodes.map((n) => (moving.has(n.id) ? transformNode(n, m) : n)) };
}

function transformNode(n: SceneNode, m: Matrix): SceneNode {
  if (n.world && n.local) {
    const world = compose(n.world, m);
    return { ...n, world, bounds: transformBounds(world, n.local) };
  }
  return { ...n, world: n.world ? compose(n.world, m) : n.world, bounds: transformBounds(m, n.bounds) };
}
export type DeltaOp = { op: "add" | "update" | "remove"; nodeId: number; patch?: any };
export function reconcile(scene: Scene, delta: DeltaOp[]): Scene {
  let nodes = scene.nodes.slice();
  for (const d of delta) {
    if (d.op === "update") nodes = nodes.map(n => n.id === d.nodeId ? { ...n, ...d.patch } : n);
    else if (d.op === "remove") nodes = nodes.filter(n => n.id !== d.nodeId);
    else if (d.op === "add") nodes.push(d.patch);
  }
  return { nodes };
}
