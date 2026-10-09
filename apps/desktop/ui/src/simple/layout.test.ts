// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { LAYOUT_KEY, parseLayout, readLayout, writeLayout } from "./layout";

describe("layout choice", () => {
  it("defaults to the simple shell for anything but an explicit classic", () => {
    expect(parseLayout(null)).toBe("simple");
    expect(parseLayout("")).toBe("simple");
    expect(parseLayout("Classic")).toBe("simple");
    expect(parseLayout("classic")).toBe("classic");
  });

  it("opens on the default when storage is missing or throws", () => {
    expect(readLayout(null)).toBe("simple");
    const throwing = { getItem: () => { throw new Error("blocked"); } };
    expect(readLayout(throwing)).toBe("simple");
  });

  it("round-trips through storage and survives a storage that refuses writes", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeLayout(storage, "classic");
    expect(m.get(LAYOUT_KEY)).toBe("classic");
    expect(readLayout(storage)).toBe("classic");
    expect(() => writeLayout({ setItem: () => { throw new Error("quota"); } }, "simple")).not.toThrow();
  });
});
