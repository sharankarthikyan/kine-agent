import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Render agent prose as Markdown (Claude emits Markdown: bold, lists, code
 * blocks, tables). Safe by default — react-markdown does not render raw HTML.
 * Styling lives in the `.md` rules in tokens.css.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
