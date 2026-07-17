import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

// Human-readable names, used for the glyph's accessible label / tooltip.
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini",
  antigravity: "Antigravity CLI",
};

// A distinct tint per agent so the neutral Bot glyphs stay tellable apart at a
// glance — no vendor logo artwork, just a color plus the label beside it. Chosen
// to read on both light and dark grounds; an unknown agent falls back to muted.
const AGENT_COLORS: Record<string, string> = {
  claude: "text-amber-500",
  codex: "text-teal-500",
  gemini: "text-blue-500",
  antigravity: "text-violet-500",
};

interface AgentLogoProps {
  agent: string;
  className?: string;
}

/**
 * The icon identifying which CLI a session belongs to. Renders a neutral Bot
 * glyph for every agent — Kine Agent does not ship the vendors' own logo artwork
 * (that would be redistributing their trademarks). The agent's name still rides
 * alongside as the accessible label / tooltip, and in the UI the label text sits
 * next to this glyph almost everywhere, so agents stay identifiable.
 */
export function AgentLogo({ agent, className }: AgentLogoProps) {
  const label = AGENT_LABELS[agent] ?? agent;
  return (
    <Bot
      aria-label={label}
      className={cn(
        "shrink-0",
        AGENT_COLORS[agent] ?? "text-muted-foreground",
        className,
      )}
    />
  );
}
