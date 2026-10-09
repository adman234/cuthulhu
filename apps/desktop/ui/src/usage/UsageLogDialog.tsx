// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import * as ipc from "../ipc";
import {
  OUTCOME_LABEL,
  formatDuration,
  formatLength,
  formatWhen,
  materialsOf,
  totalsByMaterial,
  totalsByOperator,
  type Total,
} from "./viewmodel";

/** How many jobs the dialog reads. Totals are over these, and the dialog says so; the CSV export
 *  is the whole log. */
const SHOWN = 500;

const panelStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const dialogStyle: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  padding: 16,
  width: 760,
  maxHeight: "85vh",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const btn: CSSProperties = {
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  cursor: "pointer",
};

const table: CSSProperties = { borderCollapse: "collapse", fontSize: 12, width: "100%" };
const cell: CSSProperties = { borderBottom: "1px solid var(--border)", padding: "2px 6px", textAlign: "left" };

type LogState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; entries: ipc.UsageEntry[] };

function TotalsTable({ label, rows }: { label: string; rows: Total[] }) {
  return (
    <table aria-label={`Totals by ${label.toLowerCase()}`} style={table}>
      <thead>
        <tr>
          <th style={cell}>{label}</th>
          <th style={cell}>Jobs</th>
          <th style={cell}>Completed</th>
          <th style={cell}>Cut length</th>
          <th style={cell}>Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td style={cell}>{r.name}</td>
            <td style={cell}>{r.jobs}</td>
            <td style={cell}>{r.completed}</td>
            <td style={cell}>{formatLength(r.lengthMm)}</td>
            <td style={cell}>{formatDuration(r.seconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageLogDialog({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<LogState>({ kind: "loading" });
  /** What the last export did, in words — a count on success, the backend's refusal otherwise. */
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let ignore = false;
    ipc.usageLog(SHOWN).then(
      (entries) => { if (!ignore) setLog({ kind: "ready", entries }); },
      (e) => { if (!ignore) setLog({ kind: "error", message: ipc.ipcErrorMessage(e) }); },
    );
    return () => { ignore = true; };
  }, []);

  const exportCsv = async () => {
    setExporting(true);
    setExported(null);
    try {
      const path = await ipc.pickCsvSavePath();
      if (path === null) return;
      const count = await ipc.exportUsageCsv(path);
      setExported({ ok: true, text: `Exported ${count} job${count === 1 ? "" : "s"} to ${path}` });
    } catch (e) {
      setExported({ ok: false, text: ipc.ipcErrorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={panelStyle}>
      <div role="dialog" aria-modal="true" aria-label="Usage log" style={dialogStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong>Usage log</strong>
          <div style={{ flex: 1 }} />
          <button aria-label="Export CSV" style={btn} disabled={exporting} onClick={exportCsv}>
            Export CSV…
          </button>
          <button aria-label="Close" style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        {exported !== null ? (
          <div role="status" style={{ fontSize: 12, color: exported.ok ? "var(--muted)" : "var(--cut)" }}>
            {exported.text}
          </div>
        ) : null}

        {log.kind === "loading" ? <span style={{ fontSize: 12 }}>Reading the usage log…</span> : null}
        {log.kind === "error" ? <span style={{ fontSize: 12, color: "var(--cut)" }}>{log.message}</span> : null}
        {log.kind === "ready" && log.entries.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>No cuts have been logged on this computer yet.</span>
        ) : null}
        {log.kind === "ready" && log.entries.length > 0 ? (
          <>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {log.entries.length === SHOWN
                ? `Totals over the newest ${SHOWN} jobs; Export CSV has the whole log.`
                : `Totals over all ${log.entries.length} logged job${log.entries.length === 1 ? "" : "s"}.`}
            </div>
            <TotalsTable label="Operator" rows={totalsByOperator(log.entries)} />
            <TotalsTable label="Material" rows={totalsByMaterial(log.entries)} />
            <table aria-label="Recent jobs" style={table}>
              <thead>
                <tr>
                  <th style={cell}>Started</th>
                  <th style={cell}>Operator</th>
                  <th style={cell}>Cutter</th>
                  <th style={cell}>Document</th>
                  <th style={cell}>Materials</th>
                  <th style={cell}>Length</th>
                  <th style={cell}>Time</th>
                  <th style={cell}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {log.entries.map((e, i) => (
                  <tr key={`${e.started_at}-${i}`} data-testid="usage-row">
                    <td style={cell}>{formatWhen(e.started_at)}</td>
                    <td style={cell}>{e.operator ?? ""}</td>
                    <td style={cell}>{e.host ? `${e.machine_id} on ${e.host}` : e.machine_id}</td>
                    <td style={cell}>{e.document ?? ""}</td>
                    <td style={cell}>{materialsOf(e)}</td>
                    <td style={cell}>{formatLength(e.cut_length_mm)}</td>
                    <td style={cell}>{formatDuration(e.duration_s)}</td>
                    <td style={{ ...cell, color: e.outcome === "failed" ? "var(--cut)" : undefined }} title={e.error ?? undefined}>
                      {OUTCOME_LABEL[e.outcome]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </div>
    </div>
  );
}
