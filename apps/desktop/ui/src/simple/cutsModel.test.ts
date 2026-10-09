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
    ({ revision: "r1", rows, skippedNotCut: 0 });
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
