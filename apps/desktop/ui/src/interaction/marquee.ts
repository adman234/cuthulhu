// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bounds, Scene } from "../render/hittest";
import type { Pt } from "../render/affine";

export function normalizeRect(a: Pt, b: Pt): Bounds {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Nodes whose world bounds the band touches. Touching rather than containing, because the usual
 *  target is a word of imported letters, and a band that must swallow every serif is a chore. */
export function marqueeHits(scene: Scene, band: Bounds): number[] {
  return scene.nodes
    .filter((n) => n.bounds.x <= band.x + band.w && n.bounds.x + n.bounds.w >= band.x
                && n.bounds.y <= band.y + band.h && n.bounds.y + n.bounds.h >= band.y)
    .map((n) => n.id);
}

export function marqueeSelection(prev: number[], hits: number[], additive: boolean): number[] {
  return additive ? [...prev, ...hits.filter((id) => !prev.includes(id))] : hits;
}

export function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
