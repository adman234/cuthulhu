// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import * as ipc from "../ipc";
import { fontsLoaded, readTextDraft, selectFamily, type FontListState, type TextDraft, type TextSource } from "./viewmodel";

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
  width: 360,
  maxWidth: "calc(100vw - 32px)",
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

const field: CSSProperties = {
  background: "var(--workspace)",
  color: "var(--text)",
  border: "1px solid var(--border)",
};

/** Adds a Text node, or — given `editing` — rewrites one, prefilled with its words, size and face.
 *  `onSubmit` resolves whether the edit landed; a refusal keeps what was typed on screen. */
export function TextDialog({ editing, onSubmit, onClose }: {
  editing?: TextSource;
  onSubmit: (draft: TextDraft) => Promise<boolean>;
  onClose: () => void;
}) {
  const [fonts, setFonts] = useState<FontListState>({ kind: "loading" });
  const [text, setText] = useState(editing?.text ?? "Text");
  const [size, setSize] = useState(String(editing?.size_mm ?? 10));
  const [busy, setBusy] = useState(false);
  const preferred = editing?.family;

  useEffect(() => {
    let ignore = false;
    ipc.listFonts().then(
      (families) => { if (!ignore) setFonts(fontsLoaded(families, preferred)); },
      (e) => { if (!ignore) setFonts({ kind: "error", message: ipc.ipcErrorMessage(e) }); },
    );
    return () => { ignore = true; };
  }, [preferred]);

  const read = readTextDraft(fonts, text, size);
  const title = editing ? "Edit text" : "Add text";
  const submit = async () => {
    if (!read.ok || busy) return;
    setBusy(true);
    const ok = await onSubmit(read.draft);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div style={panelStyle}>
      <div role="dialog" aria-modal="true" aria-label={title} style={dialogStyle}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong>{title}</strong>
          <div style={{ flex: 1 }} />
          <button aria-label="Close" style={btn} onClick={onClose}>
            Close
          </button>
        </div>

        <textarea
          aria-label="Text content"
          rows={3}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          style={{ ...field, resize: "vertical", fontSize: 14 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ flex: 1 }}>Size (letter height)</span>
          <input type="number" aria-label="Text size" min={0} step={1} value={size} onChange={(e) => setSize(e.target.value)} style={{ ...field, width: 80 }} />
          <span style={{ color: "var(--muted)" }}>mm</span>
        </label>

        {fonts.kind === "loading" && <span style={{ fontSize: 12 }}>Listing fonts…</span>}
        {fonts.kind === "empty" && (
          <span style={{ fontSize: 12 }}>No fonts were found on this system</span>
        )}
        {fonts.kind === "error" && (
          <span style={{ fontSize: 12, color: "var(--cut)" }}>{fonts.message}</span>
        )}
        {fonts.kind === "ready" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span>Font</span>
            <select
              aria-label="Font family"
              style={{ flex: 1 }}
              value={fonts.selected}
              onChange={(e) => setFonts((f) => selectFamily(f, e.target.value))}
            >
              {fonts.families.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </label>
        )}
        {!read.ok && fonts.kind === "ready" ? <span role="alert" style={{ fontSize: 12, color: "var(--cut)" }}>{read.error}</span> : null}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }} />
          <button aria-label="Cancel" style={btn} onClick={onClose}>
            Cancel
          </button>
          <button aria-label={editing ? "Apply" : "Insert"} style={btn} disabled={!read.ok || busy} onClick={() => void submit()}>
            {editing ? "Apply" : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
