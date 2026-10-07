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

/** Units that would not move are left out, so a click that changes nothing commits nothing. So is
 *  a non-finite move: it crosses IPC as null and comes back as an unreadable error. */
function moved(entries: [Unit, number][], axis: Axis): Move[] {
  return entries.filter(([, d]) => Number.isFinite(d) && d !== 0).map(([u, d]) => ({ ids: u.ids, m: along(axis, d) }));
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

const end = (u: Unit, a: Axis) => start(u.bounds, a) + size(u.bounds, a);

/** How a distribute is anchored, or null when it has nothing to do.
 *  - "ends": the unit that starts first and the unit that reaches furthest stay put, and the rest
 *    go between them.
 *  - "frame": one unit spans all the others, as a weed border or backing plate does when the
 *    whole design is selected. It stays put and the rest are spaced inside it, with the margins
 *    at its edges equal to the gaps between them. Sure Cuts A Lot offers the same as a separate
 *    "Distribute to Selection Below" mode; here the selection says which is meant, so there is no
 *    mode to set.
 *  Null for fewer than three units, or when more than one unit spans the rest (stacked copies of
 *  one shape), since no one of them is the frame. */
type Anchors =
  | { kind: "ends"; order: Unit[]; li: number }
  | { kind: "frame"; frame: Unit; inner: Unit[] };

function anchors(units: Unit[], axis: Axis): Anchors | null {
  if (units.length < 3) return null;
  // Array.prototype.sort is stable, so document order breaks ties.
  const order = [...units].sort((a, b) => start(a.bounds, axis) - start(b.bounds, axis));
  // Of the units reaching furthest, the one that starts last, so it is never the first as well
  // unless it spans the rest.
  let li = 0;
  order.forEach((u, i) => {
    if (end(u, axis) >= end(order[li], axis)) li = i;
  });
  // Spanning is asked of every unit, not read off the ends: a plate sharing its start with a piece
  // earlier in the document sorts second, and was taken as the far end (code-reviewer).
  const lo = start(order[0].bounds, axis);
  const hi = end(order[li], axis);
  const spanning = order.filter((u) => start(u.bounds, axis) <= lo && end(u, axis) >= hi);
  if (spanning.length > 1) return null;
  if (spanning.length === 1) {
    const frame = spanning[0];
    return { kind: "frame", frame, inner: order.filter((u) => u !== frame) };
  }
  return { kind: "ends", order, li };
}

/** Whether distribute can act, so the button says so rather than doing nothing. */
export function canDistribute(units: Unit[], axis: Axis): boolean {
  return anchors(units, axis) !== null;
}

/** Equal gaps between neighbours, because gaps are what a weeder works between; see `Anchors` for
 *  what stays put. Taking the far end from whichever unit starts last threw small pieces past each
 *  other when a wide one started first (code-reviewer). When the units are longer than the room
 *  they have, the gaps come out negative and they overlap evenly, which is still the arithmetic
 *  answer. */
export function distributeMoves(units: Unit[], axis: Axis): Move[] {
  const a = anchors(units, axis);
  if (!a) return [];
  // The units that stay put are never listed, so float drift cannot turn them into a move.
  if (a.kind === "frame") {
    const room = size(a.frame.bounds, axis) - a.inner.reduce((s, u) => s + size(u.bounds, axis), 0);
    return place(a.inner, start(a.frame.bounds, axis), room / (a.inner.length + 1), axis);
  }
  const { order, li } = a;
  const first = order[0];
  const middle = order.filter((_, i) => i !== 0 && i !== li);
  const span = end(order[li], axis) - start(first.bounds, axis);
  const total = order.reduce((s, u) => s + size(u.bounds, axis), 0);
  const gap = (span - total) / (order.length - 1);
  return place(middle, end(first, axis), gap, axis);
}

/** Lays `units` out in order from `from`, with `gap` before each one. */
function place(units: Unit[], from: number, gap: number, axis: Axis): Move[] {
  const entries: [Unit, number][] = [];
  let cursor = from + gap;
  for (const u of units) {
    entries.push([u, cursor - start(u.bounds, axis)]);
    cursor += size(u.bounds, axis) + gap;
  }
  return moved(entries, axis);
}
