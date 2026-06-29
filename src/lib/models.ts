export interface AgentModel {
  id: string;           // value passed to the CLI --model flag (claude aliases: "opus"|"sonnet"|"haiku")
  label: string;        // display name
  agent: "claude" | "codex" | "gemini";
  tier?: string;        // e.g. "MAX"
  available: boolean;   // false → shown disabled ("Coming soon")
}

export const MODELS: AgentModel[] = [
  { id: "opus",   label: "Claude Opus 4.8",        agent: "claude", tier: "MAX", available: true },
  { id: "sonnet", label: "Claude Sonnet 4.6",      agent: "claude",              available: true },
  { id: "haiku",  label: "Claude Haiku 4.5",       agent: "claude",              available: true },
  { id: "gpt-5",  label: "OpenAI Codex (GPT-5)",   agent: "codex",               available: false },
  { id: "gemini", label: "Gemini",                 agent: "gemini",              available: false },
];

export const DEFAULT_MODEL = MODELS[0];

export function modelById(id: string): AgentModel | undefined {
  return MODELS.find((m) => m.id === id);
}
