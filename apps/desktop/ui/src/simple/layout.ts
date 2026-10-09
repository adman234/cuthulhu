// SPDX-License-Identifier: GPL-3.0-or-later
/** Which shell the window shows. "simple" is the LightBurn-style one: Cuts and Cutter docked
 *  beside the canvas and a colour palette under it. "classic" is the original layers and
 *  properties layout with the cut workflow in a dialog. */
export type Layout = "simple" | "classic";

export const LAYOUT_KEY = "cuthulhu.layout";

/** Anything but an explicit "classic" is the simple shell, so a missing, cleared or garbled entry
 *  lands on the default rather than on a layout nobody chose. */
export function parseLayout(raw: string | null): Layout {
  return raw === "classic" ? "classic" : "simple";
}

/** Storage can be absent or throw (a private window, blocked site data); either way the window
 *  still has to open, so a failed read is the default. */
export function readLayout(storage: Pick<Storage, "getItem"> | null): Layout {
  try {
    return parseLayout(storage?.getItem(LAYOUT_KEY) ?? null);
  } catch {
    return "simple";
  }
}

/** Best effort: a layout that cannot be remembered is still the one on screen now. */
export function writeLayout(storage: Pick<Storage, "setItem"> | null, layout: Layout): void {
  try {
    storage?.setItem(LAYOUT_KEY, layout);
  } catch {
    // Nothing to do: the next launch opens on the default.
  }
}
