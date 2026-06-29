import { describe, it, expect } from "vitest";
import { buildTree } from "../tree";
import type { TreeEntry } from "../conductor";

function entry(path: string, isDir: boolean, status: string | null = null): TreeEntry {
  return { path, isDir, status };
}

describe("buildTree", () => {
  it("returns an empty array for no entries", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("builds a simple flat list (no nesting)", () => {
    const entries = [entry("a.txt", false), entry("b.txt", false)];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(2);
    expect(tree[0].name).toBe("a.txt");
    expect(tree[1].name).toBe("b.txt");
    expect(tree[0].children).toHaveLength(0);
  });

  it("nests files under their directory", () => {
    const entries = [
      entry("a", true),
      entry("a/b.txt", false),
      entry("c.txt", false),
    ];
    const tree = buildTree(entries);
    // Two top-level nodes: dir "a" and file "c.txt"
    expect(tree).toHaveLength(2);
    const dirA = tree.find((n) => n.name === "a")!;
    expect(dirA.isDir).toBe(true);
    expect(dirA.children).toHaveLength(1);
    expect(dirA.children[0].name).toBe("b.txt");
    expect(dirA.children[0].isDir).toBe(false);
  });

  it("handles deeper nesting correctly", () => {
    const entries = [
      entry("src", true),
      entry("src/lib", true),
      entry("src/lib/utils.ts", false),
      entry("src/main.ts", false),
    ];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src.name).toBe("src");
    expect(src.isDir).toBe(true);

    const lib = src.children.find((n) => n.name === "lib")!;
    expect(lib.isDir).toBe(true);
    expect(lib.children).toHaveLength(1);
    expect(lib.children[0].name).toBe("utils.ts");
  });

  it("places dirs before files at each level", () => {
    const entries = [
      entry("z.txt", false),
      entry("a.txt", false),
      entry("src", true),
      entry("src/utils.ts", false),
    ];
    const tree = buildTree(entries);
    // "src" (dir) should appear before "a.txt" and "z.txt" (files)
    expect(tree[0].name).toBe("src");
    expect(tree[1].name).toBe("a.txt");
    expect(tree[2].name).toBe("z.txt");
  });

  it("sorts entries alphabetically within dirs-first / files-first groups", () => {
    const entries = [
      entry("c.txt", false),
      entry("a.txt", false),
      entry("b", true),
      entry("b/x.ts", false),
      entry("d", true),
    ];
    const tree = buildTree(entries);
    // Dirs first: "b", "d"; then files: "a.txt", "c.txt"
    expect(tree.map((n) => n.name)).toEqual(["b", "d", "a.txt", "c.txt"]);
  });

  it("carries status onto file nodes", () => {
    const entries = [
      entry("src", true, null),
      entry("src/modified.ts", false, "M"),
      entry("src/added.ts", false, "A"),
    ];
    const tree = buildTree(entries);
    const src = tree[0];
    const modified = src.children.find((n) => n.name === "modified.ts")!;
    const added = src.children.find((n) => n.name === "added.ts")!;
    expect(modified.status).toBe("M");
    expect(added.status).toBe("A");
  });

  it("carries status onto dir nodes", () => {
    const entries = [
      entry("src", true, "M"),
      entry("src/index.ts", false, null),
    ];
    const tree = buildTree(entries);
    expect(tree[0].status).toBe("M");
  });

  it("produces no duplicate nodes", () => {
    const entries = [
      entry("a", true),
      entry("a/b.txt", false),
      entry("a/c.txt", false),
    ];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(2);
    const names = tree[0].children.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length); // no dups
  });

  it("handles entries with trailing slashes on dir paths gracefully", () => {
    const entries = [
      entry("src/", true),
      entry("src/index.ts", false),
    ];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("src");
    expect(tree[0].children).toHaveLength(1);
  });
});
