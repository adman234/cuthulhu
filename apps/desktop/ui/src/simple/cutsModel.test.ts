// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DISCONNECTED_STATUS, type CutStatus, type DeviceInfo, type PlanCutPassSummary } from "../ipc";
import {
  freshSettings, holdSettings, machineMismatch, progressPercent, rowsFromPlan, startControl,
  type DockPlan,
} from "./cutsModel";

const pass = (key: string, shapes = 1): PlanCutPassSummary =>
  ({ key, shape_count: shapes, node_ids: [1], starts: [[0, 0]] });

const cameo1: DeviceInfo = {
  instance_id: "usb:sn:A", machine_id: "cameo1", transport: { Usb: { locator: "sn:A" } }, candidate: false, host: null,
};
const READY: CutStatus = { ...DISCONNECTED_STATUS, phase: "Idle", actions: { cut: true, cancel: false, resume: false, confirm: false } };

describe("rowsFromPlan", () => {
  it("starts untouched passes on defaults, and a preset-keyed pass on its own preset", () => {
    const rows = rowsFromPlan([pass("color:ff0000ff"), pass("preset:cameo1-vinyl-sticker")], new Map());
    expect(rows[0]).toMatchObject({ key: "color:ff0000ff", enabled: true, presetId: null, speed: null });
    expect(rows[1].presetId).toBe("cameo1-vinyl-sticker");
  });

  it("keeps a layer's settings across a replan, by colour", () => {
    const first = rowsFromPlan([pass("color:ff0000ff"), pass("color:0000ffff")], new Map());
    const held = holdSettings(new Map(), { ...first[1], speed: 3, enabled: false });
    // The replan reorders the passes and changes the counts; the blue layer is still blue.
    const again = rowsFromPlan([pass("color:0000ffff", 4), pass("color:ff0000ff", 2)], held);
    expect(again[0]).toMatchObject({ key: "color:0000ffff", shapeCount: 4, speed: 3, enabled: false });
    expect(again[1]).toMatchObject({ key: "color:ff0000ff", shapeCount: 2, ...freshSettings("color:ff0000ff") });
  });

  it("does not mutate the held map it was given", () => {
    const held = new Map();
    const row = rowsFromPlan([pass("all")], held)[0];
    holdSettings(held, { ...row, force: 9 });
    expect(held.size).toBe(0);
  });
});

describe("startControl", () => {
  const plan = (rows = rowsFromPlan([pass("color:ff0000ff")], new Map())): DockPlan =>
    ({ revision: "r1", rows, skippedNotCut: 0, travel: [] });
  const base = { status: READY, connected: cameo1, plan: plan(), planning: false, sending: false, mismatch: null };

  it("allows a cut only when everything lines up", () => {
    expect(startControl(base)).toEqual({ enabled: true, reason: null });
  });

  it("names the reason it is withheld, in the order a member would fix them", () => {
    expect(startControl({ ...base, connected: null }).reason).toBe("Connect a cutter first");
    expect(startControl({ ...base, mismatch: "wrong machine" }).reason).toBe("wrong machine");
    expect(startControl({ ...base, status: { ...READY, actions: { ...READY.actions, cut: false } } }).reason)
      .toBe("The cutter is not ready");
    expect(startControl({ ...base, planning: true }).reason).toBe("Planning…");
    expect(startControl({ ...base, plan: plan([]) }).reason).toBe("Nothing to cut");
    const off = plan().rows.map((r) => ({ ...r, enabled: false }));
    expect(startControl({ ...base, plan: plan(off) }).reason).toBe("Turn on Output for at least one layer");
  });

  it("reads permission from actions, not the phase", () => {
    // A phase that looks idle with no cut action is still not cuttable.
    const idleButNotLegal: CutStatus = { ...READY, actions: { cut: false, cancel: false, resume: false, confirm: false } };
    expect(startControl({ ...base, status: idleButNotLegal }).enabled).toBe(false);
  });
});

describe("machineMismatch", () => {
  it("is silent with nothing connected, no machine set, or the same machine", () => {
    expect(machineMismatch("cameo5", null)).toBeNull();
    expect(machineMismatch(null, cameo1)).toBeNull();
    expect(machineMismatch("cameo1", cameo1)).toBeNull();
  });
  it("names both machines when they differ", () => {
    expect(machineMismatch("cameo5", cameo1)).toBe("This design is set up for cameo5, but the cutter is cameo1");
  });
});

describe("progressPercent", () => {
  it("is null until bytes are moving, then a clamped whole percent", () => {
    expect(progressPercent(READY)).toBeNull();
    expect(progressPercent({ ...READY, sent: { sent: 0, total: 0 } })).toBeNull();
    expect(progressPercent({ ...READY, sent: { sent: 1, total: 3 } })).toBe(33);
    expect(progressPercent({ ...READY, sent: { sent: 5, total: 3 } })).toBe(100);
  });
});

