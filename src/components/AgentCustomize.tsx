// Per-agent customization area inside Settings → Agents: icon color now;
// model curation (Task 4) and provider browsing (Task 6) extend this file.
// Collapsed by default — Settings stays quiet until the user opts into it.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AGENT_COLOR_CLASSES,
  AGENT_COLOR_TOKENS,
  composeModels,
  getAgentConfig,
  updateAgentConfig,
  useAgentConfigs,
  writeAgentConfigs,
  type AgentConfig,
} from "@/lib/agentConfig";
import { listModels, type ModelInfo } from "@/lib/models";

interface AgentCustomizeProps {
  agentId: string;
}

// Radiogroup traversal order: "Default" (null) first, then the color tokens.
const SWATCH_VALUES: (string | null)[] = [null, ...AGENT_COLOR_TOKENS];

export function AgentCustomize({ agentId }: AgentCustomizeProps) {
  const [open, setOpen] = useState(false);
  const configs = useAgentConfigs();
  const config = getAgentConfig(configs, agentId);
  // Discovered models load lazily on first expand (Task 4 renders them).
  const [discovered, setDiscovered] = useState<ModelInfo[] | null>(null);

  // A discovered list is only valid for the agent it was fetched for — reset
  // it when agentId changes so a stale list can't leak into another agent's
  // curation UI (the fetch effect below re-fires once discovered is null).
  useEffect(() => {
    setDiscovered(null);
  }, [agentId]);

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

  const swatchRefs = useRef<Map<string | null, HTMLButtonElement>>(new Map());

  function setColor(token: string | null) {
    writeAgentConfigs(updateAgentConfig(configs, agentId, { color: token }));
  }

  // Curation list: like composeModels but WITHOUT the hidden-filter, so hidden
  // rows stay visible (muted) and can be re-shown. Order still applies.
  const curationList =
    discovered === null
      ? null
      : composeModels(discovered, { ...config, hiddenModels: [] }, agentId);
  // Picker-visible list (for the Default model select).
  const visibleList =
    discovered === null ? [] : composeModels(discovered, config, agentId);

  function patch(p: Partial<AgentConfig>) {
    writeAgentConfigs(
      updateAgentConfig(configs, agentId, p, (discovered ?? []).map((m) => m.value)),
    );
  }

  function toggleHidden(value: string) {
    const hidden = config.hiddenModels.includes(value)
      ? config.hiddenModels.filter((v) => v !== value)
      : [...config.hiddenModels, value];
    patch({ hiddenModels: hidden });
  }

  function move(value: string, delta: -1 | 1) {
    if (curationList === null) return;
    const order = curationList.map((m) => m.value);
    const from = order.indexOf(value);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    patch({ modelOrder: order });
  }

  function addCustom(value: string, label: string) {
    const trimmed = value.trim();
    if (!trimmed || config.customModels.some((m) => m.value === trimmed)) return;
    patch({
      customModels: [
        ...config.customModels,
        { value: trimmed, label: label.trim() === "" ? null : label.trim() },
      ],
    });
  }

  function removeCustom(value: string) {
    patch({ customModels: config.customModels.filter((m) => m.value !== value) });
  }

  // WAI-ARIA radiogroup keyboard contract: arrow keys move the roving tab
  // stop AND select the target (selection follows focus), wrapping at the ends.
  function handleSwatchKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const backward = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !backward) return;
    e.preventDefault();
    const currentIndex = Math.max(0, SWATCH_VALUES.indexOf(config.color));
    const delta = forward ? 1 : -1;
    const nextIndex = (currentIndex + delta + SWATCH_VALUES.length) % SWATCH_VALUES.length;
    const next = SWATCH_VALUES[nextIndex];
    setColor(next);
    swatchRefs.current.get(next)?.focus();
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
            <div
              role="radiogroup"
              aria-label="Icon color"
              className="mt-2 flex items-center gap-2"
              onKeyDown={handleSwatchKeyDown}
            >
              <button
                ref={(el) => {
                  if (el) swatchRefs.current.set(null, el);
                  else swatchRefs.current.delete(null);
                }}
                type="button"
                role="radio"
                aria-checked={config.color === null}
                aria-label="Default"
                tabIndex={config.color === null ? 0 : -1}
                onClick={() => setColor(null)}
                className={cn(
                  "size-5 rounded-full bg-muted-foreground/40",
                  config.color === null && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
              />
              {AGENT_COLOR_TOKENS.map((token) => (
                <button
                  key={token}
                  ref={(el) => {
                    if (el) swatchRefs.current.set(token, el);
                    else swatchRefs.current.delete(token);
                  }}
                  type="button"
                  role="radio"
                  aria-checked={config.color === token}
                  aria-label={token}
                  tabIndex={config.color === token ? 0 : -1}
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
          <div>
            <p className="text-xs font-medium">Default model</p>
            <Select
              aria-label="Default model"
              value={config.defaultModel ?? "auto"}
              onChange={(e) =>
                patch({ defaultModel: e.target.value === "auto" ? null : e.target.value })
              }
              options={[
                { value: "auto", label: "Auto" },
                ...visibleList.map((m) => ({ value: m.value, label: m.label })),
              ]}
              className="mt-2 h-8 w-64 text-xs"
            />
          </div>

          <div>
            <p className="text-xs font-medium">Models</p>
            {curationList === null ? (
              <p className="mt-2 text-xs text-muted-foreground">Loading models…</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {curationList.map((m, i) => {
                  const hidden = config.hiddenModels.includes(m.value);
                  const isCustom =
                    config.customModels.some((c) => c.value === m.value) &&
                    !discovered?.some((d) => d.value === m.value);
                  return (
                    <li key={m.value} className="flex items-center gap-1.5 text-sm">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          hidden && "text-muted-foreground",
                        )}
                      >
                        {m.label}
                      </span>
                      {isCustom && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                          custom
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`${hidden ? "Show" : "Hide"} ${m.label}`}
                        onClick={() => toggleHidden(m.value)}
                      >
                        {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={i === 0}
                        aria-label={`Move ${m.label} up`}
                        onClick={() => move(m.value, -1)}
                      >
                        <ChevronUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={i === curationList.length - 1}
                        aria-label={`Move ${m.label} down`}
                        onClick={() => move(m.value, 1)}
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                      {isCustom && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={`Remove ${m.value}`}
                          onClick={() => removeCustom(m.value)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <AddModelForm onAdd={addCustom} />
          </div>
          {/* Provider browse renders here (Task 6). */}
        </div>
      )}
    </div>
  );
}

function AddModelForm({ onAdd }: { onAdd: (value: string, label: string) => void }) {
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(value, label);
        setValue("");
        setLabel("");
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="model id (e.g. claude-opus-4-8)"
        className="h-8 w-56 text-xs"
      />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="label (optional)"
        className="h-8 w-36 text-xs"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="h-8 gap-1 text-xs"
        disabled={value.trim() === ""}
      >
        <Plus className="size-3.5" />
        Add model
      </Button>
    </form>
  );
}
