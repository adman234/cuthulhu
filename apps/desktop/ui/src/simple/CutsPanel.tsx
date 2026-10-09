// SPDX-License-Identifier: GPL-3.0-or-later
import { useState, type CSSProperties } from "react";
import {
  effectiveSettings, fieldDisabled, parsePassKey, passRowLabel, presetPicker,
  type Caps, type PresetLookup,
} from "../cut/viewmodel";
import { CutPreview } from "../cut/CutPreview";
import type { Scene } from "../render/hittest";
import { MEDIA, type CutRow, type DockPlan } from "./cutsModel";
import { PALETTE, swatchCss } from "./palette";

type Props = {
  plan: DockPlan | null;
  planning: boolean;
  planError: string | null;
  lookup: PresetLookup;
  caps: Caps;
  onChange: (index: number, patch: Partial<CutRow>) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  /** Beginner mode: only the material picker and Output are offered. */
  beginner: boolean;
  onBeginner: (on: boolean) => void;
  mirror: boolean;
  onMirror: (on: boolean) => void;
  /** Id from `MEDIA`, or null for a size none of them matches. */
  media: string | null;
  mediaDisabled: string | null;
  onMedia: (id: string) => void;
  scene: Scene;
  artboard: { x: number; y: number; w: number; h: number };
};

const cell: CSSProperties = { padding: "3px 4px", fontSize: 12, borderBottom: "1px solid var(--border)" };
const input: CSSProperties = {
  width: 34, background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12,
};
const control: CSSProperties = {
  background: "var(--workspace)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 12,
};
const tiny: CSSProperties = {
  background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", padding: "0 4px", fontSize: 11, cursor: "pointer",
};

