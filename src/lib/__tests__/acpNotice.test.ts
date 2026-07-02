import { describe, expect, it } from "vitest";
import { shouldShowAcpDownloadNotice } from "../acpNotice";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("shouldShowAcpDownloadNotice", () => {
  it("is true exactly once per storage", () => {
    const storage = memoryStorage();
    expect(shouldShowAcpDownloadNotice(storage)).toBe(true);
    expect(shouldShowAcpDownloadNotice(storage)).toBe(false);
  });
});
