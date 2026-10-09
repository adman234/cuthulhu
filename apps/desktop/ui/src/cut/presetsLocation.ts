// SPDX-License-Identifier: GPL-3.0-or-later
import type { PresetsLocation } from "../ipc";

/** The line under "Presets file", which says whose file it is as well as where: a path alone
 *  does not tell an operator whether the material they save reaches the other computers. */
export function locationSummary(loc: PresetsLocation): string {
  return loc.custom ? `${loc.path} (chosen — shared if it is on a network folder)` : `${loc.path} (this computer only)`;
}

/** Whether a refusal is the location's fault rather than the file's, so the section can point at
 *  the controls that fix it instead of at the file. */
export function isUnreachable(code: string | null): boolean {
  return code === "presets_unreachable";
}
