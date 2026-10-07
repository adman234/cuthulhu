// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bounds, Scene } from "../render/hittest";
import { transformBounds, type Pt } from "../render/affine";
import { HANDLE_UNIT, handleWorld, type Box, type ScaleHandle } from "./selectionBox";

/** Reach of a snap in CSS px. Divided by the view scale at use, like the handle sizes, so it
 *  feels the same at every zoom. */
export const SNAP_PX = 6;

/** A line something can snap to: its coordinate, and the extent along the other axis of whatever
 *  owns it, which is what its guide is drawn across. */
export type Line = { v: number; lo: number; hi: number };
/** Vertical lines (`x`) and horizontal lines (`y`), each sorted by coordinate. */
export type Targets = { x: Line[]; y: Line[] };
/** A guide segment, in world mm. */
export type Guide = { a: Pt; b: Pt };
/** The pointer to hand to `gestureMatrix`, and the guides to draw for it. */
export type SnapResult = { point: Pt; guides: Guide[] };

const EPS = 1e-9;

export function boxBounds(box: Box): Bounds {
  return transformBounds(box.frame, { x: 0, y: 0, w: box.w, h: box.h });
}

function linesOf(b: Bounds, axis: "x" | "y"): Line[] {
  return axis === "x"
    ? [b.x, b.x + b.w / 2, b.x + b.w].map((v) => ({ v, lo: b.y, hi: b.y + b.h }))
    : [b.y, b.y + b.h / 2, b.y + b.h].map((v) => ({ v, lo: b.x, hi: b.x + b.w }));
}

/** Every line a gesture may snap to: each shape's and the artboard's edges and centres. Gathered
 *  once per gesture, since only the selection moves during one, and the selection itself is left
 *  out so it never snaps to where it already is.
 *  ponytail: a rotated target contributes its axis-aligned bounds, not its outline. Ceiling:
 *  snapping to a rotated shape's corner is approximate. Upgrade: add its oriented corners. */
export function snapTargets(scene: Scene, excluded: number[], artboard: Bounds | null): Targets {
  const skip = new Set(excluded);
  const boxes = scene.nodes.filter((n) => !skip.has(n.id)).map((n) => n.bounds);
  if (artboard) boxes.push(artboard);
  const byV = (p: Line, q: Line) => p.v - q.v;
  return {
    x: boxes.flatMap((b) => linesOf(b, "x")).sort(byV),
    y: boxes.flatMap((b) => linesOf(b, "y")).sort(byV),
  };
}

/** Every line at the coordinate nearest `v`, if it is within `tol`; a distance tie goes to the
 *  lower coordinate, so the pick does not flicker between frames. */
function nearest(lines: Line[], v: number, tol: number): Line[] | null {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].v < v) lo = mid + 1;
    else hi = mid;
  }
  const below = lo > 0 ? lines[lo - 1].v : null;
  const above = lo < lines.length ? lines[lo].v : null;
  let pick: number | null = null;
  if (below !== null && v - below <= tol) pick = below;
  if (above !== null && above - v <= tol && (pick === null || above - v < v - pick - EPS)) pick = above;
  if (pick === null) return null;
  // The lines sharing that coordinate sit together around `lo` in the sorted list.
  const at = pick;
  let i = lo > 0 && Math.abs(lines[lo - 1].v - at) < EPS ? lo - 1 : lo;
  while (i > 0 && Math.abs(lines[i - 1].v - at) < EPS) i--;
  const out: Line[] = [];
  for (let j = i; j < lines.length && Math.abs(lines[j].v - at) < EPS; j++) out.push(lines[j]);
  return out;
}

type AxisHit = { delta: number; at: number; lines: Line[] };

/** Snaps whichever candidate lands nearest a line. Candidates come in priority order (centre
 *  first), and a later one wins only if strictly nearer, so a tie keeps the centre. */
function snapAxis(cands: number[], lines: Line[], tol: number): AxisHit | null {
  let best: AxisHit | null = null;
  for (const c of cands) {
    const hit = nearest(lines, c, tol);
    if (!hit) continue;
    const delta = hit[0].v - c;
    if (!best || Math.abs(delta) < Math.abs(best.delta) - EPS) best = { delta, at: hit[0].v, lines: hit };
  }
  return best;
}

function guideAlongX(at: number, span: Bounds, lines: Line[]): Guide {
  const lo = Math.min(span.y, ...lines.map((l) => l.lo));
  const hi = Math.max(span.y + span.h, ...lines.map((l) => l.hi));
  return { a: { x: at, y: lo }, b: { x: at, y: hi } };
}

