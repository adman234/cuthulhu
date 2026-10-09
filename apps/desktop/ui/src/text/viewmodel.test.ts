// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { fontsLoaded, readTextDraft, selectFamily, selectedText } from "./viewmodel";

describe("fontsLoaded", () => {
  it("maps an empty list to the empty state, not a blank selection", () => {
    expect(fontsLoaded([])).toEqual({ kind: "empty" });
  });

  it("selects the first family when the list is non-empty", () => {
    expect(fontsLoaded(["A", "B"])).toEqual({ kind: "ready", families: ["A", "B"], selected: "A" });
  });
});

describe("selectFamily", () => {
  it("switches selection within listed families", () => {
    const ready = fontsLoaded(["A", "B"]);
    expect(selectFamily(ready, "B")).toEqual({ kind: "ready", families: ["A", "B"], selected: "B" });
  });

  it("ignores a family the backend never listed", () => {
    const ready = fontsLoaded(["A", "B"]);
    expect(selectFamily(ready, "C")).toBe(ready);
  });

  it("ignores selection in non-ready states", () => {
    const loading = { kind: "loading" } as const;
    expect(selectFamily(loading, "A")).toBe(loading);
    const empty = fontsLoaded([]);
    expect(selectFamily(empty, "A")).toBe(empty);
  });
});

describe("fontsLoaded with the family a text was set in", () => {
  it("selects it when listed", () => {
    expect(fontsLoaded(["A", "B"], "B")).toEqual({ kind: "ready", families: ["A", "B"], selected: "B" });
  });

  it("keeps it selected, first in the list, when this machine does not list it", () => {
    expect(fontsLoaded(["A"], "Gone")).toEqual({ kind: "ready", families: ["Gone", "A"], selected: "Gone" });
    expect(fontsLoaded([], "Gone")).toEqual({ kind: "ready", families: ["Gone"], selected: "Gone" });
  });
});

describe("readTextDraft", () => {
  const ready = fontsLoaded(["A"]);
  it("reads multi-line text, a size and the selected family", () => {
    expect(readTextDraft(ready, "Hi\nthere", "12.5")).toEqual({ ok: true, draft: { text: "Hi\nthere", sizeMm: 12.5, family: "A" } });
  });

  it("refuses blank text, a bad size, and no font in words", () => {
    expect(readTextDraft(ready, "  \n ", "10")).toEqual({ ok: false, error: "Type some text" });
    for (const size of ["", "0", "-3", "abc"]) {
      expect(readTextDraft(ready, "Hi", size)).toEqual({ ok: false, error: "Size must be a number of mm above zero" });
    }
    expect(readTextDraft({ kind: "loading" }, "Hi", "10")).toEqual({ ok: false, error: "Pick a font first" });
  });
});

describe("selectedText", () => {
  const nodes = {
    1: { id: 1, kind: { Shape: { Text: { family: "A", size_mm: 10, text: "Hi", d: "" } } } },
    2: { id: 2, kind: { Shape: { Rect: { w: 1, h: 1 } } } },
  };
  it("is the one selected Text node", () => {
    expect(selectedText(nodes, [1])).toEqual({ id: 1, family: "A", size_mm: 10, text: "Hi" });
  });
  it("is null for anything else, or more than one", () => {
    expect(selectedText(nodes, [2])).toBeNull();
    expect(selectedText(nodes, [1, 2])).toBeNull();
    expect(selectedText(nodes, [])).toBeNull();
    expect(selectedText(nodes, [9])).toBeNull();
  });
});
