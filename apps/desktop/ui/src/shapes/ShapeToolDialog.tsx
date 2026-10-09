// SPDX-License-Identifier: GPL-3.0-or-later
import { useState, type CSSProperties } from "react";
import type { FormValues, ToolForm } from "./viewmodel";

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
  width: 340,
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

const input: CSSProperties = {
  width: 90,
  background: "var(--workspace)",
  color: "var(--text)",
  border: "1px solid var(--border)",
};

/** One form for every shape tool: the fields and what they mean live in the tool's `ToolForm`.
 *  `onApply` resolves whether the edit landed; a refusal keeps the dialog open with what was typed,
 *  so the operator can correct the one field the status bar names rather than start over. */
export function ShapeToolDialog<T>({ form, note, onApply, onClose }: {
  form: ToolForm<T>;
  /** A line under the title saying what the tool will act on. */
  note?: string;
  onApply: (value: T) => Promise<boolean>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<FormValues>(form.defaults);
  const [busy, setBusy] = useState(false);
  const parsed = form.parse(values);
  const set = (key: string, v: string | boolean) => setValues((prev) => ({ ...prev, [key]: v }));

  const apply = async () => {
    if (!parsed.ok || busy) return;
    setBusy(true);
    const ok = await onApply(parsed.value);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div style={panelStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={form.title}
        style={dialogStyle}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") void apply();
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong>{form.title}</strong>
          <div style={{ flex: 1 }} />
          <button aria-label="Close" style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        {note ? <span style={{ fontSize: 12, color: "var(--muted)" }}>{note}</span> : null}
        {form.fields.map((f) => (
          <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            {f.kind === "checkbox" ? (
              <>
                <input type="checkbox" aria-label={f.label} checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} />
                <span>{f.label}</span>
              </>
            ) : (
              <>
                <span style={{ flex: 1 }}>{f.label}</span>
                {f.kind === "number" ? (
                  <>
                    <input
                      type="number"
                      aria-label={f.label}
                      step={f.step ?? 1}
                      style={input}
                      value={String(values[f.key] ?? "")}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                    <span style={{ width: 20, color: "var(--muted)" }}>{f.unit ?? ""}</span>
                  </>
                ) : (
                  <select aria-label={f.label} value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </label>
        ))}
        {!parsed.ok ? <span role="alert" style={{ fontSize: 12, color: "var(--cut)" }}>{parsed.error}</span> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }} />
          <button aria-label="Cancel" style={btn} onClick={onClose}>
            Cancel
          </button>
          <button aria-label={form.apply} style={btn} disabled={!parsed.ok || busy} onClick={() => void apply()}>
            {form.apply}
          </button>
        </div>
      </div>
    </div>
  );
}
