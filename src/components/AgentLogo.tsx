import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import claudeLogo from "@/assets/agents/claude.png";
import codexLogo from "@/assets/agents/codex.png";
import geminiLogo from "@/assets/agents/gemini.png";
import antigravityLogo from "@/assets/agents/antigravity.png";

/**
 * Per-agent logos. An unknown agent falls back to the generic Bot glyph.
 */
const AGENT_LOGOS: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  gemini: geminiLogo,
  antigravity: antigravityLogo,
};

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
 * The icon identifying which CLI a session belongs to. Renders the agent's
 * logo when one exists, otherwise a neutral Bot glyph so unknown or
 * not-yet-configured agents still get a stable visual slot.
 */
export function AgentLogo({ agent, className }: AgentLogoProps) {
  const src = AGENT_LOGOS[agent];
  const label = AGENT_LABELS[agent] ?? agent;

  if (!src) {
    return (
      <Bot
        aria-label={label}
        className={cn("shrink-0 text-muted-foreground", className)}
      />
    );
  }

  return (
    <img
      src={src}
      alt={label}
      title={label}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