/** A blank field is "use the preset's value", so it reads as null rather than zero. */
function parseOverride(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** What screen readers and tests call a row: the palette's name for a colour it holds, else the
 *  colour itself, else the words the cut dialog uses. */
export function rowName(row: { key: string }, lookup: PresetLookup): string {
  const label = passRowLabel(row.key, lookup, "Color");
  if (label.swatch !== null) {
    return PALETTE.find((s) => swatchCss(s.rgba) === label.swatch)?.name ?? label.swatch;
  }
  return label.text ?? row.key;
}

/** LightBurn's Cuts / Layers window: one row per colour, with its settings and an Output switch,
 *  cut top to bottom. Holds nothing but the preview's open state; the dock owns the rows. */
export function CutsPanel(p: Props) {
  const { plan, planning, planError, lookup, caps } = p;
  const [previewOpen, setPreviewOpen] = useState(false);
  const speedMax = caps.speedMax ?? 30;
  const showTrack = !p.beginner && caps.supportsTrackEnhancing === true;
  const showPen = !p.beginner && caps.supportsPen === true;
  const rows = plan?.rows ?? [];
  return (
    <section aria-label="Cuts" style={{ padding: 8, overflow: "auto", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <h2 style={{ fontSize: 13, margin: 0 }}>Cuts / Layers</h2>
        {planning ? <span style={{ fontSize: 11, color: "var(--muted)" }}>updating…</span> : null}
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={p.beginner} onChange={(e) => p.onBeginner(e.target.checked)} />
          Beginner
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6, fontSize: 12 }}>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }} title={p.mediaDisabled ?? "The media loaded in the cutter; the artboard follows it"}>
          Media
          <select
            aria-label="Media"
            value={p.media ?? ""}
            disabled={p.mediaDisabled !== null}
            onChange={(e) => p.onMedia(e.target.value)}
            style={control}
          >
            {p.media === null ? <option value="">Custom size</option> : null}
            {MEDIA.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }} title="Heat-transfer vinyl is cut face down, so the design is cut mirrored">
          <input type="checkbox" aria-label="Mirror (HTV)" checked={p.mirror} onChange={(e) => p.onMirror(e.target.checked)} />
          Mirror (HTV)
        </label>
      </div>

      {planError ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--cut)", marginBottom: 6 }}>{planError}</div>
      ) : null}
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--muted)" }}>
          Draw or import shapes, then pick a colour below the canvas to put them on a layer.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={cell} title="Cut order: top to bottom">#</th>
              <th style={cell}>Out</th>
              <th style={cell}>Layer</th>
              <th style={cell}>Material</th>
              {p.beginner ? null : (
                <>
                  <th style={cell} title={`1–${speedMax} on this machine`}>Spd</th>
                  <th style={cell}>Force</th>
                  <th style={cell}>Passes</th>
                </>
              )}
              {showTrack ? <th style={cell} title="Track enhancing: rolls the media to grip it (needs force 19+)">Trk</th> : null}
              {showPen ? <th style={cell}>Pen</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const name = rowName(row, lookup);
              const label = passRowLabel(row.key, lookup, "Color");
              const eff = effectiveSettings(row, lookup);
              const picker = presetPicker(row.presetId, lookup);
              const preset = row.presetId !== null ? lookup.presets.find((x) => x.id === row.presetId) : undefined;
              const presetTool = preset?.settings.tool ?? "Blade";
              return (
                <tr key={row.key} data-testid="cuts-row">
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    <button style={tiny} aria-label={`Cut ${name} earlier`} disabled={i === 0} onClick={() => p.onMove(i, -1)}>↑</button>
                    <button style={tiny} aria-label={`Cut ${name} later`} disabled={i === rows.length - 1} onClick={() => p.onMove(i, 1)}>↓</button>
                  </td>
                  <td style={cell}>
                    <input
                      type="checkbox"
                      aria-label={`Output ${name}`}
                      checked={row.enabled}
                      onChange={(e) => p.onChange(i, { enabled: e.target.checked })}
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
                  <td style={cell} title={preset ? materialNote(preset.notes, preset.blade_depth) : undefined}>
                    <select
                      aria-label={`Material for ${name}`}
                      value={picker.selected}
                      onChange={(e) => {
                        const parsed = parsePassKey(e.target.value);
                        p.onChange(i, { presetId: parsed.kind === "preset" ? parsed.presetId : null });
                      }}
                      style={{ ...control, maxWidth: 110 }}
                    >
                      {picker.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  {p.beginner ? null : (
                    <>
                      <td style={cell}>
                        <input
                          aria-label={`Speed for ${name}`}
                          title={`1–${speedMax}`}
                          style={input}
                          inputMode="numeric"
                          disabled={fieldDisabled("speed", caps)}
                          placeholder={eff.speed === null ? "—" : String(eff.speed)}
                          value={row.speed ?? ""}
                          onChange={(e) => p.onChange(i, { speed: parseOverride(e.target.value) })}
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
                          onChange={(e) => p.onChange(i, { force: parseOverride(e.target.value) })}
                        />
                      </td>
                      <td style={cell}>
                        <input
                          aria-label={`Passes for ${name}`}
                          style={input}
                          inputMode="numeric"
                          placeholder={eff.repeatCount === null ? "—" : String(eff.repeatCount)}
                          value={row.repeatCount ?? ""}
                          onChange={(e) => p.onChange(i, { repeatCount: parseOverride(e.target.value) })}
                        />
                      </td>
                    </>
                  )}
                  {showTrack ? (
                    <td style={cell}>
                      <input
                        type="checkbox"
                        aria-label={`Track enhancing for ${name}`}
                        checked={row.trackEnhancing ?? preset?.settings.track_enhancing ?? false}
                        onChange={(e) => p.onChange(i, { trackEnhancing: e.target.checked })}
                      />
                    </td>
                  ) : null}
                  {showPen ? (
                    <td style={cell}>
                      <input
                        type="checkbox"
                        aria-label={`Pen for ${name}`}
                        checked={(row.tool ?? presetTool) === "Pen"}
                        onChange={(e) => p.onChange(i, { tool: e.target.checked ? "Pen" : "Blade" })}
                      />
                    </td>
                  ) : null}
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
      {rows.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          <button style={tiny} aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>
            {previewOpen ? "Hide cut preview" : "Show cut preview"}
          </button>
          {previewOpen ? (
            <div style={{ marginTop: 4 }}>
              <CutPreview
                scene={p.scene}
                artboard={p.artboard}
                passes={rows.map((r) => ({ key: r.key, nodeIds: r.nodeIds, starts: r.starts, enabled: r.enabled }))}
                travel={plan?.travel ?? []}
              />
              {p.mirror ? (
                <p style={{ fontSize: 11, color: "var(--muted)" }}>The preview shows the design as drawn; it is cut mirrored.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** A material's advice, one line, for the picker's tooltip. */
export function materialNote(notes: string | undefined, bladeDepth: number | null | undefined): string | undefined {
  const parts = [bladeDepth ? `Blade depth ${bladeDepth}` : null, notes?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
