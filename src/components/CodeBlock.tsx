import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  content: string;
  path?: string;
  language?: string;
  lineNumbers?: boolean;
  className?: string;
}

type TokenKind = "comment" | "string" | "keyword" | "number" | "literal" | "property";

const EXTENSION_LANGUAGE: Record<string, string> = {
  bash: "shell",
  cjs: "javascript",
  css: "css",
  go: "go",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "css",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  yaml: "yaml",
  zsh: "shell",
};

const KEYWORDS: Record<string, string[]> = {
  css: ["display", "position", "color", "background", "font", "margin", "padding", "border", "grid", "flex"],
  go: ["break", "case", "chan", "const", "continue", "defer", "else", "fallthrough", "for", "func", "go", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"],
  java: ["abstract", "class", "else", "extends", "final", "if", "implements", "import", "interface", "new", "package", "private", "protected", "public", "return", "static", "throws", "void"],
  javascript: ["async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "let", "new", "return", "switch", "throw", "try", "typeof", "var", "while", "yield"],
  kotlin: ["class", "data", "else", "fun", "if", "import", "interface", "is", "null", "object", "package", "return", "val", "var", "when"],
  php: ["class", "echo", "else", "extends", "function", "if", "namespace", "new", "private", "protected", "public", "return", "use"],
  python: ["and", "as", "class", "def", "elif", "else", "except", "finally", "for", "from", "if", "import", "in", "is", "lambda", "not", "or", "pass", "return", "try", "while", "with", "yield"],
  ruby: ["begin", "class", "def", "do", "else", "elsif", "end", "if", "module", "require", "rescue", "return", "unless", "while", "yield"],
  rust: ["async", "await", "const", "crate", "else", "enum", "fn", "for", "if", "impl", "let", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct", "trait", "type", "use", "where", "while"],
  shell: ["case", "cd", "do", "done", "echo", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "then", "while"],
  sql: ["alter", "and", "as", "by", "create", "delete", "drop", "from", "group", "insert", "into", "join", "limit", "not", "null", "or", "order", "select", "table", "update", "values", "where"],
  swift: ["class", "else", "enum", "extension", "func", "guard", "if", "import", "let", "nil", "protocol", "return", "self", "struct", "var"],
  typescript: ["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "enum", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "interface", "let", "new", "private", "protected", "public", "readonly", "return", "switch", "throw", "try", "type", "typeof", "var", "while", "yield"],
};

function detectLanguage(path?: string, explicit?: string): string {
  if (explicit) return explicit.toLowerCase();
  if (!path) return "text";
  const normalized = path.toLowerCase();
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (base === "dockerfile") return "dockerfile";
  const extension = base.includes(".") ? base.split(".").pop() : "";
  return extension ? (EXTENSION_LANGUAGE[extension] ?? "text") : "text";
}

function tokenClass(kind: TokenKind): string {
  switch (kind) {
    case "comment":
      return "text-muted-foreground";
    case "string":
      return "text-[color-mix(in_oklch,var(--status-success)_82%,var(--foreground))]";
    case "keyword":
      return "text-[color-mix(in_oklch,var(--status-running)_86%,var(--foreground))]";
    case "number":
      return "text-[color-mix(in_oklch,var(--status-waiting)_82%,var(--foreground))]";
    case "literal":
      return "text-[color-mix(in_oklch,var(--status-error)_76%,var(--foreground))]";
    case "property":
      return "text-[color-mix(in_oklch,var(--primary)_72%,var(--foreground))]";
  }
}

function keywordPattern(language: string): string {
  const words = KEYWORDS[language] ?? [];
  return words.length === 0 ? "" : words.join("|");
}

function classifyToken(token: string, language: string): TokenKind {
  if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*") || token.startsWith("<!--")) {
    return "comment";
  }
  if (language === "json" && /^"(?:\\.|[^"\\])*"\s*:/.test(token)) return "property";
  if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return "string";
  if (/^\d/.test(token)) return "number";
  if (/^(true|false|null|undefined|none|nil)$/i.test(token)) return "literal";
  return "keyword";
}

function markdownParts(line: string): ReactNode[] {
  if (/^\s{0,3}#{1,6}\s/.test(line)) {
    return [<span key="heading" className={tokenClass("keyword")}>{line}</span>];
  }
  if (/^\s{0,3}>\s?/.test(line)) {
    return [<span key="quote" className={tokenClass("comment")}>{line}</span>];
  }
  return genericParts(line, "text");
}

function genericParts(line: string, language: string): ReactNode[] {
  const keywords = keywordPattern(language);
  const comment =
    language === "html"
      ? "<!--.*?-->"
      : language === "shell" || language === "python" || language === "ruby" || language === "yaml" || language === "toml"
        ? "#.*"
        : "\\/\\/.*|\\/\\*.*?\\*\\/";
  const key = language === "json" ? '"(?:\\\\.|[^"\\\\])*"\\s*:' : "";
  const keyword = keywords ? `\\b(?:${keywords})\\b` : "";
  const pieces = [
    comment,
    key,
    '"(?:\\\\.|[^"\\\\])*"',
    "'(?:\\\\.|[^'\\\\])*'",
    "`(?:\\\\.|[^`\\\\])*`",
    "\\b\\d+(?:\\.\\d+)?\\b",
    "\\b(?:true|false|null|undefined|None|nil)\\b",
    keyword,
  ].filter(Boolean);
  if (pieces.length === 0) return [line || " "];

  const matcher = new RegExp(pieces.join("|"), "gi");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(line.slice(cursor, index));
    const token = match[0];
    const kind = classifyToken(token, language);
    nodes.push(
      <span key={`${index}-${token}`} className={tokenClass(kind)}>
        {token}
      </span>,
    );
    cursor = index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes.length > 0 ? nodes : [" "];
}

function lineParts(line: string, language: string): ReactNode[] {
  if (language === "markdown") return markdownParts(line);
  return genericParts(line, language);
}

export function CodeBlock({
  content,
  path,
  language,
  lineNumbers = true,
  className,
}: CodeBlockProps) {
  const resolvedLanguage = detectLanguage(path, language);
  const lines = content.split("\n");

  return (
    <pre
      className={cn(
        "m-0 grid gap-x-3 overflow-x-auto font-mono text-xs leading-5 text-foreground",
        lineNumbers ? "grid-cols-[auto_1fr]" : "grid-cols-1",
        className,
      )}
      data-language={resolvedLanguage}
    >
      {lines.map((line, index) => (
        <Fragment key={index}>
          {lineNumbers && (
            <span className="select-none text-right tabular-nums text-muted-foreground/60">
              {index + 1}
            </span>
          )}
          <code className="min-w-0 whitespace-pre-wrap break-words">
            {lineParts(line, resolvedLanguage)}
          </code>
        </Fragment>
      ))}
    </pre>
  );
}
