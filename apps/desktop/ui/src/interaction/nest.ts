// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Bounds } from "../render/hittest";
import type { Move, Unit } from "./align";

/** Where a nest leaves the pieces, or why it cannot: `tooWide` are pieces that do not fit across
 *  the media even turned, `tooLong` says the packed pieces run past the media's end. */
export type NestResult = { moves: Move[]; lengthMm: number; tooWide: number[][]; tooLong: boolean };

type Placed = { unit: Unit; turned: boolean; x: number; y: number };

const EPS = 1e-9;

/** A quarter turn about the centre of `b`, then a move putting the turned box's corner at (x, y).
 *  A quarter turn maps an axis-aligned box onto one exactly, so the turned piece's box is `b`'s
 *  with its sides swapped, centred where `b` was. */
function turnedTo(b: Bounds, x: number, y: number): Affine6 {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = x - (cx - b.h / 2);
  const dy = y - (cy - b.w / 2);
  // x' = -(y - cy) + cx, y' = (x - cx) + cy: clockwise on the y-down canvas.
  return [0, 1, -1, 0, cx + cy + dx, cy - cx + dy];
}

/** Shelves, first fit by decreasing height: each piece goes on the first shelf with room across
 *  it, or opens a new shelf below the last. A shelf is as tall as its first (tallest) piece.
 *  ponytail: packs bounding boxes on shelves, not true shapes, so an L's empty corner and the gap
 *  above a short piece on a tall shelf stay unused. Ceiling: fine for stickers and lettering, which
 *  are mostly boxy; upgrade to a skyline packer, then to no-fit-polygon nesting of the outlines,
 *  when someone is cutting irregular shapes by the metre. */
function shelves(pieces: { unit: Unit; turned: boolean }[], left: number, top: number, width: number, gap: number) {
  const size = (p: { unit: Unit; turned: boolean }) =>
    p.turned ? { w: p.unit.bounds.h, h: p.unit.bounds.w } : { w: p.unit.bounds.w, h: p.unit.bounds.h };
  // Stable on ties, so the same selection always nests the same way.
  const order = pieces.map((p, i) => ({ p, i, ...size(p) })).sort((a, b) => b.h - a.h || b.w - a.w || a.i - b.i);
  const rows: { y: number; h: number; used: number }[] = [];
  const placed: Placed[] = [];
  for (const { p, w, h } of order) {
    let row = rows.find((r) => r.used + w <= width + EPS);
    if (!row) {
      const last = rows[rows.length - 1];
      row = { y: last ? last.y + last.h + gap : top, h, used: 0 };
      rows.push(row);
    }
    placed.push({ unit: p.unit, turned: p.turned, x: left + row.used, y: row.y });
    row.used += w + gap;
  }
  const last = rows[rows.length - 1];
  return { placed, bottom: last ? last.y + last.h : top };
}

/** Packs `units` across `area` (the artboard: its width is the media's), `gap` mm from each other
 *  and from the media's edges, starting at its top, so the cut uses as little length as it can.
 *
 *  With `allowTurn`, a piece too wide for the media is turned a quarter, and every piece may be
 *  laid flat or stood up when one of those packs shorter than leaving them as they are; turning
 *  only when it saves length keeps a nest that needed none from rotating lettering for nothing. */
export function nest(units: Unit[], area: Bounds, gap: number, allowTurn: boolean): NestResult {
  const left = area.x + gap;
  const top = area.y + gap;
  const width = area.w - 2 * gap;
  const fits = (w: number) => w <= width + EPS;
  const tooWide = units.filter((u) => !fits(u.bounds.w) && !(allowTurn && fits(u.bounds.h)));
  const packable = units.filter((u) => !tooWide.includes(u));
  // Turn only what must turn; then lay every piece that can flat; then stand every piece that can up.
  const must = (u: Unit) => !fits(u.bounds.w);
  const candidates: ((u: Unit) => boolean)[] = [must];
  if (allowTurn) {
    candidates.push((u) => must(u) || (u.bounds.h > u.bounds.w && fits(u.bounds.h)));
    candidates.push((u) => must(u) || (u.bounds.w > u.bounds.h && fits(u.bounds.h)));
  }
  let best: { placed: Placed[]; bottom: number } | null = null;
  for (const turn of candidates) {
    const run = shelves(packable.map((u) => ({ unit: u, turned: turn(u) })), left, top, width, gap);
    // Strictly shorter, so a tie keeps the earlier candidate, which turns less.
    if (!best || run.bottom < best.bottom - EPS) best = run;
  }
  const placed = best?.placed ?? [];
  const moves = placed.flatMap(({ unit, turned, x, y }): Move[] => {
    const b = unit.bounds;
    if (turned) return [{ ids: unit.ids, m: turnedTo(b, x, y) }];
    const dx = x - b.x;
    const dy = y - b.y;
    return Math.abs(dx) < EPS && Math.abs(dy) < EPS ? [] : [{ ids: unit.ids, m: [1, 0, 0, 1, dx, dy] }];
  });
  const bottom = best?.bottom ?? top;
  return {
    moves,
    lengthMm: placed.length === 0 ? 0 : bottom + gap - area.y,
    tooWide: tooWide.map((u) => u.ids),
    tooLong: bottom > area.y + area.h + EPS,
  };
}
