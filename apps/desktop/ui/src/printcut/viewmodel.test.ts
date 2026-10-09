// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { areaFromDraft, canToggle, draftFromArea, registeredNotice, statusLine } from "./viewmodel";

const letter = { origin_x_mm: 10, origin_y_mm: 10, width_mm: 195.9, length_mm: 259.4 };

describe("area draft", () => {
  it("round-trips an area through the fields", () => {
    const draft = draftFromArea(letter);
    expect(draft).toEqual({ originX: "10", originY: "10", width: "195.9", length: "259.4" });
    expect(areaFromDraft(draft)).toEqual({ area: letter });
  });

  it("names the field that is not a number, and leaves range to the backend", () => {
    expect(areaFromDraft({ originX: "10", originY: "", width: "1", length: "1" })).toEqual({
      error: "Top must be a number of millimetres",
    });
    expect(areaFromDraft({ originX: "10", originY: "10", width: "abc", length: "1" })).toEqual({
      error: "Width must be a number of millimetres",
    });
    // Too small to tell apart is not judged here: the backend refuses it with the reason.
    expect(areaFromDraft({ originX: "10", originY: "10", width: "1", length: "1" })).toHaveProperty("area");
  });
});

describe("status", () => {
  const placed = { marks: 7, enabled: true, area: letter, problem: null };

  it("says what the document holds and what the cut will do", () => {
    expect(statusLine(null)).toBe("Reading the document…");
    expect(statusLine({ marks: null, enabled: false, area: null, problem: null })).toBe(
      "No registration marks in this document yet.",
    );
    expect(statusLine(placed)).toBe(
      "Marks placed (195.9 × 259.4 mm, from 10, 10 mm); the cut will register against them.",
    );
    expect(statusLine({ ...placed, enabled: false })).toBe("Marks placed (195.9 × 259.4 mm, from 10, 10 mm); registration is off.");
    expect(statusLine({ ...placed, area: null, problem: "the registration marks have been changed" })).toBe(
      "the registration marks have been changed",
    );
  });

  it("offers turning it on only over marks that can be read, and turning it off always", () => {
    expect(canToggle(null)).toBe(false);
    expect(canToggle({ marks: null, enabled: false, area: null, problem: null })).toBe(false);
    expect(canToggle({ ...placed, enabled: false, area: null, problem: "changed" })).toBe(false);
    expect(canToggle({ ...placed, enabled: false })).toBe(true);
    // Altered or deleted marks refuse every cut until registration is off; the switch must allow it.
    expect(canToggle({ ...placed, enabled: true, area: null, problem: "changed" })).toBe(true);
    expect(canToggle({ marks: null, enabled: true, area: null, problem: null })).toBe(true);
  });

  it("tells the cut dialog when a plan is registered", () => {
    expect(registeredNotice(null)).toBeNull();
    expect(registeredNotice(undefined)).toBeNull();
    expect(registeredNotice({ originXMm: 10, originYMm: 10, widthMm: 195.9, lengthMm: 259.4 })).toBe(
      "Registered: the cutter looks for the printed marks first (195.9 × 259.4 mm from 10, 10 mm) and cuts from them.",
    );
  });
});