import {
  currentMedia, estimateSeconds, formatDuration, fromLayer, heldFromJob, moveKey, mutedNodeIds,
  orderRows, readBeginner, shouldAutoMirror, toLayer, writeBeginner, BEGINNER_KEY,
} from "./cutsModel";

describe("saved layer settings", () => {
  it("round-trip between a row and the document's LayerSettings", () => {
    const row = { ...freshSettings("color:ff0000ff"), speed: 4, enabled: false, tool: "Pen" as const, trackEnhancing: true };
    expect(fromLayer(toLayer(row))).toEqual(row);
    const blank = freshSettings("all");
    expect(toLayer(blank)).toMatchObject({ output: true, pen: null, track_enhancing: null });
    expect(fromLayer(toLayer(blank))).toEqual(blank);
  });

  it("seed rows from the document, which an older backend may not send", () => {
    expect(heldFromJob(undefined).size).toBe(0);
    const held = heldFromJob({ layers: { "color:ff0000ff": toLayer({ ...freshSettings("x"), speed: 7 }) }, layer_order: [], mirror: false });
    expect(rowsFromPlan([pass("color:ff0000ff")], held)[0].speed).toBe(7);
  });
});

describe("layer order", () => {
  const rows = ["a", "b", "c"].map((key) => ({ key }));
  it("puts saved keys first in their order, then the rest as planned, skipping unknown keys", () => {
    expect(orderRows(rows, ["c", "zzz", "a"]).map((r) => r.key)).toEqual(["c", "a", "b"]);
    expect(orderRows(rows, []).map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
  it("moves one step and refuses past either end", () => {
    expect(moveKey(rows, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveKey(rows, 2, 1)).toBeNull();
    expect(moveKey(rows, 0, -1)).toBeNull();
  });
});

describe("estimateSeconds", () => {
  const lookup = { presets: [{ id: "v", name: "Vinyl", machine_id: "cameo1", builtin: true, settings: { speed: 5, force: 10, repeat_count: 2 } }], loaded: true };
  it("reads speed n as n cm/s, applies repeats, adds per-pass overhead, and skips Output-off rows", () => {
    const [a, b] = rowsFromPlan([{ ...pass("color:ff0000ff"), cut_length_mm: 500 }, { ...pass("color:0000ffff"), cut_length_mm: 900 }], new Map());
    // 500 mm at 100 mm/s = 5 s, plus 4 s overhead.
    expect(estimateSeconds([{ ...a, speed: 10 }], lookup)).toBeCloseTo(9);
    // From the preset: 500 mm × 2 runs at 50 mm/s = 20 s + 4.
    expect(estimateSeconds([{ ...a, presetId: "v" }], lookup)).toBeCloseTo(24);
    expect(estimateSeconds([a, { ...b, enabled: false }], lookup)).toBeCloseTo(500 / 50 + 4);
  });
  it("formats", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(125)).toBe("2 min 5 s");
    expect(formatDuration(3720)).toBe("1 h 2 min");
  });
});

describe("dock helpers", () => {
  it("mutes the shapes of layers with Output off", () => {
    const rows = rowsFromPlan([{ ...pass("color:ff0000ff"), node_ids: [1, 2] }, { ...pass("all"), node_ids: [3] }], new Map());
    expect(mutedNodeIds([{ ...rows[0], enabled: false }, rows[1]])).toEqual([1, 2]);
  });

  it("turns mirror on for a mirrored material only when it is off", () => {
    const htv = { id: "h", name: "HTV", machine_id: "cameo1", builtin: false, mirror: true, settings: { speed: 5, force: 10, repeat_count: 1 } };
    expect(shouldAutoMirror(htv, false)).toBe(true);
    expect(shouldAutoMirror(htv, true)).toBe(false);
    expect(shouldAutoMirror({ ...htv, mirror: false }, false)).toBe(false);
    expect(shouldAutoMirror(undefined, false)).toBe(false);
  });

  it("names the media the artboard matches after the machine's clamp", () => {
    const cameo1 = { width_mm: 295, height_mm: 2999 };
    expect(currentMedia({ w: 295, h: 304.8 }, cameo1)).toBe("mat-12x12");
    expect(currentMedia({ w: 295, h: 2999 }, cameo1)).toBe("roll");
    expect(currentMedia({ w: 200, h: 200 }, cameo1)).toBeNull();
    expect(currentMedia({ w: 295, h: 304.8 }, null)).toBeNull();
  });

  it("keeps beginner mode off until turned on, and survives blocked storage", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(readBeginner(storage)).toBe(false);
    writeBeginner(storage, true);
    expect(m.get(BEGINNER_KEY)).toBe("on");
    expect(readBeginner(storage)).toBe(true);
    expect(readBeginner({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});
