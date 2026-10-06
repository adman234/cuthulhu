// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Scene } from "../render/hittest";
import { apply, compose, invert, translate, type Pt } from "../render/affine";

/** The local rectangle [0, w] × [0, h], placed in world by `frame`. Gestures work in this frame,
 *  which is what lets one scale rule serve a rotated single node and an axis-aligned group alike. */
export type Box = { frame: Affine6; w: number; h: number };
export type ScaleHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type HandleKind = ScaleHandle | "rotate" | "move";

/** Each handle's place on the box, as fractions of (w, h). */
export const HANDLE_UNIT: Record<ScaleHandle, Pt> = {
  nw: { x: 0, y: 0 }, n: { x: 0.5, y: 0 }, ne: { x: 1, y: 0 }, e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 }, s: { x: 0.5, y: 1 }, sw: { x: 0, y: 1 }, w: { x: 0, y: 0.5 },
};
export const SCALE_HANDLES = Object.keys(HANDLE_UNIT) as ScaleHandle[];

// Float slack on the inside test, so a zero-height box (a straight path) keeps an inside.
const INSIDE_EPS = 1e-9;

/** One node: its oriented box, so a rotated rect keeps handles on its edges. Several: the
 *  axis-aligned union of their world bounds — there is no shared orientation to keep. */
export function selectionBox(scene: Scene, ids: number[]): Box | null {
  // A Set, because this runs on every idle pointer move and a marquee can select thousands.
  const wanted = new Set(ids);
  const nodes = scene.nodes.filter((n) => wanted.has(n.id));
  if (nodes.length === 0) return null;
  const only = nodes.length === 1 ? nodes[0] : null;
  if (only?.local && only.world) {
    return { frame: compose(translate(only.local.x, only.local.y), only.world), w: only.local.w, h: only.local.h };
  }
  const x = Math.min(...nodes.map((n) => n.bounds.x));
  const y = Math.min(...nodes.map((n) => n.bounds.y));
  const r = Math.max(...nodes.map((n) => n.bounds.x + n.bounds.w));
  const b = Math.max(...nodes.map((n) => n.bounds.y + n.bounds.h));
  return { frame: translate(x, y), w: r - x, h: b - y };
}

export function handleLocal(box: Box, h: ScaleHandle): Pt {
  return { x: HANDLE_UNIT[h].x * box.w, y: HANDLE_UNIT[h].y * box.h };
}

export function handleWorld(box: Box, h: ScaleHandle): Pt {
  return apply(box.frame, handleLocal(box, h));
}

/** World corners in drawing order: nw, ne, se, sw. */
export function boxCorners(box: Box): Pt[] {
  return (["nw", "ne", "se", "sw"] as const).map((h) => handleWorld(box, h));
}

export function boxCenter(box: Box): Pt {
  return apply(box.frame, { x: box.w / 2, y: box.h / 2 });
}

/** Which part of the box is under `p`. Tolerances are world mm — the caller divides its CSS-px
 *  sizes by the view scale. Handles win over the inside so a small box can still be scaled, and
 *  the rotate zone is only outside, where a press would otherwise do nothing. */
export function handleAt(box: Box, p: Pt, handleTol: number, rotateTol: number): HandleKind | null {
  for (const h of SCALE_HANDLES) {
    if (dist(handleWorld(box, h), p) <= handleTol) return h;
  }
  if (inside(box, p)) return "move";
  if (boxCorners(box).some((c) => dist(c, p) <= rotateTol)) return "rotate";
  return null;
}

function inside(box: Box, p: Pt): boolean {
  const inv = invert(box.frame);
  if (!inv) return false;
  const q = apply(inv, p);
  return q.x >= -INSIDE_EPS && q.x <= box.w + INSIDE_EPS && q.y >= -INSIDE_EPS && q.y <= box.h + INSIDE_EPS;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
