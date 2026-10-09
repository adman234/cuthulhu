// SPDX-License-Identifier: GPL-3.0-or-later
/** The swatches under the canvas. Picking one strokes the selection in that colour, and the
 *  planner groups by colour, so a swatch *is* a cut layer — the way LightBurn's palette works.
 *  Twelve, distinguishable on the dark workspace, in LightBurn's order so a LightBurn user's
 *  habits carry over. Stored as `0xRRGGBBAA`, the document's `Style` encoding. */
export type Swatch = { name: string; rgba: number };

export const PALETTE: readonly Swatch[] = [
  { name: "Black", rgba: 0x000000ff },
  { name: "Blue", rgba: 0x0000ffff },
  { name: "Red", rgba: 0xff0000ff },
  { name: "Green", rgba: 0x00e000ff },
  { name: "Olive", rgba: 0xd0d000ff },
  { name: "Orange", rgba: 0xff8000ff },
  { name: "Cyan", rgba: 0x00e0e0ff },
  { name: "Magenta", rgba: 0xff00ffff },
  { name: "Grey", rgba: 0xb4b4b4ff },
  { name: "Navy", rgba: 0x0000a0ff },
  { name: "Maroon", rgba: 0xa00000ff },
  { name: "Forest", rgba: 0x00a000ff },
];

/** CSS for a swatch, alpha dropped: every swatch is opaque, and a pass key's colour is too. */
export function swatchCss(rgba: number): string {
  return `#${(rgba >>> 8).toString(16).padStart(6, "0")}`;
}
