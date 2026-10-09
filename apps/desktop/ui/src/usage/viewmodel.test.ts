// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { UsageEntry, UsagePass } from "../ipc";
import {
  NO_MATERIAL,
  NO_OPERATOR,
  formatDuration,
  formatLength,
  formatWhen,
  materialsOf,
  totalsByMaterial,
  totalsByOperator,
} from "./viewmodel";

const pass = (over: Partial<UsagePass>): UsagePass => ({
  key: "all",
  preset_id: null,
  preset_name: null,
  speed: 5,
  force: 10,
  repeat_count: 1,
  cut_length_mm: 0,
  ...over,
});

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  started_at: "2026-10-09T10:00:00Z",
  ended_at: "2026-10-09T10:01:00Z",
  duration_s: 60,
  operator: "Ada",
  machine_id: "cameo1",
  device_instance_id: "usb:1:4",
  host: null,
  document: null,
  passes: [],
  cut_length_mm: 0,
  outcome: "completed",
  error: null,
  ...over,
});

describe("totals", () => {
  const vinyl = pass({ preset_id: "v", preset_name: "Vinyl", cut_length_mm: 300 });
  const card = pass({ preset_id: "c", preset_name: "Card", cut_length_mm: 100 });
  const entries = [
    entry({ passes: [vinyl, card], cut_length_mm: 400 }),
    entry({ operator: null, passes: [vinyl], cut_length_mm: 300, outcome: "cancelled", duration_s: 30 }),
    entry({ passes: [pass({ cut_length_mm: 50 })], cut_length_mm: 50 }),
  ];

  it("sums each operator's jobs, finished jobs, length and time, longest first", () => {
    expect(totalsByOperator(entries)).toEqual([
      { name: "Ada", jobs: 2, completed: 2, lengthMm: 450, seconds: 120 },
      { name: NO_OPERATOR, jobs: 1, completed: 0, lengthMm: 300, seconds: 30 },
    ]);
  });

  it("counts a job once per material it used, with each pass's own length", () => {
    expect(totalsByMaterial(entries)).toEqual([
      { name: "Vinyl", jobs: 2, completed: 1, lengthMm: 600, seconds: 90 },
      { name: "Card", jobs: 1, completed: 1, lengthMm: 100, seconds: 60 },
      { name: NO_MATERIAL, jobs: 1, completed: 1, lengthMm: 50, seconds: 60 },
    ]);
  });

  it("names a job's materials once each", () => {
    expect(materialsOf(entries[0])).toBe("Vinyl, Card");
    expect(materialsOf(entry({ passes: [vinyl, vinyl] }))).toBe("Vinyl");
  });
});

describe("formatting", () => {
  it("reads lengths and durations at a glance", () => {
    expect(formatLength(420.4)).toBe("420 mm");
    expect(formatLength(12345)).toBe("12.35 m");
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(185)).toBe("3 min 05 s");
    expect(formatDuration(3720)).toBe("1 h 02 min");
  });

  it("shows a time to the minute, and an unreadable one as it is", () => {
    expect(formatWhen("2026-10-09T10:00:00Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatWhen("not a time")).toBe("not a time");
  });
});
