// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type CSSProperties } from "react";
import * as ipc from "../ipc";
import { locationSummary } from "./presetsLocation";

const btn: CSSProperties = {
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  cursor: "pointer",
};

type Props = {
  /** Runs the change only once an unsaved preset edit has been decided: a new file is a new list,
   *  and the draft would be dropped with the old one. */
  guard: (run: () => void) => void;
  /** The location moved, so every preset list held is now the wrong file's. */
  onChanged: () => void;
  disabled: boolean;
};

/** "Presets file: <path> [Change…] [Use default]". Shown even when the presets cannot be read,
 *  because an unmounted share is exactly when the operator needs the way back. */
export function PresetsLocationRow({ guard, onChanged, disabled }: Props) {
  const [loc, setLoc] = useState<ipc.PresetsLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    ipc.getPresetsLocation().then(
      (l) => { if (!ignore) setLoc(l); },
      (e) => { if (!ignore) setError(ipc.ipcErrorMessage(e)); },
    );
    return () => { ignore = true; };
  }, []);

  const move = (pick: () => Promise<string | null | undefined>) => {
    setBusy(true);
    setError(null);
    pick()
      .then((path) => (path === undefined ? null : ipc.setPresetsLocation(path)))
      .then((next) => {
        if (next === null) return;
        setLoc(next);
        onChanged();
      })
      .catch((e) => setError(ipc.ipcErrorMessage(e)))
      .finally(() => setBusy(false));
  };

  // A cancelled picker is `undefined` here, which leaves the location alone; `null` is the
  // default, which is a choice.
  const change = () => guard(() => move(() => ipc.pickPresetsFolder().then((p) => p ?? undefined)));
  const useDefault = () => guard(() => move(() => Promise.resolve(null)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>Presets file:</span>
        <span data-testid="presets-location" style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>
          {loc === null ? "…" : locationSummary(loc)}
        </span>
        <div style={{ flex: 1 }} />
        <button aria-label="Change presets file" style={btn} disabled={busy || disabled} onClick={change}>
          Change…
        </button>
        {loc?.custom ? (
          <button aria-label="Use default presets file" style={btn} disabled={busy || disabled} onClick={useDefault}>
            Use default
          </button>
        ) : null}
      </div>
      {error !== null ? (
        <div role="alert" data-testid="presets-location-error" style={{ color: "var(--cut)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
