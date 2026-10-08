// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Scene, SceneNode } from "../render/hittest";
import { compose, transformBounds } from "../render/affine";

export type Matrix = Affine6; // a b c d e f

/** Previews `m` on the selected nodes with no round trip. Any affine, not only a translation:
 *  handles scale and rotate through here, and the preview has to be the matrix the commit sends. */
export function applyOptimistic(scene: Scene, ids: number[], m: Matrix): Scene {
  // A Set, because this runs every drag frame and a marquee can select thousands.
  const moving = new Set(ids);
  return { nodes: scene.nodes.map((n) => (moving.has(n.id) ? transformNode(n, m) : n)) };
}

/** Several previews at once, in one pass over the scene: one matrix per entry's shapes. Folding
 *  `applyOptimistic` over the entries copied the whole scene once per entry, so aligning a few
 *  thousand separate pieces blocked the UI before anything was sent (Copilot on #301). The
 *  entries must not share a shape; align's units are disjoint, as `outermost` keeps them. */
export function applyMoves(scene: Scene, entries: { shapes: number[]; m: Matrix }[]): Scene {
  const by = new Map<number, Matrix>();
  for (const { shapes, m } of entries) for (const id of shapes) by.set(id, m);
  return {
    nodes: scene.nodes.map((n) => {
      const m = by.get(n.id);
      return m ? transformNode(n, m) : n;
    }),
  };
}

/** A commit's preview, standing in for the committed scene until the snapshot that includes the
 *  commit has rendered: `retireAt` is that snapshot's revision, `Infinity` while the commit is
 *  still on the wire. */
export type PendingPreview = { preview: Scene; retireAt: number };

/** The scene the next gesture or field edit starts from. Between a commit and the snapshot that
 *  includes it, the screen shows the preview while the committed scene still holds older geometry.
 *  Retiring by revision rather than on any new scene matters when edits queue: the snapshot of an
 *  earlier commit can render while a later one is on the wire, and retiring the later preview then
 *  computed the next edit from geometry the backend had already left (Copilot on #298). */
export function gestureScene(pending: PendingPreview | null, committed: Scene, committedRev: number): Scene {
  return pending && committedRev < pending.retireAt ? pending.preview : committed;
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
