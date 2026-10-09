// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { apply } from "../render/affine";
import type { Affine6, Bounds } from "../render/hittest";
import type { Unit } from "./align";
import { nest } from "./nest";

const unit = (id: number, x: number, y: number, w: number, h: number): Unit => ({ ids: [id], bounds: { x, y, w, h } });
const MEDIA: Bounds = { x: 0, y: 0, w: 100, h: 1000 };

/** Where each unit's box ends up, by id, read through its move (or where it was, unmoved). */
function landed(units: Unit[], moves: { ids: number[]; m: Affine6 }[]): Record<number, Bounds> {
  const out: Record<number, Bounds> = {};
  for (const u of units) {
    const m = moves.find((mv) => mv.ids[0] === u.ids[0])?.m ?? [1, 0, 0, 1, 0, 0];
    const b = u.bounds;
    const pts = [apply(m, { x: b.x, y: b.y }), apply(m, { x: b.x + b.w, y: b.y + b.h })];
    const x = Math.min(pts[0].x, pts[1].x);
    const y = Math.min(pts[0].y, pts[1].y);
    out[u.ids[0]] = { x, y, w: Math.abs(pts[1].x - pts[0].x), h: Math.abs(pts[1].y - pts[0].y) };
  }
  return out;
}

const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

describe("nest", () => {
  it("fills a shelf across the media, tallest first, a gap apart and from the edges", () => {
    const units = [unit(1, 500, 500, 30, 10), unit(2, 300, 300, 30, 20), unit(3, 0, 900, 30, 10)];
    const r = nest(units, MEDIA, 2, false);
    const at = landed(units, r.moves);
    expect(at[2]).toEqual({ x: 2, y: 2, w: 30, h: 20 });
    expect(at[1]).toEqual({ x: 34, y: 2, w: 30, h: 10 });
    expect(at[3]).toEqual({ x: 66, y: 2, w: 30, h: 10 });
    expect(r.lengthMm).toBe(24);
    expect(r.tooWide).toEqual([]);
    expect(r.tooLong).toBe(false);
  });

  it("opens a new shelf below when a piece does not fit across", () => {
    const units = [unit(1, 0, 0, 60, 10), unit(2, 0, 0, 60, 10)];
    const at = landed(units, nest(units, MEDIA, 0, false).moves);
    expect(at[1]).toEqual({ x: 0, y: 0, w: 60, h: 10 });
    expect(at[2]).toEqual({ x: 0, y: 10, w: 60, h: 10 });
  });

  it("never overlaps two pieces", () => {
    const units = Array.from({ length: 30 }, (_, i) => unit(i + 1, i * 7, i * 3, 5 + ((i * 13) % 40), 4 + ((i * 7) % 25)));
    const r = nest(units, MEDIA, 1, true);
    const at = Object.values(landed(units, r.moves));
    for (let i = 0; i < at.length; i++) {
      expect(at[i].x).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(at[i].x + at[i].w).toBeLessThanOrEqual(99 + 1e-9);
      for (let j = i + 1; j < at.length; j++) expect(overlaps(at[i], at[j])).toBe(false);
    }
  });

  it("turns a piece a quarter only when that packs shorter", () => {
    // Two tall pieces side by side need 80 mm of length; laid flat they stack to 2 × 20.
    const tall = [unit(1, 0, 0, 20, 80), unit(2, 0, 0, 20, 80)];
    expect(nest(tall, { x: 0, y: 0, w: 85, h: 1000 }, 0, false).lengthMm).toBe(80);
    const turned = nest(tall, { x: 0, y: 0, w: 85, h: 1000 }, 0, true);
    expect(turned.lengthMm).toBe(40);
    expect(landed(tall, turned.moves)[1]).toEqual({ x: 0, y: 0, w: 80, h: 20 });
    // Already flat and side by side: nothing to gain, so nothing turns.
    const flat = [unit(1, 0, 0, 40, 10), unit(2, 0, 0, 40, 10)];
    const r = nest(flat, MEDIA, 0, true);
    expect(r.moves.every((m) => m.m[0] === 1 && m.m[3] === 1)).toBe(true);
  });

  it("turns a piece too wide for the media when allowed, and reports it when not", () => {
    const wide = [unit(7, 0, 0, 150, 40)];
    const r = nest(wide, MEDIA, 0, true);
    expect(landed(wide, r.moves)[7]).toEqual({ x: 0, y: 0, w: 40, h: 150 });
    const refused = nest(wide, MEDIA, 0, false);
    expect(refused.tooWide).toEqual([[7]]);
    expect(refused.moves).toEqual([]);
  });

  it("leaves a piece already in its place unmoved, and says when the pack runs past the media", () => {
    expect(nest([unit(1, 0, 0, 10, 10)], MEDIA, 0, false).moves).toEqual([]);
    const long = nest([unit(1, 0, 0, 90, 600), unit(2, 0, 0, 90, 600)], MEDIA, 0, false);
    expect(long.tooLong).toBe(true);
  });

  it("packs nothing for no pieces", () => {
    expect(nest([], MEDIA, 3, true)).toEqual({ moves: [], lengthMm: 0, tooWide: [], tooLong: false });
  });
});
