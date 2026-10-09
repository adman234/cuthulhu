// SPDX-License-Identifier: GPL-3.0-or-later
import { PALETTE, swatchCss } from "./palette";

type Props = {
  /** Why a swatch would do nothing right now (no selection, edits locked), or null. */
  disabledReason: string | null;
  onPick: (rgba: number) => void;
};

/** LightBurn's colour strip: pick a swatch to put the selection on that cut layer. */
export function ColorPalette({ disabledReason, onPick }: Props) {
  return (
    <div
      role="toolbar"
      aria-label="Layer colours"
      title={disabledReason ?? "Put the selection on this colour's cut layer"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        background: "var(--panel)",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span style={{ fontSize: 11, color: "var(--muted)", marginRight: 6 }}>Layer</span>
      {PALETTE.map((s, i) => (
        <button
          key={s.rgba}
          aria-label={`Put selection on ${s.name}`}
          title={disabledReason ?? `${s.name} layer`}
          disabled={disabledReason !== null}
          onClick={() => onPick(s.rgba)}
          style={{
            width: 26,
            height: 20,
            padding: 0,
            fontSize: 10,
            color: (s.rgba >>> 8) < 0x808080 ? "#fff" : "#000",
            background: swatchCss(s.rgba),
            border: "1px solid var(--border)",
            cursor: disabledReason === null ? "pointer" : "default",
            opacity: disabledReason === null ? 1 : 0.5,
          }}
        >
          {String(i).padStart(2, "0")}
        </button>
      ))}
    </div>
  );
}
