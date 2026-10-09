// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties } from "react";
import type { CutStatus, DeviceInfo } from "../ipc";
import { connectedControl, deviceBadge } from "../hosts/deviceList";
import { progressPercent, type Control } from "./cutsModel";

type Props = {
  status: CutStatus;
  devices: DeviceInfo[];
  chosen: string | null;
  onChoose: (instanceId: string) => void;
  connected: DeviceInfo | null;
  busy: boolean;
  start: Control;
  mismatch: string | null;
  notice: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onResume: () => void;
  onPassDone: () => void;
  onUseCutterMachine: () => void;
  onOpenCutDialog: () => void;
  /** "about 3 min", or null with nothing to cut. */
  estimate: string | null;
  testCut: Control;
  testAt: { x: number; y: number };
  onTestAt: (at: { x: number; y: number }) => void;
  onTestCut: () => void;
};

const btn: CSSProperties = {
  background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer",
};
const field: CSSProperties = { background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12 };
const big: CSSProperties = { ...btn, padding: "8px 14px", fontWeight: 600 };
const toneColor = { idle: "var(--ready)", busy: "var(--accent)", attention: "#fbbf24", unknown: "var(--muted)", gone: "var(--cut)" };

function deviceLabel(d: DeviceInfo): string {
  const where = d.host ? ` on ${d.host}` : "";
  return `${d.machine_id} — ${d.instance_id}${where}`;
}

/** LightBurn's Laser window, for a cutter: pick and connect a cutter, then Start / Stop.
 *  Every button's permission comes from `status.actions` (via `start` and `connectedControl`). */
export function CutterPanel(p: Props) {
  const badge = deviceBadge(p.connected ? p.status : null);
  const percent = progressPercent(p.status);
  const control = p.connected ? connectedControl(p.status, p.connected.host !== null) : null;
  return (
    <section aria-label="Cutter" style={{ padding: 8, borderTop: "1px solid var(--border)", display: "grid", gap: 6 }}>
      <h2 style={{ fontSize: 13, margin: 0 }}>Cutter</h2>
      {p.connected === null ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            aria-label="Cutter device"
            value={p.chosen ?? ""}
            onChange={(e) => p.onChoose(e.target.value)}
            style={{ flex: 1, minWidth: 0, background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12 }}
          >
            {p.devices.length === 0 ? <option value="">No cutter found — plug one in</option> : null}
            {p.devices.map((d) => (
              <option key={`${d.host ?? ""}/${d.instance_id}`} value={d.instance_id}>{deviceLabel(d)}</option>
            ))}
          </select>
          <button style={btn} onClick={p.onRefresh} aria-label="Refresh cutters">↻</button>
          <button style={btn} onClick={p.onConnect} disabled={p.chosen === null || p.busy}>Connect cutter</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <span
            data-testid="cutter-badge"
            style={{ width: 10, height: 10, borderRadius: 5, background: toneColor[badge.tone] }}
          />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {deviceLabel(p.connected)} · {badge.label}
          </span>
          {control ? (
            <button style={btn} onClick={p.onDisconnect} disabled={p.busy}>{control.label}</button>
          ) : null}
        </div>
      )}
      {p.mismatch ? (
        <div role="alert" style={{ fontSize: 12, color: "#fbbf24" }}>
          {p.mismatch}.{" "}
          <button style={btn} onClick={p.onUseCutterMachine}>Use {p.connected?.machine_id}</button>
        </div>
      ) : null}
      {percent !== null ? (
        <div aria-label="Cut progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
          style={{ height: 6, background: "var(--workspace)", border: "1px solid var(--border)" }}>
          <div style={{ width: `${percent}%`, height: "100%", background: "var(--accent)" }} />
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          style={{ ...big, background: p.start.enabled ? "var(--ready)" : "var(--panel)", color: p.start.enabled ? "#000" : "var(--muted)" }}
          onClick={p.onStart}
          disabled={!p.start.enabled}
          title={p.start.reason ?? "Cut every layer with Output on"}
        >
          Start
        </button>
        <button style={big} onClick={p.onStop} disabled={!p.status.actions.cancel}>Stop</button>
        {p.status.actions.resume ? <button style={big} onClick={p.onResume}>Resume</button> : null}
        {p.status.actions.confirm ? <button style={big} onClick={p.onPassDone}>Pass done</button> : null}
      </div>
      {p.estimate ? (
        <div data-testid="cut-estimate" style={{ fontSize: 11, color: "var(--muted)" }} title="Rough: drawing time at the set speeds, plus a few seconds a layer">
          Estimated time: {p.estimate}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
        <button
          style={btn}
          onClick={p.onTestCut}
          disabled={!p.testCut.enabled}
          title={p.testCut.reason ?? "Cut a 10 mm square with a triangle inside, with the top layer's settings"}
        >
          Test cut
        </button>
        <label style={{ display: "flex", gap: 2, alignItems: "center" }}>
          X
          <input aria-label="Test cut X" inputMode="decimal" style={{ width: 40, ...field }} value={p.testAt.x}
            onChange={(e) => p.onTestAt({ ...p.testAt, x: Number(e.target.value) || 0 })} />
        </label>
        <label style={{ display: "flex", gap: 2, alignItems: "center" }}>
          Y
          <input aria-label="Test cut Y" inputMode="decimal" style={{ width: 40, ...field }} value={p.testAt.y}
            onChange={(e) => p.onTestAt({ ...p.testAt, y: Number(e.target.value) || 0 })} />
        </label>
        <span style={{ color: "var(--muted)" }}>mm</span>
      </div>
      {p.start.reason && !p.start.enabled ? (
        <div data-testid="start-reason" style={{ fontSize: 11, color: "var(--muted)" }}>{p.start.reason}</div>
      ) : null}
      {p.notice ? <div role="status" style={{ fontSize: 12 }}>{p.notice}</div> : null}
      <button style={{ ...btn, justifySelf: "start", fontSize: 12 }} onClick={p.onOpenCutDialog}>
        Preview, presets and Cut Hosts…
      </button>
    </section>
  );
}
