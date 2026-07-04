import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

// Human-readable names, used for the glyph's accessible label / tooltip.
const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini",
  antigravity: "Antigravity CLI",
};

interface AgentLogoProps {
  agent: string;
  className?: string;
}

/**
 * The icon identifying which CLI a session belongs to. Renders a neutral Bot
 * glyph for every agent — Kineloop does not ship the vendors' own logo artwork
 * (that would be redistributing their trademarks). The agent's name still rides
 * alongside as the accessible label / tooltip, and in the UI the label text sits
 * next to this glyph almost everywhere, so agents stay identifiable.
 */
export function AgentLogo({ agent, className }: AgentLogoProps) {
  const label = AGENT_LABELS[agent] ?? agent;
  return (
    <Bot
      aria-label={label}
      className={cn("shrink-0 text-muted-foreground", className)}
    />
  );
}
