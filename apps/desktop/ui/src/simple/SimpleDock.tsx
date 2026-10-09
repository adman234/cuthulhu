// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { toCutRequest, type Caps, type Preset, type PresetLookup } from "../cut/viewmodel";
import { CutsPanel } from "./CutsPanel";
import { CutterPanel } from "./CutterPanel";
import {
  holdSettings, machineMismatch, rowsFromPlan, startControl,
  type CutRow, type DockPlan, type RowSettings,
} from "./cutsModel";

// The same offline placeholder the cut dialog uses: preflight ignores what a machine does not
// support, so an optimistic default cannot mis-send anything.
const ALL_ENABLED: Caps = { supportsSpeed: true, supportsForce: true, needsOperatorPassConfirm: false };

/** How long the document must sit still before the Cuts panel replans. Every drag commit lands a
 *  new snapshot; planning each one would replan several times per second for no one to read. */
const REPLAN_DEBOUNCE_MS = 150;

type Props = {
  /** The current document snapshot. Only its identity is read: a new one means "replan". */
  doc: unknown;
  docMachineId: string | null;
  status: ipc.CutStatus;
  refreshDeviceState: () => Promise<void>;
  onError: (msg: string) => void;
  onConvertMachine: (machineId: string) => void;
  onOpenCutDialog: () => void;
  /** Rendered between the Cuts and Cutter panels — the classic Objects panels, behind a tab. */
  objects: ReactNode;
  /** Where the dock sits in the window's grid, so it can run down beside the palette row. */
  gridRow?: string;
};

/** The simple shell's right-hand dock: Cuts / Layers (or Objects) above, Cutter below.
 *
 *  It plans with `Grouping::Color` because colour is how this shell names a layer — the palette
 *  under the canvas puts shapes on one. Everything that decides anything is the cut dialog's own
 *  viewmodel or `cutsModel.ts`; this component holds state and makes the calls. */
