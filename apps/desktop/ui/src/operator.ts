// SPDX-License-Identifier: GPL-3.0-or-later

/** Who is cutting, remembered per computer so the next cut at a shared machine is pre-filled.
 *  Sent with each cut request (`CutRequest.operator`) for the usage log; nothing about the cut
 *  depends on it. Shared rather than the cut dialog's own, so every place that cuts asks the same
 *  question and remembers the same answer. */
const KEY = "cuthulhu.operator";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `localStorage` when the page has one it may use. Reading the property itself can throw in an
 *  opaque origin, so it is reached inside the guard rather than at module load. */
function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadOperator(store: Store | null = defaultStore()): string {
  try {
    return store?.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** A blank name is forgotten rather than stored, so clearing the field means "nobody named". */
export function saveOperator(name: string, store: Store | null = defaultStore()): void {
  try {
    if (name.trim() === "") store?.removeItem(KEY);
    else store?.setItem(KEY, name);
  } catch {
    // Storage refused (private window, quota): the name is still sent with this cut.
  }
}

/** What a cut request carries: the trimmed name, or `null` for nobody. */
export function operatorForRequest(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}
