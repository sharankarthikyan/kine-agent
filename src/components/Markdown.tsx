import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeTerminalText } from "@/lib/terminal";

/**
 * Wide tables (e.g. multi-column agent "verdict" tables) must scroll horizontally within
 * the transcript column rather than overflow and get clipped by the pane. react-markdown
 * emits a bare `<table>`, so we wrap it in a scroll container.
 */
const components: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

/**
 * Render agent prose as Markdown (Claude emits Markdown: bold, lists, code
 * blocks, tables). Safe by default — react-markdown does not render raw HTML.
 * Styling lives in the `.md` rules in index.css.
 *
 * Prose is sanitized like terminal output first: codex echoes command output —
 * raw ANSI escapes included — into its final message, which otherwise renders
 * as tofu boxes. Escape/control stripping never touches Markdown syntax.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {sanitizeTerminalText(children)}
      </ReactMarkdown>
    </div>
  );
}
