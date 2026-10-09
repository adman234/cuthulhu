// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { toCutRequest, toTravelPasses, type Caps, type Preset, type PresetLookup } from "../cut/viewmodel";
import type { DocSnapshot } from "../App";
import type { Scene } from "../render/hittest";
import { loadOperator, operatorForRequest, saveOperator } from "../operator";
import { canToggle, statusLine } from "../printcut/viewmodel";
import { CutsPanel } from "./CutsPanel";
import { CutterPanel } from "./CutterPanel";
import {
  MEDIA, currentMedia, estimateSeconds, formatDuration, heldFromJob, machineMismatch,
  moveKey, mutedNodeIds, orderRows, readBeginner, rowsFromPlan, shouldAutoMirror, startControl,
  testCutControl, toPassSettings, writeBeginner,
  type CutRow, type DockPlan,
} from "./cutsModel";

/** `window.localStorage` itself can throw (blocked site data), not just its methods. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The same offline placeholder the cut dialog uses: preflight ignores what a machine does not
// support, so an optimistic default cannot mis-send anything.
const ALL_ENABLED: Caps = { supportsSpeed: true, supportsForce: true, needsOperatorPassConfirm: false };

/** How long the document must sit still before the Cuts panel replans. Every drag commit lands a
 *  new snapshot; planning each one would replan several times per second for no one to read. */
const REPLAN_DEBOUNCE_MS = 150;

