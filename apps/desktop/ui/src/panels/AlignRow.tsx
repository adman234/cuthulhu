// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties } from "react";
import type { AlignMode, Axis } from "../interaction/align";

type Props = {
  /** Selected ids that move as a piece; see `outermost`. */
  unitCount: number;
  /** Per axis, from `canDistribute`: three units are not enough when one spans the others. */
  distributable: Record<Axis, boolean>;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: Axis) => void;
};

const ALIGNS: { mode: AlignMode; label: string }[] = [
  { mode: "left", label: "Align left edges" },
  { mode: "hcenter", label: "Align horizontal centres" },
  { mode: "right", label: "Align right edges" },
  { mode: "top", label: "Align top edges" },
  { mode: "vmiddle", label: "Align vertical middles" },
  { mode: "bottom", label: "Align bottom edges" },
];
const DISTRIBUTES: { axis: Axis; label: string }[] = [
  { axis: "x", label: "Distribute horizontal spacing" },
  { axis: "y", label: "Distribute vertical spacing" },
];

const btn: CSSProperties = {
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: 3,
  cursor: "pointer",
  lineHeight: 0,
};

/** Drawn for x and turned a quarter for y, so the two families cannot drift apart. The line sits
 *  where the mode lines up (0, ½ or 1 across), with a long and a short bar against it. */
function AlignIcon({ at, vertical }: { at: number; vertical: boolean }) {
  const lx = 2 + at * 12;
  const bar = (y: number, w: number) => <rect x={lx - at * w} y={y} width={w} height={3} />;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1}
         style={vertical ? { transform: "rotate(90deg) scaleY(-1)" } : undefined} aria-hidden>
      <line x1={lx} y1={1} x2={lx} y2={15} />
      {bar(3.5, 10)}
      {bar(9.5, 6)}
    </svg>
  );
}

function DistributeIcon({ vertical }: { vertical: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1}
         style={vertical ? { transform: "rotate(90deg)" } : undefined} aria-hidden>
      <rect x={1.5} y={4.5} width={3} height={7} />
      <rect x={6.5} y={2.5} width={3} height={11} />
      <rect x={11.5} y={5.5} width={3} height={5} />
    </svg>
  );
}

function distributeTitle(label: string, unitCount: number, enabled: boolean): string {
  if (enabled) return label;
  return unitCount < 3 ? `${label}: select three or more pieces` : `${label}: one selected piece spans the others`;
}

const AT: Record<AlignMode, number> = { left: 0, hcenter: 0.5, right: 1, top: 0, vmiddle: 0.5, bottom: 1 };

export function AlignRow({ unitCount, distributable, onAlign, onDistribute }: Props) {
  // One unit aligns to the artboard, so align needs one. Distribute keeps the outer two in place
  // and needs a third to move; the tooltip says which of the two reasons disabled it.
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {ALIGNS.map(({ mode, label }) => (
        <button key={mode} aria-label={label} title={label} disabled={unitCount === 0} style={btn}
                onClick={() => onAlign(mode)}>
          <AlignIcon at={AT[mode]} vertical={mode === "top" || mode === "vmiddle" || mode === "bottom"} />
        </button>
      ))}
      {DISTRIBUTES.map(({ axis, label }) => (
        <button key={axis} aria-label={label} disabled={!distributable[axis]} style={btn}
                title={distributeTitle(label, unitCount, distributable[axis])}
                onClick={() => onDistribute(axis)}>
          <DistributeIcon vertical={axis === "y"} />
        </button>
      ))}
    </div>
  );
}
