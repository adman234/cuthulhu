// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isUnreachable, locationSummary } from "./presetsLocation";

describe("presets location", () => {
  it("says whose file it is as well as where", () => {
    expect(locationSummary({ path: "/home/a/.config/cuthulhu/presets.json", custom: false, defaultPath: "x" })).toBe(
      "/home/a/.config/cuthulhu/presets.json (this computer only)",
    );
    expect(locationSummary({ path: "/mnt/share/presets.json", custom: true, defaultPath: "x" })).toContain(
      "/mnt/share/presets.json (chosen",
    );
  });

  it("tells an unreachable share from a damaged file", () => {
    expect(isUnreachable("presets_unreachable")).toBe(true);
    expect(isUnreachable("presets_corrupt")).toBe(false);
    expect(isUnreachable(null)).toBe(false);
  });
});