type Props = {
  /** The current document snapshot: a new one means "replan", and its `job` holds the saved
   *  layer settings, order and mirror. */
  doc: DocSnapshot | null;
  scene: Scene;
  /** Runs a document command the way every other edit runs (refused while a document loads,
   *  snapshot refreshed after), for the layer settings this dock saves into the project. */
  onJobEdit: (call: () => Promise<unknown>) => void;
  /** The shapes whose layer has Output off, for the canvas to dim. */
  onMuted: (ids: number[]) => void;
  /** Opens the print & cut dialog, where marks are laid out and the printable sheet exported. */
  onOpenPrintCut: () => void;
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
  const planSeq = useRef(0);

  const [devices, setDevices] = useState<ipc.DeviceInfo[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [connected, setConnected] = useState<ipc.DeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [presets, setPresets] = useState<{ machineId: string; list: Preset[] } | null>(null);
  const [caps, setCaps] = useState<Caps>(ALL_ENABLED);
  const [beginner, setBeginnerState] = useState(() => readBeginner(storage()));
  const setBeginner = (on: boolean) => {
    writeBeginner(storage(), on);
    setBeginnerState(on);
  };
  const [testAt, setTestAt] = useState({ x: 0, y: 0 });
  const [operator, setOperatorState] = useState(loadOperator);
  const setOperator = (name: string) => {
    saveOperator(name);
    setOperatorState(name);
  };
  const [registration, setRegistration] = useState<ipc.RegistrationStatus | null>(null);
  // Read with every snapshot: marks are document shapes, so adding, moving or undoing them is a
  // document change, and the switch must say what the next cut will do.
  useEffect(() => {
    let live = true;
    ipc.registrationStatus().then((s) => { if (live) setRegistration(s); }).catch(() => { if (live) setRegistration(null); });
    return () => { live = false; };
  }, [doc]);
  const travelSeq = useRef(0);
  // The latest snapshot, for the replan's reply: it lands after the effect that asked for it. The
  // document is the record of what the operator set, so a reloaded project or another edit is
  // what the rows show.
  const docRef = useRef(doc);
  docRef.current = doc;

  const replan = useCallback(() => {
    const seq = ++planSeq.current;
    setPlanning(true);
    ipc
      .planCut("Color")
      .then((r) => {
        if (seq !== planSeq.current) return; // a newer replan owns the panel
        const order = docRef.current?.job?.pass_order ?? [];
        setPlan({
          revision: r.doc_revision,
          rows: orderRows(rowsFromPlan(r.passes, heldFromJob(docRef.current?.job)), order),
          skippedNotCut: r.skipped_not_cut,
          // Planned in the planner's own order; reordered or disabled rows ask again below.
          travel: order.length === 0 ? r.travel : [],
        });
        if (order.length > 0) refreshTravel(r.doc_revision, orderRows(r.passes.map((x) => ({ key: x.key, enabled: true })), order));
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
    // Planning from the moment the document moves, not from when the debounced request leaves:
    // in between, the rows on screen belong to a revision the backend will refuse, so Start must
    // already be withheld — a press in that window was a cut refused as stale.
    setPlanning(true);
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

  // Travel for the rows as they stand. Only the newest request may install its answer, and a
  // stale-plan refusal is silent: the replan the document change triggered is already on its way.
  function refreshTravel(revision: string, rows: { key: string; enabled: boolean }[]) {
    const seq = ++travelSeq.current;
    ipc
      .travelForOrder(revision, "Color", toTravelPasses(rows))
      .then((travel) => {
        if (seq === travelSeq.current) setPlan((prev) => (prev && prev.revision === revision ? { ...prev, travel } : prev));
      })
      .catch(() => {});
  }

  const updateRow = (i: number, patch: Partial<CutRow>) => {
    if (plan === null) return;
    const rows = plan.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setPlan({ ...plan, rows });
    props.onJobEdit(() => ipc.setPassSettings(rows[i].key, toPassSettings(rows[i])));
    if (patch.enabled !== undefined) refreshTravel(plan.revision, rows);
    if (patch.presetId !== undefined) {
      const preset = lookup.presets.find((x) => x.id === patch.presetId);
      if (shouldAutoMirror(preset, doc?.job?.mirror ?? false)) {
        props.onJobEdit(() => ipc.setMirror(true));
        setNotice(`Mirror turned on: ${preset?.name} is cut face down.`);
      }
    }
  };

  const moveRow = (i: number, dir: -1 | 1) => {
    if (plan === null) return;
    const keys = moveKey(plan.rows, i, dir);
    if (keys === null) return;
    const rows = orderRows(plan.rows, keys);
    setPlan({ ...plan, rows });
    props.onJobEdit(() => ipc.setPassOrder(keys));
    refreshTravel(plan.revision, rows);
  };

  const { onMuted } = props;
  useEffect(() => onMuted(plan ? mutedNodeIds(plan.rows) : []), [plan, onMuted]);

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
      .cut(toCutRequest(connected.instance_id, plan.revision, "Color", plan.rows, operatorForRequest(operator)))
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

  const testCut = testCutControl({ status, connected, sending, mismatch });
  const runTestCut = () => {
    if (!testCut.enabled || connected === null) return;
    // The top layer's settings, Output on or not: a test cut checks the material a member is
    // about to cut, which is the first one in the list.
    const row = plan?.rows[0];
    const pass = toCutRequest(connected.instance_id, "", "Color", row ? [row] : [])
      .passes[0] ?? { key: "all", enabled: true, preset_id: null, speed: null, force: null, repeat_count: null, track_enhancing: null, tool: null };
    setSending(true);
    ipc
      .testCut({ device_instance_id: connected.instance_id, x_mm: testAt.x, y_mm: testAt.y, pass, operator: operatorForRequest(operator) })
      .then(() => setNotice("Test cut sent."))
      .catch((e) => onError(ipc.ipcErrorMessage(e)))
      .finally(() => setSending(false));
  };

  const rows = plan?.rows ?? [];
  const estimate = rows.some((r) => r.enabled && r.shapeCount > 0) ? formatDuration(estimateSeconds(rows, lookup)) : null;
  const media = doc ? currentMedia(doc.artboard, doc.machine) : null;
  const pickMedia = (id: string) => {
    const m = MEDIA.find((x) => x.id === id);
    if (m) props.onJobEdit(() => ipc.setMedia(m.w, m.h));
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
          <CutsPanel
            plan={plan}
            planning={planning}
            planError={planError}
            lookup={lookup}
            caps={caps}
            onChange={updateRow}
            onMove={moveRow}
            beginner={beginner}
            onBeginner={setBeginner}
            mirror={doc?.job?.mirror ?? false}
            onMirror={(on) => props.onJobEdit(() => ipc.setMirror(on))}
            media={media}
            mediaDisabled={doc?.machine ? null : "Choose a machine first"}
            onMedia={pickMedia}
            scene={props.scene}
            artboard={doc?.artboard ?? { x: 0, y: 0, w: 0, h: 0 }}
            registration={caps.supportsRegistration
              ? { checked: registration?.enabled ?? false, disabled: !canToggle(registration), line: statusLine(registration) }
              : null}
            onRegistration={(on) => props.onJobEdit(() => ipc.setRegistrationEnabled(on))}
            onOpenMarks={props.onOpenPrintCut}
          />
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
        estimate={estimate}
        testCut={testCut}
        testAt={testAt}
        onTestAt={setTestAt}
        onTestCut={runTestCut}
        operator={operator}
        onOperator={setOperator}
      />
    </div>
  );
}