function guideAlongY(at: number, span: Bounds, lines: Line[]): Guide {
  const lo = Math.min(span.x, ...lines.map((l) => l.lo));
  const hi = Math.max(span.x + span.w, ...lines.map((l) => l.hi));
  return { a: { x: lo, y: at }, b: { x: hi, y: at } };
}

/** A move's pointer, pulled so the moved box's left/centre/right and top/middle/bottom lines land
 *  on the nearest targets in reach. */
export function snapMove(box: Box, start: Pt, cur: Pt, t: Targets, tol: number, shift: boolean): SnapResult {
  const dx = cur.x - start.x;
  const dy = cur.y - start.y;
  // Shift locks to the raw drag's longer axis, as gesture.ts's moveMatrix does; snapping the locked
  // axis would only nudge a coordinate the matrix then throws away.
  const xFree = !shift || Math.abs(dx) >= Math.abs(dy);
  const yFree = !shift || !xFree;
  const b = boxBounds(box);
  const moved = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
  const sx = xFree ? snapAxis([moved.x + moved.w / 2, moved.x, moved.x + moved.w], t.x, tol) : null;
  const sy = yFree ? snapAxis([moved.y + moved.h / 2, moved.y, moved.y + moved.h], t.y, tol) : null;
  const landed = { ...moved, x: moved.x + (sx?.delta ?? 0), y: moved.y + (sy?.delta ?? 0) };
  const guides: Guide[] = [];
  if (sx) guides.push(guideAlongX(sx.at, landed, sx.lines));
  if (sy) guides.push(guideAlongY(sy.at, landed, sy.lines));
  // The locked component is held at its start: moveMatrix re-picks the lock from the point it is
  // given, and a snap that shrank the free axis below the locked one would flip it.
  const point = {
    x: xFree ? cur.x + (sx?.delta ?? 0) : start.x,
    y: yFree ? cur.y + (sy?.delta ?? 0) : start.y,
  };
  return { point: shift ? point : { x: cur.x + (sx?.delta ?? 0), y: cur.y + (sy?.delta ?? 0) }, guides };
}

/** A scale's pointer, pulled so the edge or edges the handle moves land on the nearest targets.
 *  ponytail: only an axis-aligned box snaps; a rotated one's edges have no single x or y to put on
 *  a line. Ceiling: rotated shapes scale freely. Upgrade: snap along the box's own axes against
 *  targets projected into its frame. */
export function snapScale(box: Box, h: ScaleHandle, start: Pt, cur: Pt, t: Targets, tol: number): SnapResult {
  const [a, b, c, d] = box.frame;
  if (Math.abs(b) > EPS || Math.abs(c) > EPS || a <= 0 || d <= 0) return { point: cur, guides: [] };
  const unit = HANDLE_UNIT[h];
  const grab = handleWorld(box, h);
  const dragged = { x: grab.x + cur.x - start.x, y: grab.y + cur.y - start.y };
  const sx = unit.x !== 0.5 ? snapAxis([dragged.x], t.x, tol) : null;
  const sy = unit.y !== 0.5 ? snapAxis([dragged.y], t.y, tol) : null;
  const bb = boxBounds(box);
  const nx = dragged.x + (sx?.delta ?? 0);
  const ny = dragged.y + (sy?.delta ?? 0);
  const span = {
    x: Math.min(bb.x, nx),
    y: Math.min(bb.y, ny),
    w: Math.max(bb.x + bb.w, nx) - Math.min(bb.x, nx),
    h: Math.max(bb.y + bb.h, ny) - Math.min(bb.y, ny),
  };
  const guides: Guide[] = [];
  if (sx) guides.push(guideAlongX(sx.at, span, sx.lines));
  if (sy) guides.push(guideAlongY(sy.at, span, sy.lines));
  return { point: { x: cur.x + (sx?.delta ?? 0), y: cur.y + (sy?.delta ?? 0) }, guides };
}

/** The guides whose line the landed box actually touches, at an edge or a centre. A snap only
 *  nudges the pointer; what the matrix then does with it can leave a line untouched (Shift sizing
 *  from the other axis, the minimum-size clamp, an axis with no length to move), and a guide for
 *  that line would claim a flush edge that is not there (stage-1 review). */
export function keepLanded(guides: Guide[], landed: Bounds): Guide[] {
  const on = (v: number, lo: number, len: number) =>
    [lo, lo + len / 2, lo + len].some((line) => Math.abs(line - v) < 1e-6);
  return guides.filter((g) =>
    g.a.x === g.b.x ? on(g.a.x, landed.x, landed.w) : on(g.a.y, landed.y, landed.h),
  );
}
