import { describe, it, expect } from "vitest";
import { parsePatch } from "../parsePatch";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ context",
  " unchanged",
  "-removed line",
  "+added line",
  "+another added",
].join("\n");

describe("parsePatch", () => {
  it("groups lines into files with classified line kinds", () => {
    const files = parsePatch(PATCH);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    const kinds = files[0].lines.map((l) => l.kind);
    expect(kinds).toContain("hunk");
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
    expect(kinds).toContain("context");
  });

  it("returns empty array for empty patch", () => {
    expect(parsePatch("")).toEqual([]);
  });
});
