// SPDX-License-Identifier: GPL-3.0-or-later

// The picker's whole state as a union rather than nullable fields: "no fonts installed"
// and "the listing call failed" are different situations an operator can act on, and a
// blank <select> would hide both.
export type FontListState =
  | { kind: "loading" }
  | { kind: "ready"; families: string[]; selected: string }
  | { kind: "empty" }
  | { kind: "error"; message: string };

/** `preferred` is the family a text being edited was set in. Kept selected even when this machine
 *  does not list it — a project from another computer — because swapping it for the first listed
 *  face would restyle the text on an edit that only meant to fix a typo. The backend substitutes a
 *  face for an unlisted family on its own, as it does when the project is cut. */
export function fontsLoaded(families: string[], preferred?: string): FontListState {
  if (preferred !== undefined && preferred !== "" && !families.includes(preferred)) {
    return { kind: "ready", families: [preferred, ...families], selected: preferred };
  }
  if (families.length === 0) return { kind: "empty" };
  return { kind: "ready", families, selected: preferred && families.includes(preferred) ? preferred : families[0] };
}

// No-op unless the family is one the backend actually listed — don't invent state the
// backend never offered (same refusal philosophy as trace's controlsFromSpecs).
export function selectFamily(state: FontListState, family: string): FontListState {
  if (state.kind !== "ready" || !state.families.includes(family)) return state;
  return { ...state, selected: family };
}

/** What the dialog sends: the words, the size in mm, and the family. */
export type TextDraft = { text: string; sizeMm: number; family: string };

/** The text a dialog opened on, or null for a new one. Mirrors `ShapeKind::Text`'s fields. */
export type TextSource = { id: number; family: string; size_mm: number; text: string };

/** The fields as typed (size kept as a string, like the shape tools' numbers), read into a draft
 *  or the sentence saying what stops it. Text with nothing but spaces has nothing to cut, which the
 *  backend refuses too; saying so here keeps Insert from offering it. */
export function readTextDraft(fonts: FontListState, text: string, size: string): { ok: true; draft: TextDraft } | { ok: false; error: string } {
  if (fonts.kind !== "ready") return { ok: false, error: "Pick a font first" };
  if (text.trim() === "") return { ok: false, error: "Type some text" };
  const n = size.trim() === "" ? NaN : Number(size);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Size must be a number of mm above zero" };
  return { ok: true, draft: { text, sizeMm: n, family: fonts.selected } };
}

type NodeLike = { kind: unknown };

/** The one selected Text node, or null: editing words is for exactly one text at a time. */
export function selectedText(nodes: Record<string, NodeLike & { id: number }>, selected: number[]): TextSource | null {
  if (selected.length !== 1) return null;
  const n = nodes[selected[0]];
  const kind = n?.kind as { Shape?: { Text?: { family: string; size_mm: number; text: string } } } | undefined;
  const t = kind?.Shape?.Text;
  return t ? { id: n.id, family: t.family, size_mm: t.size_mm, text: t.text } : null;
}
