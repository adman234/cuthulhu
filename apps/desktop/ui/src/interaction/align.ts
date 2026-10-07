// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Bounds } from "../render/hittest";
import { translate } from "../render/affine";

/** What one align or distribute click moves as a piece: a selected id, with the world bounds of
 *  every shape it moves, so a Group lines up by all of its shapes, as a drag would move it. */
export type Unit = { ids: number[]; bounds: Bounds };
/** One unit's translation, in the shape `commit_transforms` takes. */
export type Move = { ids: number[]; m: Affine6 };
export type AlignMode = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";
export type Axis = "x" | "y";

const AXIS: Record<AlignMode, Axis> = {
  left: "x", hcenter: "x", right: "x", top: "y", vmiddle: "y", bottom: "y",
};
/** Where on the unit's span the mode lines up: 0 at the start edge, 1 at the far edge. */
const AT: Record<AlignMode, number> = { left: 0, hcenter: 0.5, right: 1, top: 0, vmiddle: 0.5, bottom: 1 };

const start = (b: Bounds, a: Axis) => (a === "x" ? b.x : b.y);
const size = (b: Bounds, a: Axis) => (a === "x" ? b.w : b.h);
const along = (a: Axis, d: number): Affine6 => (a === "x" ? translate(d, 0) : translate(0, d));

function union(units: Unit[]): Bounds {
  const x0 = Math.min(...units.map((u) => u.bounds.x));
  const y0 = Math.min(...units.map((u) => u.bounds.y));
  const x1 = Math.max(...units.map((u) => u.bounds.x + u.bounds.w));
  const y1 = Math.max(...units.map((u) => u.bounds.y + u.bounds.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Units that would not move are left out, so a click that changes nothing commits nothing. */
function moved(entries: [Unit, number][], axis: Axis): Move[] {
  return entries.filter(([, d]) => d !== 0).map(([u, d]) => ({ ids: u.ids, m: along(axis, d) }));
}

/** Two or more units line up against their own bounds; a lone unit lines up against the artboard,
 *  since aligning one thing to itself would do nothing.
 *  // ponytail: no key object, so five pieces cannot be aligned to a sixth that stays put.
 *  Upgrade: a key object picked by clicking a selected unit again, as in Illustrator. */
export function alignMoves(units: Unit[], mode: AlignMode, artboard: Bounds | null): Move[] {
  const target = units.length >= 2 ? union(units) : artboard;
  if (units.length === 0 || !target) return [];
  const axis = AXIS[mode];
  const at = AT[mode];
  const line = start(target, axis) + at * size(target, axis);
  return moved(units.map((u) => [u, line - (start(u.bounds, axis) + at * size(u.bounds, axis))]), axis);
}

/** Equal gaps between neighbours, because gaps are what a weeder works between. The first and
 *  last unit in start-edge order stay put; when the units are longer than that span the gaps come
 *  out negative and they overlap evenly, which is still the arithmetic answer. */
export function distributeMoves(units: Unit[], axis: Axis): Move[] {
  if (units.length < 3) return [];
  // Array.prototype.sort is stable, so document order breaks ties.
  const order = [...units].sort((a, b) => start(a.bounds, axis) - start(b.bounds, axis));
  const first = order[0].bounds;
  const last = order[order.length - 1].bounds;
  const span = start(last, axis) + size(last, axis) - start(first, axis);
  const total = order.reduce((s, u) => s + size(u.bounds, axis), 0);
  const gap = (span - total) / (order.length - 1);
  const entries: [Unit, number][] = [];
  let cursor = start(first, axis);
  for (const u of order) {
    entries.push([u, cursor - start(u.bounds, axis)]);
    cursor += size(u.bounds, axis) + gap;
  }
  // The outer two land where they are by construction; dropping them exactly keeps float drift
  // from turning a no-op into a move.
  return moved(entries.slice(1, -1), axis);
}
