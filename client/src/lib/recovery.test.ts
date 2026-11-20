import { afterEach, describe, expect, it } from "vitest";

import { clearDeviceRecovered, markDeviceRecovered, recoveredAtFor } from "./recovery.ts";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function installStorage(): void {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
}

function removeStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

describe("device recovery marker", () => {
  afterEach(() => {
    removeStorage();
  });

  it("stores and clears the recovered timestamp per device", () => {
    installStorage();
    const at = new Date("2026-01-02T03:04:05.000Z");

    expect(recoveredAtFor("device-a")).toBeNull();
    markDeviceRecovered("device-a", at);

    expect(recoveredAtFor("device-a")).toBe(at.toISOString());
    // 다른 기기에는 영향이 없다.
    expect(recoveredAtFor("device-b")).toBeNull();

    clearDeviceRecovered("device-a");
    expect(recoveredAtFor("device-a")).toBeNull();
  });

  it("is a no-op without localStorage", () => {
    removeStorage();
    expect(recoveredAtFor("device-a")).toBeNull();
    expect(() => markDeviceRecovered("device-a")).not.toThrow();
    expect(() => clearDeviceRecovered("device-a")).not.toThrow();
  });
});
