export type DiffLineKind = "add" | "del" | "hunk" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface PatchFile {
  path: string;
  lines: DiffLine[];
}

/** Parse a unified git patch into per-file groups with classified lines. */
export function parsePatch(patch: string): PatchFile[] {
  if (!patch.trim()) return [];
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git")) {
      // "diff --git a/<path> b/<path>" — take the b/ path.
      const m = raw.match(/ b\/(.+)$/);
      current = { path: m ? m[1] : raw.replace("diff --git ", ""), lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    let kind: DiffLineKind;
    if (raw.startsWith("@@")) kind = "hunk";
    else if (
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ")
    )
      kind = "meta";
    else if (raw.startsWith("+")) kind = "add";
    else if (raw.startsWith("-")) kind = "del";
    else kind = "context";
    current.lines.push({ kind, text: raw });
  }
  return files;
}
