// SPDX-License-Identifier: GPL-3.0-or-later
import type { Affine6, Bounds, Scene } from "./hittest";
import type { Box } from "../interaction/selectionBox";

export type NodeId = number;

/** What is drawn over the artwork: the selection's box and handles, and a marquee band. */
export type Overlay = { box: Box | null; marquee: Bounds | null };

export interface Renderer {
  setScene(s: Scene): void;
  markDirty(id: NodeId): void;
  setSelection(ids: NodeId[]): void;
  /** CSS size of the canvas and the display's pixel ratio; sizes the backing store. */
  resize(cssW: number, cssH: number, dpr: number): void;
  /** World mm → CSS px. */
  setView(m: Affine6): void;
  setOverlay(o: Overlay): void;
  draw(): void;
}