export function SimpleDock(props: Props) {
  const { doc, docMachineId, status, refreshDeviceState, onError, onConvertMachine } = props;
  const [tab, setTab] = useState<"cuts" | "objects">("cuts");

  const [plan, setPlan] = useState<DockPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const held = useRef<Map<string, RowSettings>>(new Map());
  const planSeq = useRef(0);

  const [devices, setDevices] = useState<ipc.DeviceInfo[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [connected, setConnected] = useState<ipc.DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [presets, setPresets] = useState<{ machineId: string; list: Preset[] } | null>(null);
  const [caps, setCaps] = useState<Caps>(ALL_ENABLED);

  const replan = useCallback(() => {
    const seq = ++planSeq.current;
    setPlanning(true);
    ipc
      .planCut("Color")
      .then((r) => {
        if (seq !== planSeq.current) return; // a newer replan owns the panel
        setPlan({ revision: r.doc_revision, rows: rowsFromPlan(r.passes, held.current), skippedNotCut: r.skipped_not_cut });
        setPlanError(null);
      })
      .catch((e) => {
        // Kept, not cleared: the last plan stays on screen, and Start stays tied to its revision,
        // which the backend refuses if the document has moved on.
        if (seq === planSeq.current) setPlanError(ipc.ipcErrorMessage(e));
      })
      .finally(() => {
        if (seq === planSeq.current) setPlanning(false);
      });
  }, []);

  useEffect(() => {
    if (doc === null) return;
    const t = setTimeout(replan, REPLAN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [doc, replan]);

  const refreshDevices = useCallback(() => {
    ipc
      .listDevices()
      .then((d) => {
        setDevices(d);
        // Keep the operator's pick while it is still offered; otherwise offer the first cutter,
        // which in a makerspace is usually the only one.
        setChosen((prev) => (prev !== null && d.some((x) => x.instance_id === prev) ? prev : d[0]?.instance_id ?? null));
      })
      .catch((e) => onError(ipc.ipcErrorMessage(e)));
  }, [onError]);

  useEffect(refreshDevices, [refreshDevices]);

  // The backend's connection is the truth, and the cut dialog can change it behind this dock's
  // back. Every connect or disconnect moves the phase, so re-reading on each phase change keeps
  // the dock from offering Connect for a cutter that is already connected, or the reverse.
  useEffect(() => {
    ipc.getConnectedDevice().then(setConnected).catch((e) => onError(ipc.ipcErrorMessage(e)));
  }, [status.phase, onError]);

  // Poll for a cutter being plugged in, only while none is connected: enumeration is a USB scan
  // plus a request to every paired host, and nothing on screen changes once one is chosen.
  useEffect(() => {
    if (connected !== null) return;
    const id = setInterval(refreshDevices, 2000);
    return () => clearInterval(id);
  }, [connected, refreshDevices]);

  // Presets and caps belong to a machine: the cutter's when one is connected, else the design's.
  const machineId = connected?.machine_id ?? docMachineId;
  useEffect(() => {
    if (machineId === null) {
      setPresets(null);
      setCaps(ALL_ENABLED);
      return;
    }
    let live = true;
    ipc
      .listPresets(machineId)
      .then((list) => { if (live) setPresets({ machineId, list: list as Preset[] }); })
      .catch((e) => { if (live) { setPresets(null); onError(ipc.ipcErrorMessage(e)); } });
    ipc
      .machineCaps(machineId)
      .then((c) => { if (live) setCaps(c as Caps); })
      .catch(() => { if (live) setCaps(ALL_ENABLED); });
    return () => { live = false; };
  }, [machineId, onError]);

  const lookup: PresetLookup =
    presets !== null && presets.machineId === machineId ? { presets: presets.list, loaded: true } : { presets: [], loaded: false };

  const updateRow = (i: number, patch: Partial<CutRow>) => {
    setPlan((prev) => {
      if (prev === null) return prev;
      const rows = prev.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      held.current = holdSettings(held.current, rows[i]);
      return { ...prev, rows };
    });
  };

  const connect = () => {
    const info = devices.find((d) => d.instance_id === chosen);
    if (!info) return;
    setBusy(true);
    ipc
      .connectDevice(info)
      .then(() => {
        setConnected(info);
        setNotice(null);
        return refreshDeviceState();
      })
      .catch((e) => onError(ipc.ipcErrorMessage(e)))
      .finally(() => setBusy(false));
  };

  const disconnect = () => {
    if (connected === null) return;
    setBusy(true);
    const onHost = connected.host !== null;
    (onHost ? ipc.reconnectDevice() : ipc.disconnectDevice())
      .then(() => {
        if (!onHost) setConnected(null);
        return refreshDeviceState();
      })
      .catch((e) => onError(ipc.ipcErrorMessage(e)))
      .finally(() => setBusy(false));
  };

  const mismatch = machineMismatch(docMachineId, connected);
  const start = startControl({ status, connected, plan, planning, sending, mismatch });

  const startCut = () => {
    if (!start.enabled || connected === null || plan === null) return;
    setSending(true);
    setNotice(null);
    ipc
      .cut(toCutRequest(connected.instance_id, plan.revision, "Color", plan.rows))
      .then((started) => setNotice(started.duplicate ? "Already cutting this job." : "Cutting…"))
      .catch((e) => {
        if (ipc.ipcErrorCode(e) === "stale_plan") {
          // The design moved between the last plan and the press. Replan rather than guess, and
          // say so: the member presses Start again on rows that match what will be cut.
          setNotice("The design changed — check the layers and press Start again.");
          replan();
          return;
        }
        onError(ipc.ipcErrorMessage(e));
      })
      .finally(() => setSending(false));
  };

  const act = (call: () => Promise<void>) => () => {
    call().then(refreshDeviceState).catch((e) => onError(ipc.ipcErrorMessage(e)));
  };

  const tabBtn = (id: "cuts" | "objects", label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        flex: 1, padding: "6px 0", fontSize: 12, cursor: "pointer", color: "var(--text)",
        background: tab === id ? "var(--workspace)" : "var(--panel)", border: "none",
        borderBottom: tab === id ? "2px solid var(--accent)" : "2px solid transparent",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ gridRow: props.gridRow, display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: 0, borderLeft: "1px solid var(--border)", background: "var(--panel)" }}>
      <div role="tablist" aria-label="Dock" style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {tabBtn("cuts", "Cuts / Layers")}
        {tabBtn("objects", "Objects")}
      </div>
      <div style={{ minHeight: 0, overflow: "auto", display: "grid" }}>
        {tab === "cuts" ? (
          <CutsPanel plan={plan} planning={planning} planError={planError} lookup={lookup} caps={caps} onChange={updateRow} />
        ) : (
          props.objects
        )}
      </div>
      <CutterPanel
        status={status}
        devices={devices}
        chosen={chosen}
        onChoose={setChosen}
        connected={connected}
        busy={busy}
        start={start}
        mismatch={mismatch}
        notice={notice}
        onConnect={connect}
        onDisconnect={disconnect}
        onRefresh={refreshDevices}
        onStart={startCut}
        onStop={act(ipc.cancelCut)}
        onResume={act(ipc.resumeCut)}
        onPassDone={act(ipc.confirmPassDone)}
        onUseCutterMachine={() => connected && onConvertMachine(connected.machine_id)}
        onOpenCutDialog={props.onOpenCutDialog}
      />
    </div>
  );
}
