// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties } from "react";
import {
  effectiveSettings, fieldDisabled, parsePassKey, passRowLabel, presetPicker,
  type Caps, type PresetLookup,
} from "../cut/viewmodel";
import type { CutRow, DockPlan } from "./cutsModel";
import { PALETTE, swatchCss } from "./palette";

type Props = {
  plan: DockPlan | null;
  planning: boolean;
  planError: string | null;
  lookup: PresetLookup;
  caps: Caps;
  onChange: (index: number, patch: Partial<CutRow>) => void;
};

const cell: CSSProperties = { padding: "3px 4px", fontSize: 12, borderBottom: "1px solid var(--border)" };
const input: CSSProperties = {
  width: 38, background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12,
};

/** A blank field is "use the preset's value", so it reads as null rather than zero. */
function parseOverride(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** What screen readers and tests call a row: the palette's name for a colour it holds, else the
 *  colour itself, else the words the cut dialog uses. */
function rowName(row: CutRow, lookup: PresetLookup): string {
  const label = passRowLabel(row.key, lookup, "Color");
  if (label.swatch !== null) {
    return PALETTE.find((s) => swatchCss(s.rgba) === label.swatch)?.name ?? label.swatch;
  }
  return label.text ?? row.key;
}

/** LightBurn's Cuts / Layers window: one row per colour, with its settings and an Output switch.
 *  Holds nothing; the dock owns the rows and keeps them across replans. */
export function CutsPanel({ plan, planning, planError, lookup, caps, onChange }: Props) {
  return (
    <section aria-label="Cuts" style={{ padding: 8, overflow: "auto", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <h2 style={{ fontSize: 13, margin: 0 }}>Cuts / Layers</h2>
        {planning ? <span style={{ fontSize: 11, color: "var(--muted)" }}>updating…</span> : null}
      </div>
      {planError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--cut)", marginBottom: 6 }}>{planError}</div>
      ) : null}
      {plan === null || plan.rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--muted)" }}>
          Draw or import shapes, then pick a colour below the canvas to put them on a layer.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={cell}>Out</th>
              <th style={cell}>Layer</th>
              <th style={cell}>Material</th>
              <th style={cell} title="1–10 on a Cameo 1">Spd</th>
              <th style={cell}>Force</th>
              <th style={cell}>Passes</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((row, i) => {
              const name = rowName(row, lookup);
              const label = passRowLabel(row.key, lookup, "Color");
              const eff = effectiveSettings(row, lookup);
              const picker = presetPicker(row.presetId, lookup);
              return (
                <tr key={row.key} data-testid="cuts-row">
                  <td style={cell}>
                    <input
                      type="checkbox"
                      aria-label={`Output ${name}`}
                      checked={row.enabled}
                      onChange={(e) => onChange(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td style={cell}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {label.swatch ? (
                        <span style={{ width: 14, height: 14, background: label.swatch, border: "1px solid var(--border)" }} />
                      ) : null}
                      <span>{name}</span>
                      <span style={{ color: "var(--muted)" }}>×{row.shapeCount}</span>
                    </span>
                  </td>
                  <td style={cell}>
                    <select
                      aria-label={`Material for ${name}`}
                      value={picker.selected}
                      onChange={(e) => {
                        const parsed = parsePassKey(e.target.value);
                        onChange(i, { presetId: parsed.kind === "preset" ? parsed.presetId : null });
                      }}
                      style={{ maxWidth: 110, background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12 }}
                    >
                      {picker.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td style={cell}>
                    <input
                      aria-label={`Speed for ${name}`}
                      style={input}
                      inputMode="numeric"
                      disabled={fieldDisabled("speed", caps)}
                      placeholder={eff.speed === null ? "—" : String(eff.speed)}
                      value={row.speed ?? ""}
                      onChange={(e) => onChange(i, { speed: parseOverride(e.target.value) })}
                    />
                  </td>
                  <td style={cell}>
                    <input
                      aria-label={`Force for ${name}`}
                      style={input}
                      inputMode="numeric"
                      disabled={fieldDisabled("force", caps)}
                      placeholder={eff.force === null ? "—" : String(eff.force)}
                      value={row.force ?? ""}
                      onChange={(e) => onChange(i, { force: parseOverride(e.target.value) })}
                    />
                  </td>
                  <td style={cell}>
                    <input
                      aria-label={`Passes for ${name}`}
                      style={input}
                      inputMode="numeric"
                      placeholder={eff.repeatCount === null ? "—" : String(eff.repeatCount)}
                      value={row.repeatCount ?? ""}
                      onChange={(e) => onChange(i, { repeatCount: parseOverride(e.target.value) })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {plan && plan.skippedNotCut > 0 ? (
        <p style={{ fontSize: 11, color: "var(--muted)" }}>
          {plan.skippedNotCut} shape{plan.skippedNotCut === 1 ? " is" : "s are"} set not to cut.
        </p>
      ) : null}
    </section>
  );
}
