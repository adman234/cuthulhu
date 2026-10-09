// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { loadOperator, operatorForRequest, saveOperator } from "./operator";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const throwing = {
  getItem: () => { throw new Error("denied"); },
  setItem: () => { throw new Error("denied"); },
  removeItem: () => { throw new Error("denied"); },
};

describe("operator", () => {
  it("remembers a name and forgets a blank one", () => {
    const store = memoryStore();
    expect(loadOperator(store)).toBe("");
    saveOperator("Ada", store);
    expect(loadOperator(store)).toBe("Ada");
    saveOperator("   ", store);
    expect(loadOperator(store)).toBe("");
  });

  it("survives storage that refuses, and storage that is not there", () => {
    expect(loadOperator(throwing)).toBe("");
    expect(() => saveOperator("Ada", throwing)).not.toThrow();
    expect(loadOperator(null)).toBe("");
  });

  it("sends a trimmed name, or nobody", () => {
    expect(operatorForRequest("  Ada ")).toBe("Ada");
    expect(operatorForRequest("  ")).toBeNull();
  });
});
