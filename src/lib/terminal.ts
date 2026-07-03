/** Rendering budget for a single terminal widget — the adapter already caps
 *  emitted bytes at 512 KiB/terminal; this bounds the DOM independently. */
export const RENDER_TAIL_CHARS = 131072;

// Escape-sequence families, matched in this order (OSC first — its payload may
// contain bytes that look like CSI): OSC (\x1b] ... BEL|ST), CSI (\x1b[ ...),
// then remaining single-char ESC forms. Security review §5: strip entirely,
// no SGR allow-list in v1, never hand raw escapes to a terminal-emulation lib.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI_SEQUENCE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\x1b[@-Z\\-_]?/g;
// Control chars except \t (0x09) and \n (0x0a); \r handled by overwrite collapse.
const CONTROL_CHARS = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Collapse `\r` overwrite semantics: within each line, keep only the text
 *  after the last carriage return (progress bars, spinners). */
function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\r").pop() ?? "")
    .join("\n");
}

export function sanitizeTerminalText(raw: string): string {
  const withoutEscapes = raw
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESCAPE, "");
  return collapseCarriageReturns(withoutEscapes).replace(CONTROL_CHARS, "");
}

export function clampTail(text: string, maxChars: number): { text: string; clamped: boolean } {
  if (text.length <= maxChars) return { text, clamped: false };
  return { text: text.slice(text.length - maxChars), clamped: true };
}
