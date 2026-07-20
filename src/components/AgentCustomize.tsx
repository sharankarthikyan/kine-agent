// Per-agent customization area inside Settings → Agents: icon color now;
// model curation (Task 4) and provider browsing (Task 6) extend this file.
// Collapsed by default — Settings stays quiet until the user opts into it.

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AGENT_COLOR_CLASSES,
  AGENT_COLOR_TOKENS,
  getAgentConfig,
  updateAgentConfig,
  useAgentConfigs,
  writeAgentConfigs,
} from "@/lib/agentConfig";
import { listModels, type ModelInfo } from "@/lib/models";

interface AgentCustomizeProps {
  agentId: string;
}

export function AgentCustomize({ agentId }: AgentCustomizeProps) {
  const [open, setOpen] = useState(false);
  const configs = useAgentConfigs();
  const config = getAgentConfig(configs, agentId);
  // Discovered models load lazily on first expand (Task 4 renders them).
  const [discovered, setDiscovered] = useState<ModelInfo[] | null>(null);

  useEffect(() => {
    if (!open || discovered !== null) return;
    let cancelled = false;
    listModels(agentId)
      .then((models) => {
        if (!cancelled) setDiscovered(models);
      })
      .catch(() => {
        if (!cancelled) setDiscovered([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, discovered, agentId]);

  function setColor(token: string | null) {
    writeAgentConfigs(updateAgentConfig(configs, agentId, { color: token }));
  }

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-xs text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")}
        />
        Customize
      </Button>
      {open && (
        <div className="mt-3 space-y-5 pl-6">
          <div>
            <p className="text-xs font-medium">Icon color</p>
            <div role="radiogroup" aria-label="Icon color" className="mt-2 flex items-center gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={config.color === null}
                aria-label="Default"
                onClick={() => setColor(null)}
                className={cn(
                  "size-5 rounded-full bg-muted-foreground/40",
                  config.color === null && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
              />
              {AGENT_COLOR_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  role="radio"
                  aria-checked={config.color === token}
                  aria-label={token}
                  onClick={() => setColor(token)}
                  className={cn(
                    "size-5 rounded-full bg-current",
                    AGENT_COLOR_CLASSES[token],
                    config.color === token &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-background",
                  )}
                />
              ))}
            </div>
          </div>
          {/* Model curation renders here (Task 4); provider browse below it (Task 6). */}
        </div>
      )}
    </div>
  );
}
