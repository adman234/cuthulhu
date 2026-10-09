// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import * as ipc from "../ipc";
import { areaFromDraft, canToggle, draftFromArea, PAPERS, statusLine, type AreaDraft } from "./viewmodel";

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
  width: 420,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontSize: 12,
};

const btn: CSSProperties = {
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  cursor: "pointer",
};

const field: CSSProperties = { width: 70 };

/** Print & cut: lay out registration marks, switch registration on or off, and export the sheet to
 *  print. Every decision is the backend's; this only gathers numbers and says what came back.
 *  `onChanged` re-reads the document after anything that edits it. */
export function PrintCutDialog({ onChanged, onClose }: { onChanged: () => Promise<unknown>; onClose: () => void }) {
  const [paper, setPaper] = useState<ipc.Paper>("letter");
  const [draft, setDraft] = useState<AreaDraft | null>(null);
  const [status, setStatus] = useState<ipc.RegistrationStatus | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const readStatus = useCallback(async () => {
    setStatus(await ipc.registrationStatus());
  }, []);

  useEffect(() => {
    readStatus().catch((e) => setMessage({ text: ipc.ipcErrorMessage(e), error: true }));
  }, [readStatus]);

  // The paper's default layout fills the fields whenever the paper changes, so the inset comes
  // from the backend's template rather than from a second copy here.
  useEffect(() => {
    let ignore = false;
    ipc.registrationAreaForPaper(paper).then(
      (a) => { if (!ignore) setDraft(draftFromArea(a)); },
      (e) => { if (!ignore) setMessage({ text: ipc.ipcErrorMessage(e), error: true }); },
    );
    return () => { ignore = true; };
  }, [paper]);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const done = await fn();
      if (done !== null) setMessage({ text: done, error: false });
    } catch (e) {
      setMessage({ text: ipc.ipcErrorMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const addMarks = () =>
    act(async () => {
      if (!draft) return null;
      const parsed = areaFromDraft(draft);
      if ("error" in parsed) throw new Error(parsed.error);
      await ipc.addRegistrationMarks(parsed.area);
      await onChanged();
      await readStatus();
      return "Registration marks added.";
    });

  const toggle = (on: boolean) =>
    act(async () => {
      await ipc.setRegistrationEnabled(on);
      await onChanged();
      await readStatus();
      return null;
    });

  const exportSheet = () =>
    act(async () => {
      const path = await ipc.pickPrintPath();
      if (!path) return null;
      await ipc.exportPrintSvg(path, paper);
      return `Saved ${path}. Print it at 100 % (actual size), then load the sheet with its top-left corner at the cutter's origin.`;
    });

  const setField = (key: keyof AreaDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => (d ? { ...d, [key]: e.target.value } : d));

  return (
    <div style={panelStyle}>
      <div role="dialog" aria-modal="true" aria-label="Print and cut" style={dialogStyle}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong>Print &amp; Cut</strong>
          <div style={{ flex: 1 }} />
          <button aria-label="Close" style={btn} onClick={onClose}>
            Close
          </button>
        </div>

        <div data-testid="registration-status">{statusLine(status)}</div>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>Paper</span>
          <select aria-label="Paper" value={paper} onChange={(e) => setPaper(e.target.value as ipc.Paper)}>
            {PAPERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {draft ? (
          <div style={{ display: "grid", gridTemplateColumns: "auto auto auto auto", gap: 6, alignItems: "center" }}>
            <span>Left (mm)</span>
            <input aria-label="Marks left" style={field} value={draft.originX} onChange={setField("originX")} />
            <span>Top (mm)</span>
            <input aria-label="Marks top" style={field} value={draft.originY} onChange={setField("originY")} />
            <span>Width (mm)</span>
            <input aria-label="Marks width" style={field} value={draft.width} onChange={setField("width")} />
            <span>Length (mm)</span>
            <input aria-label="Marks length" style={field} value={draft.length} onChange={setField("length")} />
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn} disabled={busy || !draft} onClick={addMarks}>
            {status?.marks != null ? "Replace registration marks" : "Add registration marks"}
          </button>
          <button aria-label="Export for printing" style={btn} disabled={busy} onClick={exportSheet}>
            Export for printing…
          </button>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            aria-label="Use registration marks when cutting"
            checked={status?.enabled ?? false}
            disabled={busy || !canToggle(status)}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>Use registration marks when cutting</span>
        </label>

        {message ? (
          <div role={message.error ? "alert" : "status"} style={{ color: message.error ? "var(--cut)" : "var(--text)" }}>
            {message.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
